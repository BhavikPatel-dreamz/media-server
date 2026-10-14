import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'

import { cloudStoragePlugin } from '@payloadcms/plugin-cloud-storage'
import type {
  Adapter,
  CollectionOptions,
  PluginOptions as CloudStoragePluginOptions,
} from '@payloadcms/plugin-cloud-storage/types'
import { buildStoragePathData, getStorageFilePath } from '@payloadcms/plugin-cloud-storage/utilities'
import type { Config, Plugin, UploadCollectionSlug } from 'payload'

export type MediaServerStorageOptions = {
  /** Media server origin, for example http://localhost:4100 or http://media:4100. */
  baseURL: string
  /** Must match the media server API_KEY. */
  apiKey: string
  collections: Partial<Record<UploadCollectionSlug, Omit<CollectionOptions, 'adapter'> | true>>
  enabled?: boolean
  /**
   * Keep plugin fields in the schema even when the plugin is disabled.
   * Payload will enable this by default in v4.
   */
  alwaysInsertFields?: boolean
  /**
   * When true, the collection prefix and the document prefix are always joined.
   * When false, a document prefix that already sits inside the collection prefix is kept as-is.
   *
   * Collection prefix `uploads` and document prefix `uploads/user-123`:
   * - false -> uploads/user-123/image.jpg
   * - true  -> uploads/uploads/user-123/image.jpg
   */
  useCompositePrefixes?: boolean
}

type AdapterArgs = {
  apiKey: string
  baseURL: string
  useCompositePrefixes?: boolean
}

function trimBase(url: string) {
  return url.replace(/\/+$/, '')
}

export function encodeStorageKey(key: string) {
  return key
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function objectUrl(baseURL: string, key: string) {
  return `${trimBase(baseURL)}/api/objects/${encodeStorageKey(key)}`
}

function fileUrl(baseURL: string, key: string) {
  return `${trimBase(baseURL)}/files/${encodeStorageKey(key)}`
}

async function failure(response: Response, action: string) {
  const detail = (await response.text().catch(() => '')).slice(0, 500)
  throw new Error(`Media server ${action} failed (${response.status})${detail ? `: ${detail}` : ''}`)
}

export function createMediaServerAdapter({
  apiKey,
  baseURL,
  useCompositePrefixes = false,
}: AdapterArgs): Adapter {
  return ({ collection, prefix = '' }) => ({
    name: 'media-server',

    generateURL: ({ filename, prefix: docPrefix = '' }) => {
      const { storageFilePath } = buildStoragePathData({
        collectionPrefix: prefix,
        docPrefix,
        filename,
        useCompositePrefixes,
      })
      return fileUrl(baseURL, storageFilePath)
    },

    handleUpload: async ({ file, storageFilePath }) => {
      const key =
        storageFilePath ||
        buildStoragePathData({
          collectionPrefix: prefix,
          filename: file.filename,
          useCompositePrefixes,
        }).storageFilePath

      const init: RequestInit & { duplex?: 'half' } = {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': file.mimeType || 'application/octet-stream',
        },
      }

      if (file.tempFilePath) {
        init.body = Readable.toWeb(createReadStream(file.tempFilePath)) as unknown as BodyInit
        init.duplex = 'half'
      } else {
        init.body = new Uint8Array(file.buffer)
      }

      const response = await fetch(objectUrl(baseURL, key), init)
      if (!response.ok) await failure(response, 'upload')
    },

    handleDelete: async ({ doc, filename, storageFilePath }) => {
      const key =
        storageFilePath ||
        buildStoragePathData({
          collectionPrefix: prefix,
          docPrefix: doc?.prefix || '',
          filename,
          useCompositePrefixes,
        }).storageFilePath

      const response = await fetch(objectUrl(baseURL, key), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (!response.ok && response.status !== 404) await failure(response, 'delete')
    },

    staticHandler: async (req, { doc, headers, params }) => {
      const storageFilePath = await getStorageFilePath({
        clientUploadContext: params.clientUploadContext,
        collection,
        collectionPrefix: prefix,
        doc,
        filename: params.filename,
        prefixQueryParam: params.prefix,
        req,
        useCompositePrefixes,
      })

      const upstreamHeaders = new Headers()
      upstreamHeaders.set('Authorization', `Bearer ${apiKey}`)
      const range = req.headers?.get?.('range')
      if (range) upstreamHeaders.set('range', range)
      const inm = req.headers?.get?.('if-none-match')
      if (inm) upstreamHeaders.set('if-none-match', inm)

      const response = await fetch(fileUrl(baseURL, storageFilePath), {
        headers: upstreamHeaders,
        signal: 'signal' in req ? (req.signal as AbortSignal | undefined) : undefined,
      })

      const out = new Headers(headers)
      for (const name of [
        'accept-ranges',
        'cache-control',
        'content-disposition',
        'content-length',
        'content-range',
        'content-security-policy',
        'content-type',
        'etag',
        'last-modified',
      ]) {
        const value = response.headers.get(name)
        if (value) out.set(name, value)
      }

      const upload = collection.upload
      if (upload && typeof upload === 'object' && typeof upload.modifyResponseHeaders === 'function') {
        const modified = upload.modifyResponseHeaders({ headers: out })
        if (modified) {
          out.forEach((_, name) => {
            if (!modified.has(name)) out.delete(name)
          })
          modified.forEach((value, name) => out.set(name, value))
        }
      }

      const body = response.status === 204 || response.status === 304 ? null : response.body
      return new Response(body, { status: response.status, headers: out })
    },

    onInit: async () => {
      try {
        const response = await fetch(`${trimBase(baseURL)}/health`)
        if (!response.ok) {
          console.warn(`[media-server] health check returned ${response.status} for ${baseURL}`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error'
        console.warn(`[media-server] cannot reach ${baseURL}: ${message}`)
      }
    },
  })
}

export const mediaServerStorage =
  (options: MediaServerStorageOptions): Plugin =>
  (incomingConfig: Config): Config => {
    const adapter = createMediaServerAdapter({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      useCompositePrefixes: options.useCompositePrefixes,
    })

    const collectionsWithAdapter = Object.fromEntries(
      Object.entries(options.collections).map(([slug, collectionOptions]) => [
        slug,
        {
          ...(collectionOptions === true ? {} : collectionOptions),
          adapter: options.enabled === false ? null : adapter,
        },
      ]),
    ) as CloudStoragePluginOptions['collections']

    if (options.enabled === false && !options.alwaysInsertFields) return incomingConfig

    const config =
      options.enabled === false
        ? incomingConfig
        : {
            ...incomingConfig,
            collections: (incomingConfig.collections || []).map((collection) => {
              const collectionOptions = collectionsWithAdapter[collection.slug as UploadCollectionSlug]
              if (!collectionOptions) return collection
              return {
                ...collection,
                upload: {
                  ...(typeof collection.upload === 'object' ? collection.upload : {}),
                  disableLocalStorage: collectionOptions.disableLocalStorage !== false,
                },
              }
            }),
          }

    return cloudStoragePlugin({
      alwaysInsertFields: options.alwaysInsertFields,
      collections: collectionsWithAdapter,
      enabled: options.enabled !== false,
      useCompositePrefixes: options.useCompositePrefixes,
    })(config)
  }
