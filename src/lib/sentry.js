'use strict';

let sdk;
const kinds = new Set(['http', 'uncaught', 'rejection']);
const types = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError']);
const areas = new Set(['routes', 'engine', 'services', 'db', 'middleware', 'lib']);

// Output consists exclusively of fixed allowlisted words, regardless of error content.
function diagnostic(kind, err) {
  const type = types.has(err?.name) ? err.name : 'Other';
  const match = typeof err?.stack === 'string' && err.stack.match(/(?:^|[(/\\])src[\\/](routes|engine|services|db|middleware|lib)[\\/]/m);
  const area = match && areas.has(match[1]) ? match[1] : 'other';
  return `PRISM ${kinds.has(kind) ? kind : 'other'} ${type} ${area}`;
}

function init(env = process.env, client) {
  if (!env.SENTRY_DSN) return;
  sdk = client || require('@sentry/node');
  const environment = env.RAILWAY_ENVIRONMENT_NAME || env.NODE_ENV || 'development';
  const release = env.RAILWAY_GIT_COMMIT_SHA || undefined;
  sdk.init({
    dsn: env.SENTRY_DSN,
    environment,
    release,
    sendDefaultPii: false,
    defaultIntegrations: false,
    sampleRate: 0.1,
    tracesSampleRate: 0,
    beforeSend: event => {
      const message = typeof event.message === 'string' && /^PRISM (http|uncaught|rejection) (Error|TypeError|RangeError|SyntaxError|ReferenceError|Other) (routes|engine|services|db|middleware|lib|other)$/.test(event.message)
        ? event.message : 'PRISM error';
      return { event_id: event.event_id, timestamp: event.timestamp, level: 'error', platform: 'node', environment, release, message };
    },
  });
}

// Do not pass the error, request, or route to the SDK: any can contain media or identifiers.
function captureHttpError(err, req) {
  const status = Number(err?.status || err?.statusCode || 500);
  if (!sdk || (status >= 400 && status < 500) || req?.aborted || err?.code === 'ECONNRESET' || err?.name === 'AbortError') return;
  capture('http', err);
}

function capture(kind, err) {
  if (!sdk || !kinds.has(kind) || err?.code === 'ECONNRESET' || err?.name === 'AbortError') return;
  try { sdk.captureMessage(diagnostic(kind, err), 'error'); } catch { /* reporting must not affect the app */ }
}

module.exports = { init, captureHttpError, capture };
