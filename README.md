# Media Server

A small file server for adding, editing, and deleting media. It uses the Node.js 22 already installed for this user, Apache can proxy it, and it can be a [Payload CMS](https://payloadcms.com/docs/upload/storage-adapters) custom storage adapter.

Node.js 22 is already installed on this server, so the app runs with that Node. Apache is already installed and can sit in front of it. Docker is optional and is covered at the end.

## Run with the Node.js already on the server

```bash
cd /media/drive/Bhavik/Projects/Mediaserver
cp .env.example .env
# Set API_KEY to a long random string.
# If Apache will be the public address, set PUBLIC_URL to that site URL.

node src/index.js
```

`node src/index.js` reads `.env` from the project directory. Use the Node 22 already on your `PATH` (`node --version` should print v22). `/usr/bin/node` is Node 18 and cannot run this app. Open the `PUBLIC_URL` (http://localhost:4100 by default), paste the API key, and upload a file. Files and the SQLite catalog are stored in `./data`.

Keep it running after logout with the systemd unit:

```bash
sudo cp deploy/media-server.service /etc/systemd/system/media-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now media-server
sudo systemctl status media-server
```

The unit binds the app to `127.0.0.1:4100`, so only Apache on this machine can reach it.

## Apache

Apache 2.4 is already installed. The sample site is `deploy/apache-media.conf`. It proxies every request to the Node process and allows uploads up to 200 MB.

```bash
sudo a2enmod proxy proxy_http headers
sudo cp deploy/apache-media.conf /etc/apache2/sites-available/media.conf
# Edit ServerName in /etc/apache2/sites-available/media.conf
sudo a2ensite media
sudo apache2ctl configtest
sudo systemctl reload apache2
```

Set `PUBLIC_URL` in `.env` to the same address as `ServerName`, then restart the media service (`sudo systemctl restart media-server`) so saved file URLs use that host.

## Docker

Use this only if you want the media server in its own container. The image includes its own Node runtime and does not use the Node.js already installed on the server. Apache on the host can still proxy to the published port `127.0.0.1:4100`.

```bash
cp .env.example .env
# Set API_KEY in .env to a long random string.

docker compose up --build -d
docker compose ps
docker compose logs -f media
```

Open http://localhost:4100. Files and the SQLite catalog are stored in the `media-data` volume.

Stop it with `docker compose down`. The volume keeps the files. `docker compose down -v` deletes them.

## Library API

Send `Authorization: Bearer <API_KEY>` on every `/api` request. `GET /files/...` is public when `PUBLIC_READ=true`.

| Action | Request |
| --- | --- |
| Add | `POST /api/files?filename=photo.jpg&prefix=uploads&title=&alt=` with the raw file as the body |
| List | `GET /api/files?q=&prefix=&limit=24&offset=0` |
| Edit details | `PATCH /api/files/:id` with JSON `{ "title", "alt", "filename", "prefix" }` |
| Replace bytes | `PUT /api/files/:id` with the raw file as the body |
| Delete | `DELETE /api/files/:id` |
| Read | `GET /files/<prefix>/<filename>` |

`PUT /api/objects/<key>` and `DELETE /api/objects/<key>` are the routes the Payload adapter uses. Delete is idempotent. Range requests and `ETag` are supported on `GET /files/...`.

## Payload storage adapter

The adapter implements `GeneratedAdapter` from `@payloadcms/plugin-cloud-storage`: `handleUpload`, `handleDelete`, `staticHandler`, and `generateURL`.

Copy `adapter/` into your Payload project, or depend on it with `"@mediaserver/payload-storage": "file:../Mediaserver/adapter"`. Install the peer packages there:

```bash
pnpm add @payloadcms/plugin-cloud-storage
```

```ts
import { buildConfig } from 'payload'
import { mediaServerStorage } from './adapter/src/index.ts'

export default buildConfig({
  plugins: [
    mediaServerStorage({
      baseURL: process.env.MEDIA_SERVER_URL,
      apiKey: process.env.MEDIA_SERVER_API_KEY,
      collections: {
        media: {
          // Files are served directly from the media server.
          disablePayloadAccessControl: true,
        },
        'media-with-prefix': {
          prefix: 'uploads',
        },
      },
    }),
  ],
})
```

From another container, `MEDIA_SERVER_URL` is `http://media:4100`. `MEDIA_SERVER_API_KEY` must match this server's `API_KEY`.

The same adapter can be passed straight to `cloudStoragePlugin`:

```ts
import { cloudStoragePlugin } from '@payloadcms/plugin-cloud-storage'
import { createMediaServerAdapter } from './adapter/src/index.ts'

const adapter = createMediaServerAdapter({
  baseURL: process.env.MEDIA_SERVER_URL,
  apiKey: process.env.MEDIA_SERVER_API_KEY,
})

export default buildConfig({
  plugins: [
    cloudStoragePlugin({
      collections: {
        media: { adapter },
      },
    }),
  ],
})
```

Payload resolves `storageFilePath` before upload and delete. New files stay under the collection prefix. With `useCompositePrefixes: false` (the default), a document prefix of `uploads/user-123` and a collection prefix of `uploads` is stored as `uploads/user-123/image.jpg`. With `useCompositePrefixes: true`, that same pair is stored as `uploads/uploads/user-123/image.jpg`. Existing objects keep the prefix already saved on the document for reads, URLs, and deletion.

Leave `disablePayloadAccessControl` unset when Payload should keep checking `read` access. The adapter's `staticHandler` then proxies the file with the API key, so you can set `PUBLIC_READ=false`. Set `disablePayloadAccessControl: true` only when the collection is public and `PUBLIC_READ=true`, because Payload will link directly to `/files/...`.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_KEY` | required | Bearer token for uploads, edits, and deletes |
| `PUBLIC_URL` | listen address | Base URL written into file records. Docker Compose sets `http://localhost:4100`. |
| `PUBLIC_READ` | `true` | Allow anonymous `GET /files/...` |
| `CORS_ORIGIN` | `*` | Browser origin allowed to call the API |
| `MAX_UPLOAD_BYTES` | `209715200` | Upload limit, 200 MB |
| `PORT` | `4100` | Listen port |
| `HOST` | `0.0.0.0` | Listen address. The systemd unit sets `127.0.0.1` so only Apache can connect. |
| `DATA_DIR` | `./data` | Database and file directory |
