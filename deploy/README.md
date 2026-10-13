# Deploying PRISM (private, always-on)

**Recommended setup:** one small Hetzner Cloud VPS running this Docker Compose stack, reached only through **Tailscale** (nothing is exposed to the public internet), with the database continuously replicated to **Cloudflare R2** by Litestream.

Why this and not a platform-as-a-service:
- **CPU**: the image filter runs a neural network on every candidate picture. A 4-vCPU VPS is several times cheaper than the same CPU on a PaaS.
- **Private by construction**: no public URL, so no age gate, abuse, or scraping traffic to worry about; you reach it from your own devices over your tailnet.
- **Durability**: Litestream ships every SQLite change to object storage within seconds (two weeks of point-in-time history). A dead server is recovered by `docker compose up` on a new one.
- **Search**: Keenable and Brave when you have keys, plus a private SearXNG (bundled, or your own — including one on an onion address, reached through the bundled Tor client).
- Reddit blocks datacenter IPs for anonymous reads, so the VPS **must** use Reddit OAuth (below). A home server on a residential connection avoids that, but loses on uptime; the same stack runs on one.

Approximate monthly cost (check current prices): VPS €8–15, R2 storage free up to 10 GB then ≈ $0.015/GB, Brave per its current plan (SearXNG is the free fallback), Reddit OAuth free for personal-scale reads. **X's paid API is the expensive one** (Basic is on the order of $200/month): skip it unless X is essential; keyless X reading still works best-effort.

## 1. Server
1. Create a Hetzner Cloud server: **CPX31** (4 vCPU, 8 GB) is the sweet spot; CPX21 (3 vCPU, 4 GB) is enough to start. Ubuntu 24.04, region near you, add your SSH key.
2. On the server (as root):
   ```bash
   git clone https://github.com/crbau98/redditx-ingest.git && cd redditx-ingest
   bash deploy/vps-bootstrap.sh && tailscale up
   ```
   The script installs Docker (container logs capped at 3 x 10 MB), a 2 GB swap file, automatic security updates, key-only SSH,
   a firewall that lets in only SSH and Tailscale, Tailscale itself, and a `dc` shortcut for `docker compose -f deploy/docker-compose.yml`.

