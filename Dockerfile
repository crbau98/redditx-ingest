FROM node:22-alpine

WORKDIR /app

# better-sqlite3 ships prebuilt binaries for Alpine/musl; the toolchain is only a fallback
# for platforms where a prebuild is unavailable.
# Chromium backs the raw-CDP challenge browser (lib/chrome.js): it is the only local engine that gets past a
# managed Cloudflare / DDoS-Guard / DataDome challenge, and it costs nothing per page. ttf-freefont gives it fonts,
# so a challenge page's canvas/WebGL fingerprint looks like a real desktop.
RUN apk add --no-cache python3 make g++ wget chromium ttf-freefont

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# Runs as root on purpose: platform volumes (e.g. Railway) are mounted root-owned and SQLite must be able to write there.
RUN mkdir -p /data

ENV NODE_ENV=production
ENV DB_PATH=/data/prism.db
ENV PORT=3141
# The challenge browser: enabled, pointed at Alpine's Chromium, headless (the container has no display).
ENV CHALLENGE_BROWSER=1
ENV CHROME_PATH=/usr/bin/chromium-browser

EXPOSE 3141

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

CMD ["node", "--import", "./instrument.js", "server.js"]
