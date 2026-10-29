'use strict';
/**
 * Which browser reads JavaScript-built pages. Two engines share one contract (renderPages -> {via, pages, notes}):
 *
 *   browser4     lib/browser4.js, the browser4-cli (BROWSER4_ENABLED=1)
 *   playwright   lib/playwright.js, in-process Chromium behind PRISM's guard proxy (PLAYWRIGHT_ENABLED=1)
 *
 * RENDER_ENGINE picks one; the default `auto` uses Browser4 when it is enabled, otherwise Playwright. Callers (the web
 * and link-in-bio adapters, site expansion) only ever talk to this module.
 */
const config = require('../config');
const browser4 = require('./browser4');
const playwright = require('./playwright');

const ENGINES = { browser4, playwright };

function engineName() {
  if (config.renderEngine === 'browser4' || config.renderEngine === 'playwright') return config.renderEngine;
  if (browser4.enabled()) return 'browser4';
  if (playwright.enabled()) return 'playwright';
  return 'browser4'; // nothing enabled: Browser4's "not enabled" answers stand
}
const engine = () => ENGINES[engineName()];

module.exports = {
  engineName,
  enabled: () => engine().enabled(),
  renderPages: (url, opts) => engine().renderPages(url, opts),
  assertAllowed: browser4.assertAllowed,
  sameSite: browser4.sameSite,
  available: () => engine().available(),
  /** Both engines, and which one is in use. */
  async status() {
    const [b4, pw] = await Promise.all([browser4.status(), playwright.status()]);
    return { engine: engineName(), setting: config.renderEngine, browser4: b4, playwright: pw };
  },
  close: () => Promise.all([browser4.close(), playwright.close()]),
};