## 2. Object storage for backups
1. Cloudflare dashboard → R2 → create bucket `prism-db`, then an **API token** with Object Read & Write on that bucket. Note the account endpoint (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`).
2. (Backblaze B2 works the same: use its S3 endpoint and an application key.)

For Telegram files add a **second, private** bucket (`prism-media`) and its own API token (Object Read & Write on that bucket only). R2 has no egress fees and 10 GB free; storage beyond that is about US$0.015 per GB-month. PRISM streams files from Telegram to the bucket and from the bucket to your browser through its own proxy, so nothing is kept on the server and the bucket never needs to be public.

## 3. Source credentials
- **Reddit**: <https://www.reddit.com/prefs/apps> → *create another app* → type **script**. Put the id/secret in `REDDIT_CLIENT_ID/SECRET` and a descriptive `REDDIT_USER_AGENT`. Confirm Reddit's current API terms for personal use.
- **Brave Search**: create a key at <https://api.search.brave.com> (check the current plan and quota). SearXNG covers you if you skip it.
- **Bluesky**: Settings → Privacy and security → App passwords → `BSKY_IDENTIFIER` (your handle) + `BSKY_APP_PASSWORD` (enables hashtag/keyword search).
- Optional: `TELEGRAM_API_KEY` (a bot token from @BotFather), `MASTODON_ACCESS_TOKEN`, `MISSKEY_ACCESS_TOKEN`, `X_BEARER_TOKEN`.

## 3c. Telegram: every channel your account has joined
1. <https://my.telegram.org> → *API development tools* → create an app. Put `TELEGRAM_API_ID` (a number) and `TELEGRAM_API_HASH` in `deploy/.env`, plus the `MEDIA_STORE_*` bucket from section 2.
2. Log in once, on the server (it asks for your phone number, the code Telegram sends to your Telegram app, and your two-step password if you set one):
   ```bash
   docker compose -f deploy/docker-compose.yml run --rm prism node scripts/telegram-login.js
   ```
   The session is written to the data volume (`/data/telegram.session`, mode 600). It is as powerful as your account, so it is **not** in the database or the Litestream backup: after rebuilding the server from scratch, run this step again.
3. Restart (`docker compose -f deploy/docker-compose.yml up -d`) or press **Admin → Sources → Telegram → Sync joined channels**. Every channel and group you have joined becomes a feed (private ones by id); join a new one in the Telegram app and the next sync (every 12 h) follows it, leave one and its feed is switched off. Channels whose name reads female are never followed.
4. History is read newest-first and back-filled gradually (up to `TELEGRAM_BACKFILL_MAX` older media per channel). A post's file is downloaded **only after** the text gates and duplicate check accept it, and deleted from the bucket again if the picture filter or duplicate detection rejects it afterwards. Videos over `TELEGRAM_MAX_MB` are skipped.

A user account that reads many channels can hit Telegram's flood limits: PRISM reads one channel at a time and waits out `FLOOD_WAIT` errors. Use an account you can afford to have rate-limited, not one you depend on.

## 3b. Your own SearXNG, including an onion one
Leave `SEARXNG_URL` empty to use the bundled container. To use your own, set it in `deploy/.env`; an onion instance must be written `http://<56 characters>.onion` (the `.onion` ending is required and the scheme is `http://`: Tor encrypts end to end). The compose stack includes a client-only Tor sidecar for this. PRISM will contact **only** that one onion address; every other `.onion` name is refused. Onion lookups are slow (several seconds to build a circuit): searches get a 70-second timeout and are cached for ten minutes.

## 4. Run it
```bash
git clone https://github.com/crbau98/redditx-ingest.git && cd redditx-ingest
cp deploy/.env.example deploy/.env && nano deploy/.env       # fill in every value
docker compose -f deploy/docker-compose.yml up -d --build
tailscale serve --bg 3141                                      # HTTPS on your tailnet, e.g. https://<server>.<tailnet>.ts.net
```
Open the tailnet URL, then **Admin** (gear icon) and enter `ADMIN_KEY`.

## 5. Prove every source works
```bash
docker compose -f deploy/docker-compose.yml exec prism node scripts/diagnose-sources.js
```
Fix what it flags (it prints the exact variable to set), then watch **Admin → Sources**: each platform shows its 7-day yield, error rate, empty-run rate and unique creators. Keep what earns its requests; tune or drop the rest.

## 6. Backups and recovery
- Replication is automatic. Check it: `docker compose -f deploy/docker-compose.yml logs litestream`.
- **Restore drill** (do it once): on a fresh machine, `docker compose -f deploy/docker-compose.yml up -d --build` with the same `deploy/.env`; the `restore` service rebuilds `/data/prism.db` from R2 before the app starts. If the restore fails (bad credentials, network, corrupt replica) the stack stops there on purpose, so a recovery failure is visible instead of PRISM silently starting empty: read `docker compose -f deploy/docker-compose.yml logs restore`.
- Admin → Settings also keeps nightly local copies (`VACUUM INTO`).

## 7. Moving to a new server (from another VPS or a Codespace)
Only one machine may run the stack at a time: two Litestream processes writing the same replica, or two copies of one
Telegram session, break each other.
1. **Old machine**, stop PRISM first so Litestream ships the last writes, then stop the rest:
   ```bash
   docker compose -f deploy/docker-compose.yml stop prism && sleep 20 && docker compose -f deploy/docker-compose.yml down
   ```
2. Copy `deploy/.env` to the new server (`scp`, then `chmod 600`). Nothing else needs copying.
3. **New server**: `docker compose -f deploy/docker-compose.yml up -d --build`. The `restore` service pulls the database from R2.
4. Redo the Telegram login (section 3c step 2) and restart. In Telegram → Settings → Devices, end the **older** PRISM session.
5. Once the new server is ingesting, delete the old machine's data volume (`docker volume rm prism_data`) so it can never start again by accident.

## 8. Updating
```bash
git pull && docker compose -f deploy/docker-compose.yml up -d --build
```
