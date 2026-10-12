'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.INTERNAL_HOSTS = 'searxng, Metrics.Internal';
const net = require('../src/lib/net');

test('INTERNAL_HOSTS exempts exact vouched names only; everything else stays SSRF-guarded', () => {
  assert.equal(net.isPrivateHost('searxng'), false);
  assert.equal(net.isPrivateHost('metrics.internal'), false, 'case-insensitive; also beats the .internal suffix rule');
  assert.equal(net.isPrivateHost('localhost'), true);
  assert.equal(net.isPrivateHost('evil.searxng.example.internal'), true);
  assert.equal(net.isPrivateHost('127.0.0.1'), true);
  assert.equal(net.isPrivateHost('10.0.0.5'), true);
});
