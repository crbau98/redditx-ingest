'use strict';
/**
 * Scope classifier: is this a post about / by a man?
 *
 * PRISM is for male creators only. Female and feminine / trans-feminine
 * content must never be published, so the policy is deliberately strict and
 * errs on the side of dropping a borderline male post:
 *
 *   HARD  female / feminine / trans vocabulary, f4m-style tags, [F] tags, she/her ...
 *         -> 'excluded' ALWAYS: whatever else the text says and however much the feed is trusted.
 *   SOFT  words that also occur in gay-male posts ("pussy", "tits", "wife", "babe") or that are
 *         merely feminine-adjacent (lingerie, heels, makeup, non-binary ...)
 *         -> 'uncertain' + femaleSoft: always held for a human (review queue), even on trusted
 *            feeds and even when the "unclear scope" setting is open.
 *   no hit: a trusted feed accepts the item; an untrusted feed needs a positive male signal.
 *
 * Feeds come in two trust levels:
 *   - trusted   (curated communities, creators an admin or the discovery pipeline vouched for)
 *   - untrusted (open searches / hashtags): a positive male signal is required, otherwise 'uncertain'.
 */
const { normalize } = require('./safety');
const { findPaidHandles } = require('./paid');

// Whole-word male signals, two strengths.
//   STRONG  words that say "this is about men" and that female-focused posts do not use for themselves.
//   WEAK    anatomy / relationship words ("cock", "bulge", "boyfriend", "abs"): female and straight-couple posts use
//           them constantly, so on their own they never make an item male-focused for an open (untrusted) feed.
const MALE_STRONG = new RegExp(
  '\\b(?:gay[a-z0-9]*|male|males|men|man|manly|guy|guys|dude|dudes|twinks?|bears?|otters?|jocks?|jockstraps?|daddy|daddies|hunks?|' +
  'm4m|m4a|mlm|dilf|dilfs|hombres?|homme|hommes|homem|homens|maenner|schwul|gai|gei|bofe|hairy men|menofmastodon|malenude|' +
  'justfor\\.?fans|he\\s*\\/\\s*him|his\\s*\\/\\s*him|gym\\s*(?:bros?|lads?|guys?)|frat\\s*(?:boys?|bros?|guys?)|' +
  'muscle\\s*(?:gods?|cubs?|bulls?|studs?|boys?|pups?|bros?|lads?))\\b' +
  '|[\\[(]\\s*m\\s*[\\])]',
);
const MALE_WEAK = /\b(?:cocks?|dicks?|bulges?|abs|pecs|beard|bearded|bf|boyfriend|husband|hubby|hung|studs?|bros?|boys?|lads?|dads?|muscles?|muscular)\b/;
const MALE = new RegExp(`${MALE_STRONG.source}|${MALE_WEAK.source}`);
// CJK / Cyrillic male words are matched as substrings (no word boundaries exist). Female terms are checked
// first, so 男女 / 男の娘 never reach this list. Patterns go through normalize() exactly like the text does
// (NFKD splits kana dakuten and Hangul syllables).
const MALE_SUBSTR = ['ゲイ', 'ガチムチ', '筋肉', 'メンズ', '게이', '남자', 'гей', 'мужчин', 'парн', '男'].map(normalize);

/* --------------------------------------------------------------------------------- HARD */
// Matched anywhere in the text (no word boundaries): long, distinctive words that are safe inside
// glued handles such as "femboy_uwu", "SexyGirl92" or "tgirlsofx".
const HARD_SUBSTR = [
  'shemale', 'tranny', 'trannie', 'trannies', 'ladyboy', 'lady boy', 'kathoey', 'newhalf', 'new half',
  'tgirl', 't girl', 'transgirl', 'transwoman', 'transwomen', 'transgender', 'transsexual', 'transfem', 'transfeminine',
  'femboy', 'femboi', 'femboys', 'sissy', 'sissies', 'sissification', 'feminiz', 'feminis', 'feminin', 'crossdress', 'cross dress', 'crossdresser',
  'drag queen', 'dragqueen', 'drag race', 'futanari', 'bimbo', 'girly', 'girlish', 'ladylike', 'effeminate',
  'girl', 'woman', 'women', 'female', 'lesbian', 'hotwife', 'dominatrix', 'actress', 'stepmom', 'stepsister', 'stepdaughter', 'daughter',
  'vagina', 'vulva', 'labia', 'clitoris', 'bride',
  // other languages (NFKD-normalised, accents removed)
  'mujer', 'chica', 'senora', 'novia', 'esposa', 'mulher', 'garota', 'menina', 'novinha', 'madchen', 'frauen',
  'девушк', 'женщин', 'девочк', 'школьниц',
  // CJK / Thai / Korean
  '女', '娘', '妻', '母', '姉', '妹', 'ニューハーフ', '男の娘', 'おっぱい', '巨乳', '熟女', '美女', '彼女', '少女', '人妻', '女装', 'ふたなり',
  '여자', '여성', '소녀', '트랜스', 'ผู้หญิง', 'สาว', 'กะเทย',
].map(normalize);
// Whole-word hard terms: short or common-substring words.
const HARD_WORDS = new RegExp(
  '\\b(?:' + [
    'ts', 'trans', 'ftm', 'lady', 'ladies', 'gal', 'gals', 'milf', 'milfs', 'gilf', 'wife', 'wives', 'wifey', 'girlfriend', 'girlfriends', 'gf',
    'mommy', 'mom', 'moms', 'mother', 'mama', 'sister', 'aunt', 'niece', 'bbw', 'pawg', 'boobs', 'boob', 'busty', 'breasts?',
    'she', 'her', 'hers', 'herself', 'fems', 'femme', 'fille', 'filles', 'frau', 'chicas', 'fem', 'femmes', 'mistress',
    'straight couple', 'girl on girl', 'cuckquean', 'preggo', 'pregnant', 'transmen', 'transman', 'nonbinary',
  ].join('|') + ')\\b',
);
// Orientation tags: anything that involves an f or t partner (m4f, f4m, mf, mmf, m/f ...).
const HARD_TAGS = /\b(?:[fta]4[a-z]|[mfa]4[ft]|m\s?\/\s?f|f\s?\/\s?[mf]|mf|fm|mmf|mff|ffm|fmm|mfm|fmf|ffmm|mmff|mtf)\b/;
// [F] [f25] (25f) [t] ...
const HARD_BRACKET = /[\[(]\s*(?:[ft]\s?[\/ ]?\s?\d{1,2}|\d{1,2}\s?[\/ ]?\s?[ft]|[ft])\b[^\])]{0,24}[\])]/;

