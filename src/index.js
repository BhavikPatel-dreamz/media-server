import { loadEnvFile } from './env.js'
import { createServerApp } from './server.js'

loadEnvFile()

const app = createServerApp()

if (app.config.apiKey.length < 16 || app.config.apiKey === 'change-me-please') {
  console.warn('API_KEY is short or still the example value. Set a long random API_KEY before exposing this server.')
}

await app.listen()
console.log(`Media server listening on http://${app.config.host}:${app.port}`)
console.log(`Public URL: ${app.config.publicUrl}`)
console.log(`Data directory: ${app.config.dataDir}`)
console.log(`Public read: ${app.config.publicRead}`)
