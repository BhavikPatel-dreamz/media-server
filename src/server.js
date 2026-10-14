import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from './config.js'
import { HttpError } from './errors.js'
import { assertSafeKey } from './paths.js'
import { createStore, safeEqual } from './store.js'

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')

function sendJson(response, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  })
  response.end(payload)
}

function sendError(response, status, message) {
  if (response.headersSent) {
    response.destroy()
    return
  }
  sendJson(response, status, { error: message })
}

function applyCors(response, config) {
  response.setHeader('Access-Control-Allow-Origin', config.corsOrigin)
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range, If-None-Match')
  response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS')
  response.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range, ETag')
}

function bearerToken(request) {
  const header = request.headers.authorization || ''
  if (header.startsWith('Bearer ')) return header.slice(7)
  return request.headers['x-api-key'] || ''
}

function requireAuth(request, config) {
  if (!safeEqual(bearerToken(request), config.apiKey)) {
    throw new HttpError(401, 'Unauthorized')
  }
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 64 * 1024) throw new HttpError(413, 'JSON body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
}

function queryValue(url, name) {
  return url.searchParams.get(name) ?? ''
}

function decodeTail(pathname, base) {
  if (!pathname.startsWith(base)) return null
  const rest = pathname.slice(base.length)
  if (!rest) throw new HttpError(400, 'Invalid storage key')
  try {
    return rest.split('/').map((segment) => decodeURIComponent(segment)).join('/')
  } catch {
    throw new HttpError(400, 'Invalid storage key')
  }
}

function parseRange(header, size) {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return { invalid: true }
  const startText = match[1]
  const endText = match[2]
  if (startText === '' && endText === '') return { invalid: true }

  let start
  let end
  if (startText === '') {
    const suffix = Number(endText)
    if (!suffix) return { invalid: true }
    start = Math.max(size - suffix, 0)
    end = size - 1
  } else {
    start = Number(startText)
    end = endText === '' ? size - 1 : Number(endText)
    if (end >= size) end = size - 1
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || start > end) {
    return { invalid: true }
  }
  return { start, end }
}

function etagFor(info) {
  return `"${info.size}-${Math.floor(info.mtimeMs)}"`
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '')
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

