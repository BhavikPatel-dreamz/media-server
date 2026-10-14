import { buildConfig } from 'payload'
import { mediaServerStorage } from '../adapter/src/index.ts'

export default buildConfig({
  collections: [],
  plugins: [
    mediaServerStorage({
      baseURL: process.env.MEDIA_SERVER_URL || 'http://localhost:4100',
      apiKey: process.env.MEDIA_SERVER_API_KEY || '',
      useCompositePrefixes: false,
      collections: {
        media: {
          disablePayloadAccessControl: true,
        },
        'media-with-prefix': {
          prefix: 'uploads',
        },
      },
    }),
  ],
  secret: process.env.PAYLOAD_SECRET || 'change-me',
})
