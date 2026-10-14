import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createWriteStream, mkdirSync } from 'node:fs'
import { mkdir, rename, rm, rmdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { HttpError } from './errors.js'
import { assertSafeKey, diskPath, encodeKey, joinKey, normalizeMime, splitKey } from './paths.js'

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

class ByteLimit extends Transform {
  constructor(maxBytes) {
    super()
    this.maxBytes = maxBytes
    this.seen = 0
  }

  _transform(chunk, _encoding, callback) {
    this.seen += chunk.length
    if (this.seen > this.maxBytes) {
      callback(new HttpError(413, 'File exceeds the upload size limit'))
      return
    }
    callback(null, chunk)
  }
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  if (a.length !== b.length) {
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

export function createStore(config) {
  mkdirSync(path.join(config.dataDir, 'files'), { recursive: true })
  mkdirSync(path.join(config.dataDir, 'tmp'), { recursive: true })

  const db = new DatabaseSync(path.join(config.dataDir, 'media.db'))
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      prefix TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      alt TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS files_prefix ON files(prefix);
    CREATE INDEX IF NOT EXISTS files_created ON files(created_at);
  `)

  let queue = Promise.resolve()

  function withLock(_key, fn) {
    const run = queue.then(fn, fn)
    queue = run.then(
      () => {},
      () => {},
    )
    return run
  }

  function mapRow(row) {
    const base = config.publicUrl.replace(/\/+$/, '')
    return {
      id: row.id,
      key: row.key,
      filename: row.filename,
      prefix: row.prefix,
      mimeType: row.mime_type,
      filesize: Number(row.size),
      alt: row.alt,
      title: row.title,
      url: `${base}/files/${encodeKey(row.key)}`,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  function getRowById(id) {
    return db.prepare('SELECT * FROM files WHERE id = ?').get(id)
  }

  function getRowByKey(key) {
    return db.prepare('SELECT * FROM files WHERE key = ?').get(key)
  }

  async function writeTemp(request) {
    const declared = Number(request.headers['content-length'] || 0)
    if (Number.isFinite(declared) && declared > config.maxUploadBytes) {
      throw new HttpError(413, 'File exceeds the upload size limit')
    }

    const tmp = path.join(config.dataDir, 'tmp', randomUUID())
    try {
      await pipeline(request, new ByteLimit(config.maxUploadBytes), createWriteStream(tmp))
      const info = await stat(tmp)
      return { tmp, size: info.size }
    } catch (error) {
      await rm(tmp, { force: true })
      if (error && error.code === 'ERR_STREAM_PREMATURE_CLOSE') {
        throw new HttpError(400, 'Upload interrupted')
      }
      throw error
    }
  }

  async function commitTemp(tmp, key) {
    const destination = diskPath(config.dataDir, key)
    await mkdir(path.dirname(destination), { recursive: true })
    await rename(tmp, destination)
  }

  async function pruneEmpty(start) {
    const root = path.resolve(config.dataDir, 'files')
    let current = path.resolve(start)
    while (current.startsWith(root) && current !== root) {
      try {
        await rmdir(current)
      } catch {
        return
      }
      current = path.dirname(current)
    }
  }

  function insertRow({ key, filename, prefix, mimeType, size, alt = '', title = '' }) {
    const now = new Date().toISOString()
    const id = randomUUID()
    db.prepare(
      `INSERT INTO files (id, key, filename, prefix, mime_type, size, alt, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, key, filename, prefix, mimeType, size, alt, title, now, now)
    return id
  }

  return {
    get(id) {
      const row = getRowById(id)
      return row ? mapRow(row) : null
    },

    getByKey(key) {
      const safe = assertSafeKey(key)
      const row = getRowByKey(safe)
      return row ? mapRow(row) : null
    },

    filePath(key) {
      return diskPath(config.dataDir, key)
    },

    list({ prefix = '', q = '', limit = 50, offset = 0 } = {}) {
      const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200)
      const safeOffset = Math.max(Number(offset) || 0, 0)
      const where = []
      const params = []

      if (prefix) {
        const safePrefix = assertSafeKey(prefix)
        where.push(`(prefix = ? OR prefix LIKE ? ESCAPE '\\')`)
        params.push(safePrefix, `${escapeLike(safePrefix)}/%`)
      }

      if (q) {
        const pattern = `%${escapeLike(q)}%`
        where.push(
          `(filename LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR alt LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\')`,
        )
        params.push(pattern, pattern, pattern, pattern)
      }

      const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const total = db.prepare(`SELECT COUNT(*) AS count FROM files ${clause}`).get(...params).count
      const rows = db
        .prepare(`SELECT * FROM files ${clause} ORDER BY created_at DESC, filename ASC LIMIT ? OFFSET ?`)
        .all(...params, safeLimit, safeOffset)

      return {
        docs: rows.map(mapRow),
        total: Number(total),
        limit: safeLimit,
        offset: safeOffset,
      }
    },

    async create({ request, filename, prefix = '', alt = '', title = '', mimeType }) {
      const key = joinKey(prefix, filename)
      return withLock(key, async () => {
        if (getRowByKey(key)) {
          throw new HttpError(409, 'A file already exists at that path')
        }
        const written = await writeTemp(request)
        const { filename: safeName, prefix: safePrefix } = splitKey(key)
        let id
        try {
          id = insertRow({
            key,
            filename: safeName,
            prefix: safePrefix,
            mimeType: normalizeMime(mimeType, safeName),
            size: written.size,
            alt: String(alt).slice(0, 2000),
            title: String(title).slice(0, 300),
          })
          await commitTemp(written.tmp, key)
        } catch (error) {
          await rm(written.tmp, { force: true })
          if (id) db.prepare('DELETE FROM files WHERE id = ?').run(id)
          throw error
        }
        return mapRow(getRowById(id))
      })
    },

    async putObject({ request, key, mimeType }) {
      const safe = assertSafeKey(key)
      return withLock(safe, async () => {
        const written = await writeTemp(request)
        const existing = getRowByKey(safe)
        const { filename, prefix } = splitKey(safe)
        const type = normalizeMime(mimeType, filename)
        const now = new Date().toISOString()
        try {
          await commitTemp(written.tmp, safe)
          if (existing) {
            db.prepare('UPDATE files SET mime_type = ?, size = ?, updated_at = ? WHERE id = ?').run(
              type,
              written.size,
              now,
              existing.id,
            )
          } else {
            insertRow({ key: safe, filename, prefix, mimeType: type, size: written.size })
          }
        } catch (error) {
          await rm(written.tmp, { force: true })
          if (!existing) await rm(diskPath(config.dataDir, safe), { force: true })
          throw error
        }
        return { record: mapRow(getRowByKey(safe)), created: !existing }
      })
    },

    async update(id, patch) {
      const current = getRowById(id)
      if (!current) throw new HttpError(404, 'File not found')

      return withLock(current.key, async () => {
        const fresh = getRowById(id)
        if (!fresh) throw new HttpError(404, 'File not found')

        const nextPrefix = Object.hasOwn(patch, 'prefix')
          ? patch.prefix
            ? assertSafeKey(patch.prefix)
            : ''
          : fresh.prefix
        const nextFilename = Object.hasOwn(patch, 'filename') ? sanitizeMoveName(patch.filename) : fresh.filename
        const nextKey = nextPrefix ? `${nextPrefix}/${nextFilename}` : nextFilename
        const nextAlt = Object.hasOwn(patch, 'alt') ? String(patch.alt).slice(0, 2000) : fresh.alt
        const nextTitle = Object.hasOwn(patch, 'title') ? String(patch.title).slice(0, 300) : fresh.title

        if (nextKey !== fresh.key) {
          assertSafeKey(nextKey)
          if (getRowByKey(nextKey)) throw new HttpError(409, 'A file already exists at that path')
          const from = diskPath(config.dataDir, fresh.key)
          const to = diskPath(config.dataDir, nextKey)
          await mkdir(path.dirname(to), { recursive: true })
          await rename(from, to)
          await pruneEmpty(path.dirname(from))
        }

        db.prepare(
          `UPDATE files
           SET key = ?, filename = ?, prefix = ?, alt = ?, title = ?, updated_at = ?
           WHERE id = ?`,
        ).run(nextKey, nextFilename, nextPrefix, nextAlt, nextTitle, new Date().toISOString(), id)

        return mapRow(getRowById(id))
      })
    },

    async replaceContent(id, { request, mimeType, filename }) {
      const current = getRowById(id)
      if (!current) throw new HttpError(404, 'File not found')

      return withLock(current.key, async () => {
        const fresh = getRowById(id)
        if (!fresh) throw new HttpError(404, 'File not found')
        const written = await writeTemp(request)
        const nextFilename = filename ? sanitizeMoveName(filename) : fresh.filename
        const nextKey = fresh.prefix ? `${fresh.prefix}/${nextFilename}` : nextFilename
        if (nextKey !== fresh.key && getRowByKey(nextKey)) {
          await rm(written.tmp, { force: true })
          throw new HttpError(409, 'A file already exists at that path')
        }
        try {
          await commitTemp(written.tmp, nextKey)
          if (nextKey !== fresh.key) {
            await rm(diskPath(config.dataDir, fresh.key), { force: true })
            await pruneEmpty(path.dirname(diskPath(config.dataDir, fresh.key)))
          }
          db.prepare(
            `UPDATE files
             SET key = ?, filename = ?, mime_type = ?, size = ?, updated_at = ?
             WHERE id = ?`,
          ).run(
            nextKey,
            nextFilename,
            normalizeMime(mimeType, nextFilename),
            written.size,
            new Date().toISOString(),
            id,
          )
        } catch (error) {
          await rm(written.tmp, { force: true })
          throw error
        }
        return mapRow(getRowById(id))
      })
    },

    async remove(id) {
      const current = getRowById(id)
      if (!current) throw new HttpError(404, 'File not found')
      return withLock(current.key, async () => {
        const fresh = getRowById(id)
        if (!fresh) throw new HttpError(404, 'File not found')
        db.prepare('DELETE FROM files WHERE id = ?').run(id)
        await rm(diskPath(config.dataDir, fresh.key), { force: true })
        await pruneEmpty(path.dirname(diskPath(config.dataDir, fresh.key)))
      })
    },

    async removeByKey(key) {
      const safe = assertSafeKey(key)
      return withLock(safe, async () => {
        const existing = getRowByKey(safe)
        if (existing) db.prepare('DELETE FROM files WHERE id = ?').run(existing.id)
        await rm(diskPath(config.dataDir, safe), { force: true })
        await pruneEmpty(path.dirname(diskPath(config.dataDir, safe)))
      })
    },

    close() {
      db.close()
    },
  }
}

function sanitizeMoveName(filename) {
  return splitKey(joinKey('', filename)).filename
}
