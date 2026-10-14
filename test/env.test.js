import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadEnvFile } from '../src/env.js'

test('loadEnvFile fills missing keys and keeps existing ones', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'media-env-'))
  const file = path.join(dir, '.env')
  await writeFile(file, '# comment\nAPI_KEY="from-file"\nPUBLIC_URL=http://media.example.com\nSKIP=\n')
  const previous = process.env.PUBLIC_URL
  process.env.PUBLIC_URL = 'http://already-set'
  delete process.env.API_KEY
  try {
    loadEnvFile(file)
    assert.equal(process.env.API_KEY, 'from-file')
    assert.equal(process.env.PUBLIC_URL, 'http://already-set')
  } finally {
    delete process.env.API_KEY
    if (previous === undefined) delete process.env.PUBLIC_URL
    else process.env.PUBLIC_URL = previous
    await rm(dir, { recursive: true, force: true })
  }
})
