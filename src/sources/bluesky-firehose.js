// src/sources/bluesky-firehose.js
// Bluesky Jetstream firehose -> discovery leads only. Never writes media.
// Gate: adult self-label AND real media embed. Cursor tracks stream position, not interest.
// Memory-bounded: RingBuffer, LruSet, TokenBucket. Defaults OFF.
import * as integration from '../engine/integration.js';
import { RingBuffer, LruSet, TokenBucket, Backoff, sleep, safeJson, resolveWebSocket } from '../engine/netutil.js';

export const platform = 'bluesky-firehose';
export const kinds = ['firehose'];
export const isConfigured = () => envBool('BLUESKY_FIREHOSE_ENABLED', false);

const ENDPOINTS = [
  'wss://jetstream1.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post',
  'wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post',
  'wss://jetstream1.us-west.bsky.network/subscribe?wantedCollections=app.bsky.feed.post',
  'wss://jetstream2.us-west.bsky.network/subscribe?wantedCollections=app.bsky.feed.post',
];

const ADULT_LABELS = new Set(['porn', 'sexual', 'nudity', 'graphic-media']);
const CURSOR_KEY = 'bluesky_jetstream_cursor_us';
const CURSOR_REWIND_US = 5_000_000; // 5s
const IDLE_TIMEOUT_MS = 90_000;
const MAX_DEPTH_RECONNECT = 4; // guard against tight loop
const SEEN_DID_CACHE = 5000;
const LEAD_DEDUPE_MS = 60_000 * 30;

function envBool(k, d){ const v=process.env[k]; if(v==null) return d; return /^(1|true|yes|on)$/i.test(String(v).trim()); }
function envInt(k, d){ const v=parseInt(process.env[k],10); return Number.isFinite(v)?v:d; }

function hasAdultSelfLabel(record){
  if(!record) return false;
  const labels = record.labels?.values || record.labels || [];
  // labels can be [{val:'porn'}, 'porn'] etc
  for(const l of labels){
    const v = typeof l==='string' ? l : (l.val || l.value || l.$type || '');
    if(ADULT_LABELS.has(String(v).toLowerCase())) return true;
  }
  // also check record.embed labels fallback? no — only self-labels, per spec
  return false;
}

function hasRealMediaEmbed(record){
  if(!record?.embed) return false;
  const t = record.embed.$type || record.embed.type || '';
  // app.bsky.embed.images, app.bsky.embed.video, app.bsky.embed.recordWithMedia
  if(t.includes('images') || t.includes('video') || t.includes('recordWithMedia')) return true;
  // Jetstream may inline images array
  if(Array.isArray(record.embed.images) && record.embed.images.length>0) return true;
  if(record.embed.external && record.embed.external.thumb) return false; // link card != media gate unless video/images present
  return false;
}

function extractAtUri(evt){
  // commit path: at://did/app.bsky.feed.post/rkey
  const did = evt.did || evt.commit?.repo || '';
  const rkey = evt.commit?.rkey || evt.commit?.cid || '';
  const collection = evt.commit?.collection || 'app.bsky.feed.post';
  if(!did || !rkey) return null;
  return `at://${did}/${collection}/${rkey}`;
}

export class BlueskyFirehose {
  constructor(opts={}){
    this.endpoints = opts.endpoints || ENDPOINTS;
    this.idx = 0;
    this.ws = null;
    this.running = false;
    this.idleTimer = null;
    this.backoff = new Backoff({ baseMs: 1000, maxMs: 60_000, jitter: true });
    this.bucket = new TokenBucket({ capacity: envInt('BLUESKY_FIREHOSE_RPS', 20), refillPerSec: envInt('BLUESKY_FIREHOSE_RPS', 20) });
    this.seenAtUri = new LruSet(SEEN_DID_CACHE);
    this.recentLeads = new LruSet(2000);
    this.stats = { received:0, gated:0, leads:0, errors:0, reconnects:0 };
    this.ring = new RingBuffer(200);
    this.cursorUs = null;
  }

  async start(){
    if(this.running) return;
    if(!isConfigured()){
      integration.log?.('info', '[bluesky-firehose] disabled BLUESKY_FIREHOSE_ENABLED!=true');
      return;
    }
    this.running = true;
    this.cursorUs = await integration.getFirehoseCursor?.(CURSOR_KEY) ?? integration.getSetting?.(CURSOR_KEY) ?? null;
    // load persisted before loop
    this.loop();
  }

  async stop(){
    this.running = false;
    clearTimeout(this.idleTimer);
    try{ this.ws?.close(1000, 'shutdown'); }catch{}
    this.ws = null;
  }

  endpointUrl(){
    const base = this.endpoints[this.idx % this.endpoints.length];
    if(this.cursorUs){
      const u = String(BigInt(this.cursorUs) - BigInt(CURSOR_REWIND_US) > 0n ? BigInt(this.cursorUs) - BigInt(CURSOR_REWIND_US) : 0n);
      return base + `&cursor=${encodeURIComponent(u)}`;
    }
    return base;
  }

  async loop(){
    let consecutiveFails = 0;
    while(this.running){
      // respect live pressure — yield to ingestion
      if(integration.livePressure?.() > 0.85){
        await sleep(5000);
        continue;
      }
      const url = this.endpointUrl();
      try{
        await this.connectOnce(url);
        consecutiveFails = 0;
        this.backoff.reset();
      }catch(e){
        consecutiveFails++;
        this.stats.errors++;
        this.ring.push({ t: Date.now(), e: String(e).slice(0,300), url });
        integration.log?.('warn', `[bluesky-firehose] connect fail ${consecutiveFails} ${e.message} ${url}`);
        if(consecutiveFails >= MAX_DEPTH_RECONNECT){
          // rotate endpoint on tight failures
          this.idx = (this.idx+1) % this.endpoints.length;
          consecutiveFails = 0;
        }
        const delay = this.backoff.next();
        await sleep(delay);
        this.idx = (this.idx+1) % this.endpoints.length;
        this.stats.reconnects++;
      }
    }
  }

