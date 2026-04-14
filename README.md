# PRISM - NSFW Media Discovery Platform

A gay-focused NSFW media discovery platform with Reddit ingestion, SQLite persistence, admin panel, and Railway deployment.

## Features

- **Media Gallery** - Masonry grid with lazy loading, infinite scroll, filtering, and search
- **Reddit Ingestion** - Automated media fetching from configurable subreddits via Reddit JSON API
- **Creator Profiles** - Identity system with multi-platform support
- **Admin Panel** - Dashboard, ingestion controls, moderation queue, media/creator management
- **Age Gate** - Session-based age verification interstitial
- **Real-time Updates** - SSE streaming during ingestion
- **Media Proxy** - All media proxied through the server for privacy
- **SQLite Persistence** - All data stored in SQLite via better-sqlite3
- **Railway Ready** - Dockerfile, health checks, persistent volume support

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
npm start

# Server runs on http://localhost:3141
```

## Configuration

Copy `.env.example` to `.env` and customize:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3141` |
| `DB_PATH` | SQLite database path | `./data/prism.db` |
| `ADMIN_KEY` | Admin API key | _(none - open access)_ |
| `NODE_ENV` | Environment | `development` |

## Admin Access

1. Click the gear icon in the header
2. Enter your `ADMIN_KEY` when prompted
3. Use the admin panel to manage ingestion, moderation, media, and creators

Admin API routes require the `x-admin-key` header.

## Deploy to Railway

1. Push to GitHub
2. Connect repo to Railway
3. Add a persistent volume mounted at `/data`
4. Set environment variables (`ADMIN_KEY`, `DB_PATH=/data/prism.db`)
5. Deploy

## Tech Stack

- **Backend**: Node.js + Express
- **Database**: SQLite via better-sqlite3
- **Frontend**: Vanilla HTML/CSS/JS (single-page app, no build step)
- **Deployment**: Docker + Railway

## API Reference

### Public Endpoints

- `GET /api/health` - Health check
- `GET /api/media` - List media (params: page, limit, type, subreddit, creator, tag, sort, q)
- `GET /api/media/:id` - Media detail
- `GET /api/media/:id/related` - Related media
- `GET /api/creators` - List creators
- `GET /api/creators/:id` - Creator profile
- `GET /api/tags` - List tags
- `GET /api/subreddits` - List subreddits
- `GET /api/stats` - Public stats
- `GET /api/proxy?url=` - Media proxy
- `GET /api/stream` - SSE event stream

### Admin Endpoints (require `x-admin-key` header)

- `POST /api/admin/ingest/start` - Start ingestion
- `POST /api/admin/ingest/stop` - Stop ingestion
- `POST /api/admin/ingest/pause` - Pause ingestion
- `POST /api/admin/ingest/resume` - Resume ingestion
- `GET /api/admin/jobs` - Job history
- `PATCH /api/admin/media/:id` - Update media
- `DELETE /api/admin/media/:id` - Remove media
- `POST /api/admin/media/:id/moderate` - Moderate media
- `POST /api/admin/media/bulk` - Bulk media actions
- `PATCH /api/admin/creators/:id` - Update creator
- `POST /api/admin/creators/merge` - Merge creators
- `GET /api/admin/moderation/queue` - Moderation queue
- `GET /api/admin/settings` - Get settings
- `PUT /api/admin/settings` - Update settings
