FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

# Create data directory for SQLite
RUN mkdir -p /data

ENV NODE_ENV=production
ENV DB_PATH=/data/prism.db

# Railway sets PORT dynamically, this is just a default fallback
EXPOSE ${PORT:-3141}

CMD ["node", "server.js"]
