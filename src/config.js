import path from 'node:path'

function readBool(value, fallback) {
  if (value === undefined || value === '') return fallback
  return value === 'true' || value === '1'
}

function readInt(value, fallback) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid integer configuration value: ${value}`)
  }
  return parsed
}

export function loadConfig(env = process.env) {
  const port = readInt(env.PORT, 4100)
  const maxUploadBytes = readInt(env.MAX_UPLOAD_BYTES, 200 * 1024 * 1024)
  const apiKey = env.API_KEY || ''

  if (!apiKey) {
    throw new Error('API_KEY is required')
  }

  const publicUrl = (env.PUBLIC_URL || 'auto').replace(/\/+$/, '')

  return {
    port,
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || path.join(process.cwd(), 'data')),
    apiKey,
    publicUrl,
    publicRead: readBool(env.PUBLIC_READ, true),
    corsOrigin: env.CORS_ORIGIN || '*',
    maxUploadBytes,
  }
}
