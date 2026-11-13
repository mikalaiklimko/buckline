# syntax=docker/dockerfile:1

# BuckLine has no npm dependencies, so a single slim stage is enough.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_FILE=/data/line.json

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public

# Run as the unprivileged "node" user; /data holds the current line.
RUN mkdir -p /data && chown node:node /data
USER node

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

CMD ["node", "src/server.js"]
