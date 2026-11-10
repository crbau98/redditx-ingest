'use strict';
/** GFF discovery reads JustTheGays' open lists first; the gayforfans.com directory is only a fallback. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const http = require('../src/sources/http');
const calls = [];
let lists = true;
http.forPlatform = () => ({ text: async (url) => {
  calls.push(url);
  if (url.includes('justthegays.tv/p7103/latest') && lists) return '<a href="/performer/jake-stone-a1b2">#1 Jake Stone</a><a href="/video/some-video-1234">v</a>';
  if (url.includes('justthegays.tv/p')) return '<html></html>';
  if (url.startsWith('https://gayforfans.com/performer')) return '<a href="/performer/mark-hill-c3d4">Mark Hill</a>';
  throw Object.assign(new Error('unexpected'), { status: 404 });
} });
const repo = require('../src/db/repo');
const discovery = require('../src/engine/discovery');

test('the walk follows a performer from a JustTheGays list and skips the gayforfans directory', async () => {
  const r = await discovery.gffDiscovery({ coomerLimit: 0 });
  assert.equal(r.followed, 1);
  assert.ok(calls.some((u) => u.includes('justthegays.tv/p7103/latest')));
  assert.ok(!calls.some((u) => u.startsWith('https://gayforfans.com/performer')), 'gayforfans directory not walked');
  assert.ok(repo.feeds.find('gff', 'user', 'https://justthegays.tv/performer/jake-stone-a1b2'));
});

test('when JustTheGays yields nobody new, the gayforfans directory is walked as the fallback', async () => {
  calls.length = 0;
  lists = false;
  const r = await discovery.gffDiscovery({ coomerLimit: 0, pages: 1 });
  assert.ok(calls.some((u) => u.startsWith('https://gayforfans.com/performer')));
  assert.equal(r.followed, 1);
});
