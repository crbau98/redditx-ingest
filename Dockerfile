FROM node:20-alpine

WORKDIR /app

# better-sqlite3 needs native build tooling on Alpine
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /data

ENV NODE_ENV=production
ENV DB_PATH=/data/prism.db

EXPOSE 3141

CMD ["node", "server.js"]
