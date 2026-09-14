# PRISM - NSFW Media Discovery Platform

A gay-focused NSFW media discovery platform with Reddit ingestion, SQLite persistence, admin panel, and Railway deployment.

## Features

- **Media Gallery** — Responsive masonry/grid with lazy loading, infinite scroll, filters, and search
- **Mobile-first shell** — Bottom navigation, filter drawer, mobile search, swipeable lightbox
- **Saved collection** — Device-local favorites with heart actions and share links
- **Creators** — Browse and open creator profiles with media grids
- **Reddit / X / RedGIFs ingestion** — Pulls creator photos and videos from gay Reddit communities, public X posts, and RedGIFs. Generic Bing/DuckDuckGo image search is off by default because it filled the gallery with stock photos and dead Imgur links.
- **Quality gate** — Rejects stock/CDN junk, deleted Imgur placeholders, and HTML pages before anything is published. Admin can sweep existing junk.
- **Admin Panel** — Dashboard, ingestion controls, live logs, moderation queue, media/creator management
- **Age Gate** — Session-based age verification interstitial
- **Real-time Updates** — SSE streaming during ingestion
- **Media Proxy** — Remote media proxied through the server for privacy
- **SQLite Persistence** — All data stored in SQLite via better-sqlite3
- **Railway Ready** — Dockerfile, health checks, persistent volume support

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

Set `X_BEARER_TOKEN` for official X recent-search ingest. Without it, X still harvests public tweet media found via DuckDuckGo.

Default sources: Reddit (archive fallback when Reddit returns 403), X, and RedGIFs. Optional DDG/web ingest only keeps Imgur, RedGIFs, Reddit, and similar creator hosts — not Bing stock photos.

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

- `POST /api/admin/ingest/start` — Start a multi-source scan (`sources`, `subs`, `queries`, `xQueries`, `limit`, `minScore`)
- `POST /api/admin/ingest/stop` — Stop ingestion
- `POST /api/admin/ingest/pause` — Pause ingestion
- `POST /api/admin/ingest/resume` — Resume ingestion
- `GET /api/admin/ingest/status` — Live job stats + recent logs
- `GET /api/admin/ingest/logs` — Full in-memory ingest log
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
