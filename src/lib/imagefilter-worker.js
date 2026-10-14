'use strict';
/**
 * Worker thread: owns one copy of the face model. Protocol: {type:'detect', id, buffer, body} -> {id, result: {faces, body}} | {id, error};
 * {type:'embed', id, buffer} -> {id, result: Uint8Array (lib/embeddings pack)} | {id, error}.
 */
const { parentPort } = require('worker_threads');
const { createModel } = require('./imagefilter-core');

// Background work: on Linux a thread has its own nice value, so this lowers only THIS worker (default 10, IMAGE_NICE=0 to keep
// normal priority). On a small server the model then soaks up spare CPU while page loads and the API never wait behind it.
try { require('os').setPriority(0, Math.min(19, Math.max(0, parseInt(process.env.IMAGE_NICE ?? '10', 10) || 0))); } catch { /* not permitted: harmless */ }

let model = null;
const ready = createModel().then((m) => { model = m; parentPort.postMessage({ type: 'ready', info: m.info }); }, (e) => { parentPort.postMessage({ type: 'failed', error: String(e.message || e) }); });

parentPort.on('message', async (msg) => {
  if (!msg || (msg.type !== 'detect' && msg.type !== 'embed')) return;
  await ready;
  if (!model) return parentPort.postMessage({ id: msg.id, error: 'model unavailable' });
  try {
    if (msg.type === 'embed') { const v = await model.embed(Buffer.from(msg.buffer)); return parentPort.postMessage({ id: msg.id, result: new Uint8Array(v) }); }
    parentPort.postMessage({ id: msg.id, result: await model.detect(Buffer.from(msg.buffer), { body: !!msg.body }) });
  }
  catch (e) { parentPort.postMessage({ id: msg.id, error: String(e.message || e).slice(0, 160) }); }
});
