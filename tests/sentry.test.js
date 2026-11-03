'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('Sentry is off without a DSN', () => {
  const path = require.resolve('../src/lib/sentry');
  delete require.cache[path];
  const sentry = require(path);
  let calls = 0;
  sentry.init({}, { init() { calls++; } });
  sentry.captureHttpError(new Error('private'), {});
  assert.equal(calls, 0);
});

test('Sentry sends only a fixed event and ignores expected errors', () => {
  const path = require.resolve('../src/lib/sentry');
  delete require.cache[path];
  const sentry = require(path);
  let options, messages = [];
  sentry.init({ SENTRY_DSN: 'configured', RAILWAY_ENVIRONMENT_NAME: 'staging', RAILWAY_GIT_COMMIT_SHA: 'abc' }, {
    init(value) { options = value; },
    captureMessage(...args) { messages.push(args); },
  });
  for (const [err, req] of [[{ status: 404 }, {}], [{ code: 'ECONNRESET' }, {}], [{ name: 'AbortError' }, {}], [{}, { aborted: true }]]) sentry.captureHttpError(err, req);
  assert.equal(messages.length, 0);
  sentry.captureHttpError(new Error('private media token'), { headers: { authorization: 'secret' }, url: '/foo?token=secret' });
  assert.deepEqual(messages, [['PRISM http Error other', 'error']]);
  const event = options.beforeSend({ event_id: 'id', timestamp: 123, request: { data: 'private' }, exception: { values: [{ value: 'secret' }] }, breadcrumbs: ['secret'] });
  assert.deepEqual(event, { event_id: 'id', timestamp: 123, level: 'error', platform: 'node', environment: 'staging', release: 'abc', message: 'PRISM error' });
  const err = new TypeError('PRIVATE_MEDIA_SENTINEL');
  err.stack = 'TypeError: PRIVATE_MEDIA_SENTINEL\n    at /app/src/engine/private-token.js:1:2';
  sentry.capture('uncaught', err);
  sentry.capture('rejection', err);
  sentry.capture('PRIVATE_TOKEN_SENTINEL', err);
  assert.deepEqual(messages.slice(1), [['PRISM uncaught TypeError engine', 'error'], ['PRISM rejection TypeError engine', 'error']]);
  assert.equal(options.sendDefaultPii, false);
  assert.equal(options.defaultIntegrations, false);
  assert.equal(options.tracesSampleRate, 0);
  assert.equal(options.sampleRate, 0.1);
  assert.equal(options.environment, 'staging');
  assert.equal(options.release, 'abc');
});

test('real SDK envelope contains no supplied private data', async () => {
  const path = require.resolve('../src/lib/sentry');
  delete require.cache[path];
  const sentry = require(path);
  const sdk = require('@sentry/node');
  const envelopes = [];
  sentry.init({ SENTRY_DSN: 'https://public@example.invalid/1', RAILWAY_ENVIRONMENT_NAME: 'test', RAILWAY_GIT_COMMIT_SHA: 'abc' }, {
    init(options) {
      sdk.init({ ...options, sampleRate: 1, transport: () => ({
        send(envelope) { envelopes.push(envelope); return Promise.resolve({ statusCode: 200 }); },
        flush() { return Promise.resolve(true); },
      }) });
    },
    captureMessage: sdk.captureMessage,
  });
  sentry.captureHttpError(new Error('PRIVATE_MEDIA_SENTINEL'), { headers: { authorization: 'PRIVATE_AUTH_SENTINEL' }, url: '/?token=PRIVATE_TOKEN_SENTINEL' });
  assert.equal(await sdk.flush(2000), true);
  assert.equal(envelopes.length, 1);
  const output = JSON.stringify(envelopes[0]);
  assert.doesNotMatch(output, /PRIVATE_(MEDIA|AUTH|TOKEN)_SENTINEL/);
  assert.match(output, /PRISM http Error other/);
  assert.match(output, /"release":"abc"/);
  assert.match(output, /"environment":"test"/);
  await sdk.close(2000);
});