async function sendFile(request, response, filePath, { filename, mimeType }) {
  let info
  try {
    info = await stat(filePath)
  } catch (error) {
    if (error.code === 'ENOENT') throw new HttpError(404, 'File not found')
    throw error
  }

  const etag = etagFor(info)
  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=60, must-revalidate',
    'Content-Disposition': contentDisposition(filename),
    'Content-Type': mimeType,
    ETag: etag,
    'Last-Modified': info.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
  }

  if (mimeType === 'image/svg+xml' || mimeType.endsWith('+xml') || mimeType === 'text/xml' || mimeType === 'application/xml') {
    headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
  }

  const matches = request.headers['if-none-match']
  if (matches === '*' || matches === etag) {
    response.writeHead(304, headers)
    response.end()
    return
  }

  const range = parseRange(request.headers.range, info.size)
  if (range?.invalid) {
    response.writeHead(416, { 'Content-Range': `bytes */${info.size}` })
    response.end()
    return
  }

  const start = range ? range.start : 0
  const end = range ? range.end : Math.max(info.size - 1, 0)
  const status = range ? 206 : 200
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`
  headers['Content-Length'] = info.size === 0 ? 0 : end - start + 1

  response.writeHead(status, headers)
  if (request.method === 'HEAD' || info.size === 0) {
    response.end()
    return
  }

  const stream = createReadStream(filePath, range ? { start, end } : undefined)
  stream.on('error', () => response.destroy())
  response.on('close', () => stream.destroy())
  stream.pipe(response)
}

async function handleRequest(request, response, { config, store }) {
  applyCors(response, config)
  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }

  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  const { pathname } = url

  if (request.method === 'GET' && pathname === '/health') {
    sendJson(response, 200, { ok: true, publicRead: config.publicRead })
    return
  }

  if (request.method === 'GET' && pathname === '/') {
    const html = await readFile(path.join(publicDir, 'index.html'))
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length })
    response.end(html)
    return
  }

  const fileKey = pathname.startsWith('/files/') ? decodeTail(pathname, '/files/') : null
  if (fileKey && (request.method === 'GET' || request.method === 'HEAD')) {
    if (!config.publicRead) requireAuth(request, config)
    const safe = assertSafeKey(fileKey)
    const record = store.getByKey(safe)
    if (!record) throw new HttpError(404, 'File not found')
    await sendFile(request, response, store.filePath(safe), {
      filename: record.filename,
      mimeType: record.mimeType,
    })
    return
  }

  const objectKey = pathname.startsWith('/api/objects/') ? decodeTail(pathname, '/api/objects/') : null
  if (objectKey) {
    requireAuth(request, config)
    if (request.method === 'PUT') {
      const { record, created } = await store.putObject({
        request,
        key: objectKey,
        mimeType: request.headers['content-type'],
      })
      sendJson(response, created ? 201 : 200, record)
      return
    }
    if (request.method === 'GET') {
      const record = store.getByKey(objectKey)
      if (!record) throw new HttpError(404, 'File not found')
      sendJson(response, 200, record)
      return
    }
    if (request.method === 'DELETE') {
      await store.removeByKey(objectKey)
      response.writeHead(204)
      response.end()
      return
    }
    throw new HttpError(405, 'Method not allowed')
  }

  if (pathname === '/api/files') {
    requireAuth(request, config)
    if (request.method === 'GET') {
      sendJson(response, 200, store.list({
        prefix: queryValue(url, 'prefix'),
        q: queryValue(url, 'q'),
        limit: queryValue(url, 'limit'),
        offset: queryValue(url, 'offset'),
      }))
      return
    }
    if (request.method === 'POST') {
      const filename = queryValue(url, 'filename')
      if (!filename) throw new HttpError(400, 'filename is required')
      const record = await store.create({
        request,
        filename,
        prefix: queryValue(url, 'prefix'),
        alt: queryValue(url, 'alt'),
        title: queryValue(url, 'title'),
        mimeType: request.headers['content-type'],
      })
      sendJson(response, 201, record)
      return
    }
    throw new HttpError(405, 'Method not allowed')
  }

  const fileMatch = pathname.match(/^\/api\/files\/([0-9a-f-]{36})$/)
  if (fileMatch) {
    requireAuth(request, config)
    const id = fileMatch[1]
    if (request.method === 'GET') {
      const record = store.get(id)
      if (!record) throw new HttpError(404, 'File not found')
      sendJson(response, 200, record)
      return
    }
    if (request.method === 'PATCH') {
      const body = await readJson(request)
      const patch = {}
      for (const field of ['alt', 'title', 'filename', 'prefix']) {
        if (Object.hasOwn(body, field)) {
          if (typeof body[field] !== 'string') throw new HttpError(400, `${field} must be a string`)
          patch[field] = body[field]
        }
      }
      sendJson(response, 200, await store.update(id, patch))
      return
    }
    if (request.method === 'PUT') {
      const record = await store.replaceContent(id, {
        request,
        mimeType: request.headers['content-type'],
        filename: queryValue(url, 'filename'),
      })
      sendJson(response, 200, record)
      return
    }
    if (request.method === 'DELETE') {
      await store.remove(id)
      response.writeHead(204)
      response.end()
      return
    }
    throw new HttpError(405, 'Method not allowed')
  }

  throw new HttpError(404, 'Not found')
}

export function createServerApp(env = process.env) {
  const config = loadConfig(env)
  const store = createStore(config)
  const server = createServer((request, response) => {
    handleRequest(request, response, { config, store }).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500
      if (status === 500) console.error(error)
      sendError(response, status, status === 500 ? 'Internal server error' : error.message)
    })
  })

  return {
    config,
    server,
    store,
    port: config.port,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.port, config.host, () => {
          server.off('error', reject)
          const address = server.address()
          this.port = typeof address === 'object' && address ? address.port : config.port
          if (config.publicUrl === 'auto') {
            config.publicUrl = `http://127.0.0.1:${this.port}`
          }
          resolve(this.port)
        })
      })
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          store.close()
          if (error) reject(error)
          else resolve()
        })
      })
    },
  }
}
