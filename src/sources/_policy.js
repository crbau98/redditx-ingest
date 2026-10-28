'use strict';
// src/sources/_policy.js - paywall and leak-aggregator gate
// Central policy gate. Registrable-suffix match: foo.onlyfans.com -> onlyfans.com
const PAYWALL_SUFFIXES = new Set([
  'onlyfans.com','fansly.com','justfor.fans','justforfans.com','loyalfans.com',
  'manyvids.com','clip4sale.com','fanvue.com','admireme.vip','unlockd.me',
  'my.club','only4fans.com','frisk.chat','mypriv.com','fanplace.com',
  'fansmetrics.com','subscribestar.adult','patreon.com','ko-fi.com',
  'buymeacoffee.com','gumroad.com','fancentro.com','apclips.com',
  'sextpanther.com','nightflirt.de','big7.com','adultwork.com',
  'awempire.com','camsoda.com','chaturbate.com'
]);
const LEAK_SUFFIXES = new Set([
  'coomer.su','coomer.party','kemono.su','kemono.party','bitchesgirls.com',
  'thothub.to','thotporn.pics','leakedonlyfans.com','onlyfansleaks.com',
  'fanleaks.cc','leaktape.com','fapello.com','fapello.su','influencersgonewild.com',
  'gotanypic.com','internetchicks.com','nsfw247.to','prothots.com',
  'hotleaks.tv','leaksparadise.com','leaknudes.com','thefap.com',
  'nudostar.com','erothots.co','dirtyship.com'
]);

function normHost(h){ return String(h||'').toLowerCase().trim().replace(/\.$/,''); }
function matchesSuffix(host, set){
  const h = normHost(host);
  if(set.has(h)) return true;
  for(const s of set) if(h === s || h.endsWith('.'+s)) return true;
  return false;
}
function isPaywall(host){ return matchesSuffix(host, PAYWALL_SUFFIXES); }
function isLeakAggregator(host){ return matchesSuffix(host, LEAK_SUFFIXES); }
function isDenied(host){ return isPaywall(host) || isLeakAggregator(host); }
function isExtractorAllowed(host){ return !isDenied(host); }

module.exports = { isPaywall, isLeakAggregator, isDenied, isExtractorAllowed };