  async connectOnce(url){
    const WS = resolveWebSocket();
    if(!WS) throw new Error('ws missing: npm install ws');
    return new Promise((resolve, reject)=>{
      const ws = new WS(url, { handshakeTimeout: 15000 });
      this.ws = ws;
      let settled = false;
      let lastMsgAt = Date.now();

      const armIdle = ()=>{
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(()=>{
          try{ ws.terminate?.() || ws.close(); }catch{}
        }, IDLE_TIMEOUT_MS);
      };
      armIdle();

      ws.on('open', ()=> {
        integration.log?.('info', `[bluesky-firehose] open ${url} cursor=${this.cursorUs||0}`);
      });

      ws.on('message', async (data)=>{
        lastMsgAt = Date.now();
        armIdle();
        // ingress rate limit BEFORE any DID->handle HTTP
        if(!this.bucket.tryConsume(1)){
          this.stats.received++;
          // still advance cursor even when rate-limited — cursor = stream position
          try{
            const peek = safeJson(data);
            if(peek?.time_us) this.cursorUs = String(peek.time_us);
          }catch{}
          return;
        }
        await this.handleMessage(data);
      });

      ws.on('error', (err)=>{
        clearTimeout(this.idleTimer);
        if(!settled){ settled=true; reject(err); }
      });

      ws.on('close', (code, reason)=>{
        clearTimeout(this.idleTimer);
        // persist cursor on close
        if(this.cursorUs){
          integration.setFirehoseCursor?.(CURSOR_KEY, this.cursorUs).catch(()=>{});
          integration.setSetting?.(CURSOR_KEY, this.cursorUs).catch(()=>{});
        }
        if(!settled){
          settled=true;
          // treat clean close as reconnect case
          reject(new Error(`ws close ${code} ${String(reason).slice(0,100)}`));
        }
      });

      // watchdog extra: if no msg for IDLE_TIMEOUT, close handled above
    });
  }

  async handleMessage(raw){
    let evt;
    try{ evt = safeJson(raw); }catch{ return; }
    if(!evt || evt.kind !== 'commit') {
      // still advance cursor if present — even non-commit events track position
      if(evt?.time_us) {
        this.cursorUs = String(evt.time_us);
        if(this.stats.received % 500 === 0) integration.setFirehoseCursor?.(CURSOR_KEY, this.cursorUs).catch(()=>{});
      }
      return;
    }
    this.stats.received++;
    // ADVANCE CURSOR ON EVERY EVENT INCLUDING DISCARDED — tracks stream, not interest
    if(evt.time_us) this.cursorUs = String(evt.time_us);

    const record = evt.commit?.record;
    if(!record) return;
    // collection filter already via wantedCollections, but double-check
    if(evt.commit.collection !== 'app.bsky.feed.post') return;

    // GATE: adult self-label AND real media embed
    const adult = hasAdultSelfLabel(record);
    const media = hasRealMediaEmbed(record);
    if(!(adult && media)){
      return;
    }
    this.stats.gated++;

    const atUri = extractAtUri(evt);
    if(!atUri || this.seenAtUri.has(atUri)) return;
    this.seenAtUri.add(atUri);

    // dedupe lead by did+time bucket
    const leadKey = `${evt.did}:${record.text?.slice(0,40) || ''}`;
    if(this.recentLeads.has(leadKey)) return;

    // Optional DID->handle resolution — token-bucketed already, do not spend if under pressure
    // Integration shim resolves real symbol; if unbound it throws.
    const handle = await integration.resolveBskyHandle?.(evt.did).catch(()=>null) || evt.did;

    const lead = {
      source_module: 'bluesky-firehose',
      platform: 'bluesky',
      kind: 'post',
      url: `https://bsky.app/profile/${handle}/post/${evt.commit.rkey}`,
      at_uri: atUri,
      did: evt.did,
      handle,
      text: (record.text || '').slice(0,600),
      time_us: this.cursorUs,
      evidence_json: JSON.stringify({ adultLabel: true, hasMedia: true, via: 'jetstream', time_us: this.cursorUs }),
    };

    // Leads only — never auto-follow, never media rows
    try{
      await integration.addLead?.(lead) ?? integration.addDiscoveryLead?.(lead) ?? integration.enqueueLead?.(lead);
      this.recentLeads.add(leadKey);
      this.stats.leads++;
      if(this.stats.leads % 100 === 0){
        integration.log?.('info', `[bluesky-firehose] leads=${this.stats.leads} received=${this.stats.received} gated=${this.stats.gated}`);
      }
    }catch(e){
      // integration not bound yet — loud fail per shim design
      integration.log?.('error', `[bluesky-firehose] addLead UNBOUND ${e.message}`);
      throw e;
    }

    // periodic cursor persist (not every event to avoid SQLite pressure)
    if(this.stats.received % 200 === 0 && this.cursorUs){
      integration.setFirehoseCursor?.(CURSOR_KEY, this.cursorUs).catch(()=>{});
    }
  }

  getStats(){ return { ...this.stats, cursorUs: this.cursorUs, endpoint: this.endpointUrl() }; }
}

let singleton = null;
export function start(opts){ singleton = new BlueskyFirehose(opts); return singleton.start(); }
export function stop(){ return singleton?.stop(); }
export default BlueskyFirehose;
