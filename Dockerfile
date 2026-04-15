FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

EXPOSE 3141

ENV NODE_ENV=production
ENV PORT=3141
ENV DB_PATH=/data/prism.db

VOLUME /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q --spider http://localhost:3141/api/health || exit 1

CMD ["node", "server.js"]
