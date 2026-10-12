#!/usr/bin/env node
'use strict';
/**
 * One-time Telegram login for PRISM (reads every channel your account has joined).
 *
 *   docker compose -f deploy/docker-compose.yml run --rm prism node scripts/telegram-login.js      (on the server)
 *   node scripts/telegram-login.js                                                                  (anywhere with the repo)
 *
 * Needs TELEGRAM_API_ID and TELEGRAM_API_HASH (my.telegram.org -> API development tools) in the environment, or it asks.
 * Telegram sends a login code to your Telegram app; if the account has two-step verification you also enter that password.
 * The session is written to <data dir>/telegram.session (mode 600) and PRISM picks it up on its next start/sync.
 * Add --print to also print the session string (for TELEGRAM_SESSION). Treat it like a password: it IS your account.
 *
 * Nothing you type is stored anywhere except the session file; the password and the hash are never written to disk.
 */
const readline = require('readline');
const config = require('../src/config');
const mt = require('../src/lib/telegram-mtproto');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));
/** Prompt without echoing what is typed. */
function askHidden(q) {
  return new Promise((resolve) => {
    const out = rl.output; const write = rl._writeToOutput;
    process.stdout.write(q);
    rl._writeToOutput = () => {};
    rl.question('', (a) => { rl._writeToOutput = write; out.write('\n'); resolve(a.trim()); });
  });
}

(async () => {
  let apiId = config.telegram.apiId; let apiHash = config.telegram.apiHash;
  try { require.resolve('telegram'); } catch { console.error('The "telegram" package is not installed: run npm install'); process.exit(1); }
  if (!apiId) apiId = parseInt(await ask('Telegram api_id (number from my.telegram.org): '), 10);
  if (!apiHash) apiHash = await askHidden('Telegram api_hash (hidden): ');
  if (!apiId || !apiHash) { console.error('api_id and api_hash are required.'); process.exit(1); }

  const { TelegramClient } = require('telegram');
  const { StringSession } = require('telegram/sessions');
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5, deviceModel: 'PRISM', appVersion: config.version });
  client.setLogLevel('error');
  await client.start({
    phoneNumber: () => ask('Phone number with country code (+15551234567): '),
    phoneCode: () => ask('Code Telegram sent to your Telegram app / SMS: '),
    password: () => askHidden('Two-step verification password (hidden): '),
    onError: (e) => console.error(`  ${e.message}`),
  });
  const me = await client.getMe();
  const session = client.session.save();
  mt.saveSession(session);
  console.log(`\nLogged in as ${[me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || me.id}${me.username ? ` (@${me.username})` : ''}.`);
  console.log(`Session saved to ${mt.SESSION_FILE()} (mode 600).`);
  if (process.argv.includes('--print')) console.log(`\nTELEGRAM_SESSION=${session}\n(keep this secret: it grants full access to the account)`);
  console.log('Next: restart PRISM or press "Sync joined channels" on Admin → Sources → Telegram.');
  await client.disconnect(); rl.close();
  process.exit(0);
})().catch((e) => { console.error(`Login failed: ${e.errorMessage || e.message}`); process.exit(1); });