/* --------------------------------------------------------------------------------- SOFT */
// Words that gay-male posts also use, or that are feminine-adjacent: never published without a human.
const SOFT = new RegExp(
  '\\b(?:pussy|pussies|cunts?|tits|titties|babe|babes|princess|goddess|cuck|cuckold|trap|bikini|lingerie|panties|panty|stockings|heels|makeup|wig|skirt|' +
  'enby|genderfluid|genderqueer|non binary|they them|boipussy|manpussy|thot)\\b' +
  '|non-binary',
);

/** Words (not rules) -> readable reason. */
function firstHit(text) {
  for (const w of HARD_SUBSTR) if (text.includes(w)) return `female:${w.trim()}`;
  let m = text.match(HARD_WORDS); if (m) return `female:${m[0]}`;
  m = text.match(HARD_TAGS); if (m) return `female:${m[0]}`;
  m = text.match(HARD_BRACKET); if (m) return `female:${m[0]}`;
  return null;
}

const toText = (texts) => normalize([].concat(texts || []).flat(Infinity).filter(Boolean).join(' \n '));
// "TeenBoysNSFW" / "SexyGirl92": also read camelCase words, which normalize() would lower-case into one blob.
const splitCamel = (s) => String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');

/**
 * Female / feminine check only (no male-signal logic). Use it for creators, handles, bios, feed names.
 * @returns {{level: 'hard'|'soft'|null, rule: string|null}}
 */
function femaleCheck(...texts) {
  const flat = [].concat(texts).flat(Infinity).filter(Boolean);
  for (const t of [toText(flat), toText(flat.map(splitCamel))]) {
    if (!t) continue;
    const hard = firstHit(t);
    if (hard) return { level: 'hard', rule: hard };
  }
  for (const t of [toText(flat), toText(flat.map(splitCamel))]) {
    const m = t && t.match(SOFT);
    if (m) return { level: 'soft', rule: `soft:${m[0]}` };
  }
  return { level: null, rule: null };
}

/**
 * @param {string|string[]} texts everything the item says about itself (title, tags, bio, community ...)
 * @param {{trusted?: boolean, screen?: string[]}} opts `screen`: text that is only checked for female / feminine
 *   wording and never counts as male evidence (the search query a feed ran: a "gay" search returns plenty of women)
 * @returns {{scope: 'in'|'uncertain'|'excluded', male: boolean, strongMale: boolean, female: boolean, femaleSoft: boolean, rule: string|null}}
 */
function classify(texts, { trusted = false, screen = [] } = {}) {
  const flat = [].concat(texts || []).flat(Infinity).filter(Boolean);
  const text = toText(flat);
  const split = toText(flat.map(splitCamel));
  const cjk = MALE_SUBSTR.some((w) => text.includes(w));
  const weakMale = MALE_WEAK.test(text) || MALE_WEAK.test(split);
  const hasPaidPage = weakMale && findPaidHandles(flat.join(' \n ')).length > 0;
  const strongMale = MALE_STRONG.test(text) || MALE_STRONG.test(split) || cjk || hasPaidPage;
  const male = strongMale || weakMale;
  const f = femaleCheck([...flat, ...[].concat(screen || []).flat(Infinity).filter(Boolean)]);
  if (f.level === 'hard') return { scope: 'excluded', male, strongMale, female: true, femaleSoft: false, rule: f.rule };
  if (f.level === 'soft') {
    // "tits", "pussy", "babe" ...: only an explicit male statement in the item's OWN text keeps it alive (for a human to judge)
    if (!strongMale) return { scope: 'excluded', male, strongMale, female: true, femaleSoft: false, rule: `${f.rule} (no male signal)` };
    return { scope: 'uncertain', male, strongMale, female: true, femaleSoft: true, rule: f.rule };
  }
  if (strongMale || trusted) return { scope: 'in', male, strongMale, female: false, femaleSoft: false, rule: null };
  return { scope: 'uncertain', male, strongMale, female: false, femaleSoft: false, rule: null };
}
// In your scope logic, ensure these domains are marked as "safe" or "content-rich"
const SAFELIST_DOMAINS = ['coomer.su', 'kemono.su', 'onlyfans.com', 'fansly.com', 'justforfans.com'];

export function isSafe(url) {
  if (!url) return true;
  const domain = new URL(url).hostname;
  if (SAFELIST_DOMAINS.includes(domain)) return true;
  // ... rest of your safety logic ...
}
