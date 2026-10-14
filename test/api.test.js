import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { createServerApp } from '../src/server.js'

const key = 'test-api-key-value'
let app
let base
let dataDir

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'media-server-'))
  app = createServerApp({
    API_KEY: key,
    DATA_DIR: dataDir,
    HOST: '127.0.0.1',
    MAX_UPLOAD_BYTES: '32',
    PORT: '0',
    PUBLIC_READ: 'true',
    PUBLIC_URL: 'auto',
  })
  await app.listen()
  base = `http://127.0.0.1:${app.port}`
})

after(async () => {
  await app.close()
  await rm(dataDir, { recursive: true, force: true })
})

function auth(extra = {}) {
  return { Authorization: `Bearer ${key}`, ...extra }
}

describe('media api', { concurrency: 1 }, () => {
  test('health and the library page do not need an api key', async () => {
    const health = await fetch(`${base}/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true, publicRead: true })

    const page = await fetch(base)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Upload/)
  })

  test('upload, edit, replace, and delete a file', async () => {
    const created = await fetch(`${base}/api/files?${new URLSearchParams({
      filename: 'beach photo.txt',
      prefix: 'trips/2026',
      title: 'Beach',
      alt: 'Sunny shore',
    })}`, {
      method: 'POST',
      headers: auth({ 'Content-Type': 'text/plain' }),
      body: 'hello media',
    })
    assert.equal(created.status, 201)
    const record = await created.json()
    assert.equal(record.key, 'trips/2026/beach photo.txt')
    assert.equal(record.title, 'Beach')
    assert.equal(record.filesize, Buffer.byteLength('hello media'))

    const listed = await fetch(`${base}/api/files?${new URLSearchParams({ prefix: 'trips/2026', q: 'Sunny' })}`, {
      headers: auth(),
    })
    const page = await listed.json()
    assert.equal(page.total, 1)
    assert.equal(page.docs[0].id, record.id)

    const edited = await fetch(`${base}/api/files/${record.id}`, {
      method: 'PATCH',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        title: 'Evening beach',
        alt: 'After sunset',
        filename: 'evening.txt',
        prefix: 'trips/2026/edited',
      }),
    })
    assert.equal(edited.status, 200)
    const next = await edited.json()
    assert.equal(next.key, 'trips/2026/edited/evening.txt')
    assert.equal(next.title, 'Evening beach')

    const oldFile = await fetch(`${base}/files/${encodeURIComponent('trips/2026/beach photo.txt')}`)
    assert.equal(oldFile.status, 404)

    const moved = await fetch(`${base}/files/trips/2026/edited/evening.txt`)
    assert.equal(moved.status, 200)
    assert.equal(await moved.text(), 'hello media')

    const replaced = await fetch(`${base}/api/files/${record.id}`, {
      method: 'PUT',
      headers: auth({ 'Content-Type': 'text/plain' }),
      body: 'replaced',
    })
    assert.equal(replaced.status, 200)
    assert.equal((await replaced.json()).filesize, 8)
    assert.equal(await (await fetch(`${base}/files/trips/2026/edited/evening.txt`)).text(), 'replaced')

    const removed = await fetch(`${base}/api/files/${record.id}`, { method: 'DELETE', headers: auth() })
    assert.equal(removed.status, 204)
    assert.equal((await fetch(`${base}/api/files/${record.id}`, { headers: auth() })).status, 404)
    assert.equal((await fetch(`${base}/files/trips/2026/edited/evening.txt`)).status, 404)
  })

  test('object routes match the payload adapter contract', async () => {
    const keyPath = 'uploads/user-123/image.jpg'
    const encoded = keyPath.split('/').map(encodeURIComponent).join('/')
    const saved = await fetch(`${base}/api/objects/${encoded}`, {
      method: 'PUT',
      headers: auth({ 'Content-Type': 'image/jpeg' }),
      body: 'jpeg-bytes',
    })
    assert.equal(saved.status, 201)
    const first = await saved.json()
    assert.equal(first.url, `${base}/files/${encoded}`)

    const again = await fetch(`${base}/api/objects/${encoded}`, {
      method: 'PUT',
      headers: auth({ 'Content-Type': 'image/jpeg' }),
      body: 'jpeg-bytes-2',
    })
    assert.equal(again.status, 200)
    const second = await again.json()
    assert.equal(second.id, first.id)
    assert.equal(second.filesize, 'jpeg-bytes-2'.length)

    const file = await fetch(`${base}/files/${encoded}`, { headers: { Range: 'bytes=0-3' } })
    assert.equal(file.status, 206)
    assert.equal(file.headers.get('accept-ranges'), 'bytes')
    assert.equal(await file.text(), 'jpeg')
    const etag = file.headers.get('etag')
    const cached = await fetch(`${base}/files/${encoded}`, { headers: { 'If-None-Match': etag } })
    assert.equal(cached.status, 304)

    const removed = await fetch(`${base}/api/objects/${encoded}`, { method: 'DELETE', headers: auth() })
    assert.equal(removed.status, 204)
    const removedAgain = await fetch(`${base}/api/objects/${encoded}`, { method: 'DELETE', headers: auth() })
    assert.equal(removedAgain.status, 204)
  })

  test('rejects missing auth, traversal, and oversized uploads', async () => {
    const denied = await fetch(`${base}/api/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'nope',
    })
    assert.equal(denied.status, 401)

    const traversal = await fetch(`${base}/api/objects/${encodeURIComponent('../secret.txt')}`, {
      method: 'PUT',
      headers: auth({ 'Content-Type': 'text/plain' }),
      body: 'x',
    })
    assert.equal(traversal.status, 400)

    const oversized = await fetch(`${base}/api/objects/too-big.txt`, {
      method: 'PUT',
      headers: auth({ 'Content-Type': 'text/plain' }),
      body: 'x'.repeat(40),
    })
    assert.equal(oversized.status, 413)
  })
})
