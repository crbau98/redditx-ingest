'use strict';
/**
 * The AI provider switch. Everything that asks a model for structured JSON (engine/ai.js, the admin and public routes)
 * goes through here, and AI_PROVIDER picks who answers: 'openai' (default, lib/openai.js) or 'anthropic' (lib/claude.js).
 * The contract is the same for both: json(purpose, {system, input, schema, effort, ...}) with an explicit effort, a daily
 * budget shared across providers, an answer cache, "refusal = no answer" (an error with .refusal), and off without a key.
 *
 * Web search is the one Claude-only job (Claude's server-side web search tool). It stays on lib/claude.js and is offered
 * as a search provider only when ANTHROPIC_API_KEY is set, whichever provider is selected: see lib/websearch.js.
 */
const config = require('../config');
const claude = require('./claude');
const openai = require('./openai');

const impl = () => (config.ai.provider === 'anthropic' ? claude : openai);
const provider = () => config.ai.provider;
const label = () => (provider() === 'anthropic' ? 'Claude' : 'OpenAI');
const model = () => (provider() === 'anthropic' ? config.anthropic.model : config.openai.model);
const keyName = () => (provider() === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');

function status() {
  return { ...impl().status(), provider: provider(), label: label(), model: model(), keyName: keyName() };
}

module.exports = {
  provider, label, model, keyName, status,
  configured: () => impl().configured(),
  json: (purpose, opts) => impl().json(purpose, opts),
  usage: () => impl().usage(),
  budgetLeft: () => impl().budgetLeft(),
  _reset: () => { claude._reset(); },
};
