import assert from 'node:assert/strict'
import test from 'node:test'

import { assertSafeKey, encodeKey, joinKey, normalizeMime, sanitizeFilename, splitKey } from '../src/paths.js'
import { HttpError } from '../src/errors.js'

test('storage keys reject traversal and empty segments', () => {
  assert.equal(assertSafeKey('/uploads//photo.jpg'), 'uploads/photo.jpg')
  assert.equal(joinKey('uploads', 'photo.jpg'), 'uploads/photo.jpg')
  assert.deepEqual(splitKey('uploads/user-123/photo.jpg'), {
    prefix: 'uploads/user-123',
    filename: 'photo.jpg',
  })
  assert.equal(encodeKey('uploads/my file.jpg'), 'uploads/my%20file.jpg')
  assert.equal(sanitizeFilename('../notes/my file?.txt'), 'my file-.txt')
  assert.equal(normalizeMime('image/jpeg; charset=binary', 'a.jpg'), 'image/jpeg')
  assert.equal(normalizeMime('nope', 'clip.mp4'), 'video/mp4')

  for (const key of ['../secret', 'uploads/../../etc/passwd', '', '.', '..', 'foo/../bar', 'a/\0/b']) {
    assert.throws(() => assertSafeKey(key), (error) => error instanceof HttpError && error.status === 400)
  }
})
