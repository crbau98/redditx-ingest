FROM node:22-alpine

WORKDIR /app

# better-sqlite3 ships prebuilt binaries for Alpine/musl; the toolchain is only a fallback
# for platforms where a prebuild is unavailable.
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# Runs as root on purpose: platform volumes (e.g. Railway) are mounted root-owned and SQLite must be able to write there.
RUN mkdir -p /data

ENV NODE_ENV=production
ENV DB_PATH=/data/prism.db

EXPOSE 3141

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3141}/api/health" >/dev/null || exit 1

CMD ["node", "server.js"]
