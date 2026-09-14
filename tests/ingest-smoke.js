process.env.DB_PATH = process.env.SMOKE_DB_PATH || '/tmp/prism-of-smoke.db';
process.env.CRON_ENABLED = 'false';

const fs = require('fs');
const assert = require('assert');

try { fs.unlinkSync(process.env.DB_PATH); } catch { /* fresh */ }
try { fs.unlinkSync(process.env.DB_PATH + '-wal'); } catch { /* ok */ }
try { fs.unlinkSync(process.env.DB_PATH + '-shm'); } catch { /* ok */ }

const ingestion = require('../services/ingestion');
const { hostBlocked } = require('../services/media-quality');

assert.ok(hostBlocked('onlyfans.com'));

async function main() {
  const result = await ingestion.runIngestion({
    queryPack: 'onlyfans',
    sources: ['redgifs'],
    redgifsQueries: ['gay muscle'],
    redgifsUsers: [],
    creatorQueries: [],
    limit: 6,
    sweep: false,
  });
  if (result && result.ok === false) {
    throw new Error(result.msg || 'ingest refused to start');
  }
  const state = ingestion.getState();
  assert.ok(!state.ingesting, 'ingest should finish');
  const logs = ingestion.getLogs().map((l) => l.msg).join('\n');
  assert.ok(!/https?:\/\/(www\.)?onlyfans\.com\/+/i.test(logs), 'logs must not fetch onlyfans.com URLs');
  console.log('ingest-smoke.js ok', {
    newItems: state.lastOutcome?.newItems ?? state.stats.total,
    skipped: state.stats.skipped,
    db: process.env.DB_PATH,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
