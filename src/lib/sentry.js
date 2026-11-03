'use strict';

let sdk;

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
    beforeSend: event => ({ event_id: event.event_id, timestamp: event.timestamp, level: 'error',
      platform: 'node', environment, release, message: 'Unhandled HTTP server error' }),
  });
}

// Do not pass the error, request, or route to the SDK: any can contain media or identifiers.
function captureHttpError(err, req) {
  const status = Number(err?.status || err?.statusCode || 500);
  if (!sdk || (status >= 400 && status < 500) || req?.aborted || err?.code === 'ECONNRESET' || err?.name === 'AbortError') return;
  try { sdk.captureMessage('Unhandled HTTP server error', 'error'); } catch { /* reporting must not affect the response */ }
}

module.exports = { init, captureHttpError };
