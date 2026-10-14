FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    PORT=4100 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    PUBLIC_READ=true

COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown -R node:node /app /data

USER node

VOLUME ["/data"]
EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4100/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
