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
2. On the server:
   ```bash
   curl -fsSL https://get.docker.com | sh
   curl -fsSL https://tailscale.com/install.sh | sh && tailscale up
   ufw default deny incoming && ufw allow OpenSSH && ufw enable      # or allow SSH only over tailscale0
   ```

## 2. Object storage for backups
1. Cloudflare dashboard → R2 → create bucket `prism-db`, then an **API token** with Object Read & Write on that bucket. Note the account endpoint (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`).
2. (Backblaze B2 works the same: use its S3 endpoint and an application key.)

## 3. Source credentials
- **Reddit**: <https://www.reddit.com/prefs/apps> → *create another app* → type **script**. Put the id/secret in `REDDIT_CLIENT_ID/SECRET` and a descriptive `REDDIT_USER_AGENT`. Confirm Reddit's current API terms for personal use.
- **Brave Search**: create a key at <https://api.search.brave.com> (check the current plan and quota). SearXNG covers you if you skip it.
- **Bluesky**: Settings → Privacy and security → App passwords → `BSKY_IDENTIFIER` (your handle) + `BSKY_APP_PASSWORD` (enables hashtag/keyword search).
- Optional: `TELEGRAM_API_KEY` (a bot token from @BotFather), `MASTODON_ACCESS_TOKEN`, `MISSKEY_ACCESS_TOKEN`, `X_BEARER_TOKEN`.

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

## 7. Updating
```bash
git pull && docker compose -f deploy/docker-compose.yml up -d --build
```
