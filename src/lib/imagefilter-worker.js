'use strict';
/** Worker thread: owns one copy of the face model. Protocol: {type:'detect', id, buffer} -> {id, faces} | {id, error}. */
const { parentPort } = require('worker_threads');
const { createModel } = require('./imagefilter-core');

let model = null;
const ready = createModel().then((m) => { model = m; parentPort.postMessage({ type: 'ready', info: m.info }); }, (e) => { parentPort.postMessage({ type: 'failed', error: String(e.message || e) }); });

parentPort.on('message', async (msg) => {
  if (!msg || msg.type !== 'detect') return;
  await ready;
  if (!model) return parentPort.postMessage({ id: msg.id, error: 'model unavailable' });
  try { parentPort.postMessage({ id: msg.id, faces: await model.detect(Buffer.from(msg.buffer)) }); }
  catch (e) { parentPort.postMessage({ id: msg.id, error: String(e.message || e).slice(0, 160) }); }
});
