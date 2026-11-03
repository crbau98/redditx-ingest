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
  assert.deepEqual(messages, [['Unhandled HTTP server error', 'error']]);
  const event = options.beforeSend({ event_id: 'id', timestamp: 123, request: { data: 'private' }, exception: { values: [{ value: 'secret' }] }, breadcrumbs: ['secret'] });
  assert.deepEqual(event, { event_id: 'id', timestamp: 123, level: 'error', platform: 'node', environment: 'staging', release: 'abc', message: 'Unhandled HTTP server error' });
  assert.equal(options.sendDefaultPii, false);
  assert.equal(options.defaultIntegrations, false);
  assert.equal(options.tracesSampleRate, 0);
  assert.equal(options.sampleRate, 0.1);
  assert.equal(options.environment, 'staging');
  assert.equal(options.release, 'abc');
});
