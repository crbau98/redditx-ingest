'use strict';
/**
 * Safety gate applied to everything before it can be stored or shown.
 *
 *   block  -> never ingested. Anything suggesting the person depicted may be
 *             under 18 (explicit terms, or an age < 18 stated in text).
 *   review -> held in the moderation queue instead of being published.
 *
 * The goal is a conservative, cheap, explainable filter that runs on titles,
 * tags, community names, handles, bios and alt text. It deliberately errs on
 * the side of dropping an item: a false positive costs one post, a false
 * negative is unacceptable.
 */

const BLOCK_RULES = [
  ['underage', /\bunder\s?-?\s?age(?:d)?\b/],
  ['under18', /\bunder\s?-?\s?(?:18|eighteen)\b/],
  ['jailbait', /\bjail\s?-?bait\b/],
  ['loli', /\blol(?:i|icon|is)\b/],
  ['shota', /\bshota(?:con)?\b/],
  ['pedo', /\bp(?:a)?edo(?:phil(?:e|ia))?s?\b/],
  ['preteen', /\bpre\s?-?\s?teens?\b/],
  ['csam', /\b(?:csam|pthc|ptsc)\b/],
  ['child', /\bchild(?:ren)?\b/],
  ['kid', /\bkids?\b/],
  ['toddler', /\b(?:toddlers?|infants?|newborns?)\b/],
  ['minor', /\bminors?\b/],
  ['schoolboy', /\bschool\s?-?\s?(?:boys?|kids?|children)\b/],
  ['middleschool', /\b(?:middle|junior|primary|elementary)\s?-?\s?school\b/],
  ['cp-term', /\bcp\s?(?:video|vid|pics?|links?|trade)\b/],
  // "I'm 15", "age 16", "aged 12" — but not heights/measurements (I'm 6'2, I'm 8 inches)
  ['stated-age', /\b(?:i\s?am|i['’]?m|im|age[d]?|aged)\s*:?\s*(?:[1-9]|1[0-7])\b(?![\d'’"′″.]|\s*(?:cm|mm|in\b|inch|inches|ft|feet|foot|lbs?|kg|%|x\b))/],
  // "16yo", "15 y/o", "14 years old"
  ['stated-age', /\b(?:[1-9]|1[0-7])[-\s]?(?:yo|y\/o|y\.o\.?|yrs?[-\s]?old|years?[-\s]?old)\b/],
  // spelled out: "i'm sixteen", "fifteen years old", "13 yo" handled above
  ['stated-age-word', /\b(?:i\s?am|i['’]?m|im|age[d]?)\s*:?\s*(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)\b/],
  ['stated-age-word', /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)[-\s]?(?:yo|y\/o|years?[-\s]old|yrs?[-\s]old)\b/],
  // reddit-style tags: [M17] (16m) [f15]
  ['tagged-age', /[\[(]\s*(?:[mfxt]\s?(?:[1-9]|1[0-7])|(?:[1-9]|1[0-7])\s?[mfxt])\s*[\])]/],
];

const REVIEW_RULES = [
  ['teen', /\bteen(?:s|age|ager|agers|aged)?\b/],
  ['highschool', /\bhigh\s?-?\s?school(?:er|ers)?\b/],
  ['barely-legal', /\bbarely\s?-?\s?legal\b/],
  ['just-18', /\bjust\s?turned\s?(?:18|eighteen)\b/],
  ['young-boy', /\byoung\s?(?:boys?|lads?)\b/],
  ['freshman', /\bfreshm[ae]n\b/],
];

/** Fold case, strip zero-width/diacritics and collapse whitespace. */
function normalize(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ​-‏⁠﻿]/g, '')
    .toLowerCase()
    // `_` is a regex word character, so "lol_underage" would hide a term from \b. Usernames are
    // routinely underscore-joined; treat it as the separator it is.
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ');
}

function firstMatch(rules, text) {
  for (const [name, re] of rules) if (re.test(text)) return name;
  return null;
}

/**
 * @param {...(string|string[]|null|undefined)} parts any texts attached to an item
 * @returns {{level: 'block'|'review'|null, rule: string|null}}
 */
function checkText(...parts) {
  const text = normalize(parts.flat(Infinity).filter(Boolean).join(' \n '));
  if (!text) return { level: null, rule: null };
  const hardRule = firstMatch(BLOCK_RULES, text);
  if (hardRule) return { level: 'block', rule: hardRule };
  const softRule = firstMatch(REVIEW_RULES, text);
  if (softRule) return { level: 'review', rule: softRule };
  return { level: null, rule: null };
}

/** Run the gate over a normalised ingest item plus its creator metadata. */
function checkItem(item) {
  return checkText(
    item.title, item.text, item.altText, item.community, item.author,
    item.authorName, item.authorBio, item.tags, item.labels, item.query,
  );
}

module.exports = { checkText, checkItem, normalize };
