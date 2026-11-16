'use strict';
/**
 * Worker side of lib/markup-preflight: builds the tree with the SAME parser the main thread uses (cheerio / parse5) and reports
 * its size, so the main thread never builds a tree the parser itself finds expensive. Shared memory, Int32 slots:
 *   [0] state: 0 = working, 1 = done, 2 = the parser threw, 3 = ready (after start-up)
 *   [1] elements   [2] deepest nesting
 */
const { parentPort, workerData } = require('worker_threads');
const cheerio = require('cheerio');

const i32 = new Int32Array(workerData.sab);

parentPort.on('message', ({ text, kind }) => {
  try {
    const $ = kind === 'fragment' ? cheerio.load(`<div>${text}</div>`, null, false) : cheerio.load(text);
    let elements = 0; let deepest = 0;
    // iterative: a deep tree must not overflow the stack here either
    const nodes = [$.root()[0]]; const depths = [0];
    while (nodes.length) {
      const n = nodes.pop(); const d = depths.pop();
      const isEl = n.type === 'tag' || n.type === 'script' || n.type === 'style';
      if (isEl) { elements++; if (d > deepest) deepest = d; }
      const ch = n.children;
      if (ch) for (let i = 0; i < ch.length; i++) { nodes.push(ch[i]); depths.push(isEl ? d + 1 : d); }
    }
    Atomics.store(i32, 1, Math.min(elements, 0x7fffffff));
    Atomics.store(i32, 2, Math.min(deepest, 0x7fffffff));
    Atomics.store(i32, 0, 1);
  } catch {
    Atomics.store(i32, 0, 2);
  }
  Atomics.notify(i32, 0);
});

Atomics.store(i32, 0, 3);
Atomics.notify(i32, 0);
