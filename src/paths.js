import path from 'node:path'

import { HttpError } from './errors.js'

const MAX_KEY_LENGTH = 1024
const MAX_SEGMENTS = 32

export function assertSafeKey(input) {
  if (typeof input !== 'string' || input.includes('\0')) {
    throw new HttpError(400, 'Invalid storage key')
  }

  const key = input.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '')
  if (!key || key.length > MAX_KEY_LENGTH) {
    throw new HttpError(400, 'Invalid storage key')
  }

  const parts = key.split('/')
  if (parts.length > MAX_SEGMENTS) {
    throw new HttpError(400, 'Invalid storage key')
  }

  for (const part of parts) {
    if (!part || part === '.' || part === '..') {
      throw new HttpError(400, 'Invalid storage key')
    }
  }

  return key
}

export function sanitizeFilename(name) {
  const base = path.posix
    .basename(String(name || '').replace(/\\/g, '/'))
    .replace(/[\0\r\n]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .trim()
    .replace(/^\.+/, '')

  if (!base || base === '.' || base === '..') {
    throw new HttpError(400, 'Invalid filename')
  }

  return base.slice(0, 180)
}

export function joinKey(prefix, filename) {
  const safeName = sanitizeFilename(filename)
  const folder = prefix ? assertSafeKey(prefix) : ''
  return folder ? `${folder}/${safeName}` : safeName
}

export function splitKey(key) {
  const safe = assertSafeKey(key)
  const index = safe.lastIndexOf('/')
  if (index === -1) return { prefix: '', filename: safe }
  return { prefix: safe.slice(0, index), filename: safe.slice(index + 1) }
}

export function encodeKey(key) {
  return assertSafeKey(key).split('/').map(encodeURIComponent).join('/')
}

export function diskPath(dataDir, key) {
  const safe = assertSafeKey(key)
  const root = path.resolve(dataDir, 'files')
  const full = path.resolve(root, ...safe.split('/'))
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new HttpError(400, 'Invalid storage key')
  }
  return full
}

export function normalizeMime(value, filename) {
  const raw = String(value || '').split(';')[0].trim().toLowerCase()
  if (/^[\w.+-]+\/[\w.+-]+$/.test(raw) && raw.length <= 127) return raw
  return mimeFromFilename(filename)
}

const EXTENSIONS = {
  avif: 'image/avif',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
  txt: 'text/plain',
  json: 'application/json',
}

export function mimeFromFilename(filename) {
  const extension = filename.split('.').pop()?.toLowerCase()
  return EXTENSIONS[extension] || 'application/octet-stream'
}
