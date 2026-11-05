'use strict';
/**
 * Physique: how heavy is the body in a picture?
 *
 * Two cheap readings feed one 0..100 "heaviness" score (0 = lean / athletic, 100 = very large):
 *
 *   picture  body keypoints (MoveNet) + a person silhouette (MediaPipe selfie segmentation), both on-device and run in the
 *            same worker pass as the face model. The torso is measured perpendicular to its own axis at belly height and
 *            compared with the shoulder span and the torso length: a V-shaped torso scores low, a belly that is as wide as
 *            (or wider than) the shoulders scores high. Arms hanging next to the belly would inflate the width, so a side
 *            whose measuring ray crosses an arm is not used (the other side is mirrored).
 *   text     words such as "chubby", "superchub", "gainer", "dad bod" in a title, tag, handle, bio or channel name.
 *
 * No torso in view (close-ups, crops above the hips, side shots, no person) = no verdict: the picture is kept.
 */
const { normalize } = require('./safety');

const MIN_KEYPOINT = 0.3;  // keypoint confidence for shoulders / hips
const MIN_ARM_POINT = 0.2; // elbows / wrists are fuzzier and only used to rule a side out
const MASK_ON = 128;       // silhouette alpha (0..255) counted as "person"
const MIN_TORSO_PX = 40;   // shoulder-to-hip length (in analysed pixels) below which the body is too small to measure
const MIN_FRONTAL = 0.5;   // shoulder span / torso length: below this the body is turned sideways and the width means little
const MAX_FRONTAL = 1.5;   // ... and above this the keypoints do not describe one upright torso (a garbled pose; a real one sits at 0.55..1.1)
const MAX_SKEW_DEG = 30;   // angle between the shoulder line and the hip line: a twisted or mis-assigned pose is not measurable
const MAX_WS = 1.4;        // belly width / shoulder span, torso length: the 100 anchors are 1.05 / 0.74, so past these the silhouette is
const MAX_WL = 1.1;        //   not a larger body but legs, arms, a partner or a bed merged into it: no verdict instead of 100
const BELLY = [0.45, 0.8];  // where along the shoulder -> hip line the belly is measured (fractions of the torso length)
const ROWS = 13;
const MIN_ROWS = 4;

// Anthropometric anchors for the two ratios (belly width measured on the silhouette, shoulders and torso from keypoints).
// Lean / athletic men sit at or below the low anchor, clearly heavy bodies past the high one. Shoulder keypoints sit on the
// joints (~35 cm apart on a man), the torso keypoints ~50 cm apart: a lean waist (~29 cm wide) gives ~0.83 / ~0.58, an
// overweight belly (~35 cm) ~1.0 / ~0.70. v4.14 used 0.9..1.2 / 0.66..0.95, which let overweight and stocky builds through.
const WS = [0.86, 1.05]; // belly width / shoulder span
const WL = [0.58, 0.74]; // belly width / torso length

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Do segments p1-p2 and q1-q2 intersect? */
function segmentsCross(p1, p2, q1, q2) {
  const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(q1, q2, p1); const d2 = d(q1, q2, p2); const d3 = d(p1, p2, q1); const d4 = d(p1, p2, q2);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/**
 * Measure a body. Pure function: keypoints in pixel coordinates of a `w` x `h` alpha mask (one value 0..255 per pixel).
 * @param {{part: string, position: number[], score: number}[]} keypoints
 * @param {ArrayLike<number>} mask
 * @returns {{decided: boolean, score?: number, reason?: string, ws?: number, wl?: number, rows?: number}}
 */
function measure(keypoints, mask, w, h) {
  if (!keypoints || !mask || !w || !h) return { decided: false, reason: 'no body' };
  const kp = {};
  for (const k of keypoints) if (k && k.part && k.position) kp[k.part] = k;
  const P = (p, min) => (kp[p] && kp[p].score >= min ? { x: kp[p].position[0], y: kp[p].position[1] } : null);
  const ls = P('leftShoulder', MIN_KEYPOINT); const rs = P('rightShoulder', MIN_KEYPOINT);
  const lh = P('leftHip', MIN_KEYPOINT); const rh = P('rightHip', MIN_KEYPOINT);
  if (!ls || !rs || !lh || !rh) return { decided: false, reason: 'torso not in view' };
  // MoveNet labels the subject's own left and right: a front view has the left shoulder and hip on the image's right. Both on
  // the image's left = the person faces away: the belly is not in view and the silhouette is lats, hips and thighs. All nine
  // back views in a 189-picture sample of Coomer / Bluesky thumbnails (five of them scored 45-100) were caught this way.
  if (ls.x < rs.x && lh.x < rh.x) return { decided: false, reason: 'facing away' };
  const sm = mid(ls, rs); const hm = mid(lh, rh);
  const L = dist(sm, hm); const S = dist(ls, rs);
  if (L < MIN_TORSO_PX) return { decided: false, reason: 'body too small' };
  if (S / L < MIN_FRONTAL) return { decided: false, reason: 'body turned sideways' };
  if (S / L > MAX_FRONTAL) return { decided: false, reason: 'pose not a single upright torso' };
  const skew = Math.abs(((Math.atan2(ls.y - rs.y, ls.x - rs.x) - Math.atan2(lh.y - rh.y, lh.x - rh.x)) * 180) / Math.PI);
  if (Math.min(skew, 360 - skew) > MAX_SKEW_DEG) return { decided: false, reason: 'pose not a single upright torso' };

  const ax = { x: (hm.x - sm.x) / L, y: (hm.y - sm.y) / L };
  const n = { x: -ax.y, y: ax.x };
  const arms = [];
  for (const side of ['left', 'right']) {
    const chain = [P(`${side}Shoulder`, MIN_KEYPOINT), P(`${side}Elbow`, MIN_ARM_POINT), P(`${side}Wrist`, MIN_ARM_POINT)];
    for (let i = 0; i < 2; i++) if (chain[i] && chain[i + 1]) arms.push([chain[i], chain[i + 1]]);
    // The model often stops the arm short (a missed wrist, a wrist placed at the forearm): reach on along the last segment,
    // to the fingertips, so an arm hanging next to the belly is always recognised as an arm.
    const [a, b] = chain[2] && chain[1] ? [chain[1], chain[2]] : chain[1] && chain[0] ? [chain[0], chain[1]] : [null, null];
    if (a && b) { const f = chain[2] ? 0.6 : 1; arms.push([b, { x: b.x + (b.x - a.x) * f, y: b.y + (b.y - a.y) * f }]); }
  }
  const on = (x, y) => {
    const xi = Math.round(x); const yi = Math.round(y);
    return xi >= 0 && yi >= 0 && xi < w && yi < h && mask[yi * w + xi] >= MASK_ON;
  };
  const maxWalk = Math.ceil(1.5 * L);
  const margin = 0.08 * S;
  const inside = (x, y) => { const xi = Math.round(x); const yi = Math.round(y); return xi >= 0 && yi >= 0 && xi < w && yi < h; };
  /**
   * Distance from c to the silhouette's edge along dir (a gap of 1-2 px, e.g. a navel shadow, is not an edge).
   * A silhouette that runs off the mask (the torso crop) has no edge there: the crop border is not a body edge. Counting it
   * as one made the "belly width" the crop width (shoulders + 1.4 torso lengths, ws ~1.9) for any picture whose silhouette
   * fills the crop (a partner, a bed, a saturated segmentation), and scored it 100.
   */
  const edge = (c, dir) => {
    for (let k = 1; k <= maxWalk; k++) {
      if (!inside(c.x + dir.x * k, c.y + dir.y * k)) return null;
      if (on(c.x + dir.x * k, c.y + dir.y * k)) continue;
      if (on(c.x + dir.x * (k + 1), c.y + dir.y * (k + 1)) || on(c.x + dir.x * (k + 2), c.y + dir.y * (k + 2))) continue;
      return k;
    }
    return null; // ran off the silhouette's measuring range: not a torso edge
  };

  const widths = [];
  for (let i = 0; i < ROWS; i++) {
    const t = BELLY[0] + ((BELLY[1] - BELLY[0]) * i) / (ROWS - 1);
    const c = { x: sm.x + ax.x * t * L, y: sm.y + ax.y * t * L };
    if (!on(c.x, c.y)) continue;
    const halves = [];
    for (const s of [1, -1]) {
      const dir = { x: n.x * s, y: n.y * s };
      const e = edge(c, dir);
      if (e == null) continue;
      const end = { x: c.x + dir.x * (e + margin), y: c.y + dir.y * (e + margin) };
      if (arms.some(([a, b]) => segmentsCross(c, end, a, b))) continue; // an arm lies along this side: its width is not the body's
      halves.push(e);
    }
    if (halves.length === 2) widths.push(halves[0] + halves[1]);
    else if (halves.length === 1) widths.push(2 * halves[0]);
  }
  if (widths.length < MIN_ROWS) return { decided: false, reason: 'belly not measurable (arms or crop)' };
  widths.sort((a, b) => a - b);
  const W = widths[Math.floor(widths.length / 2)]; // median: one bad row (a hand, a shadow) does not decide
  const ws = W / S; const wl = W / L;
  if (ws > MAX_WS || wl > MAX_WL) return { decided: false, reason: 'silhouette wider than one torso' };
  // Either ratio clearly heavy is enough: a plain average let a belly as wide as the shoulders pass whenever the torso looked
  // long (camera below, a stretched pose). The other ratio still pulls a borderline reading down a little.
  const a = clamp01((ws - WS[0]) / (WS[1] - WS[0])); const b = clamp01((wl - WL[0]) / (WL[1] - WL[0]));
  // The shoulder ratio says lean, the torso-length ratio says heavy: the torso is foreshortened (seated, crouched, shot from
  // above), so its keypoint length is short while the shoulders are not. Sampled thumbnails with this split were all seated
  // or lean standing men scored 55-75. (The reverse, a belly as wide as the shoulders on a long torso, is the case the max
  // below exists for and still counts.)
  if (a === 0 && b > 0.5) return { decided: false, reason: 'torso foreshortened (width ratios disagree)' };
  const score = Math.round(100 * (0.75 * Math.max(a, b) + 0.25 * Math.min(a, b)));
  return { decided: true, score, ws: Math.round(ws * 100) / 100, wl: Math.round(wl * 100) / 100, rows: widths.length };
}

/* ------------------------------------------------------------------------------------------------ text */
// Matched anywhere (safe inside glued handles: "chubbybear", "SuperchubSam", "gainerguy").
const HEAVY_SUBSTR = ['chubby', 'chubbies', 'chubbie', 'superchub', 'chubchaser', 'chub chaser', 'chubster', 'chubbear', 'chubdaddy', 'chubboy', 'chubguy', 'chubbyguy',
  'gainer', 'feedee', 'obese', 'ssbhm', 'dadbod', 'dad bod', 'beerbelly', 'beer belly', 'bigbelly', 'big belly', 'belly play', 'bellyplay', 'plus size', 'plussize',
  'heavyset', 'dad body', 'ガチムチ', 'がちむち', 'デブ', 'ぽっちゃり', 'gachimuchi', 'bigguy', 'bigmen', 'stockyguy', 'stockymen',
  'fatboy', 'fat boy', 'fatguy', 'fat guy', 'fatman', 'fat man', 'fat men', 'fatbear', 'fat bear', 'fat daddy', 'fatdaddy'].map(normalize);
// Whole words. "fat" alone is also porn slang for "thick" ("fat cock", "fat ass", "fat load"), so those uses do not count.
// Bears / cubs / stocky builds too: only fit, athletic men are wanted, and "bear" is the big-guy category on every platform.
// "bearded" / "beard" are not bears. Japanese: ガチムチ (stocky-muscular), デブ (fat), ぽっちゃり (chubby).
const HEAVY_WORDS = /\b(?:chub|chubs|chubz|chunky|chunk|husky|portly|pudgy|tubby|rotund|stocky|burly|bbm|bhm|feeder|feeders|feederism|fattie|fatty|fatties|fatso|ssbbm|bears?|cubs?|big (?:guys?|men|man|boys? bod)|thick bod(?:y|ied)?)\b|\bfat\b(?!\s*(?:cocks?|dicks?|ass|asses|butts?|booty|bulges?|loads?|cum|meat|heads?|tips?|balls|nuts|ones?|uncut|cut|pipes?|rods?|shafts?|knobs?|pp|wood|bwc|bbc))/;

// Bears glued into handles and community names ("gaybear", "bearsgonewild", "musclebearsam"), never "beard".
const GLUED_BEAR = /(?:gay|muscle|polar|chub|teddy|fat|big|daddy|hairy)bears?(?!d)|bears?(?:gonewild|cubs?|chasers?|week|daddy|daddies|ofinstagram)|cubbears?|bearcubs?/;

/* ---------------------------------------------------------------------------------- older men (words only) */
// Only what an item or a profile says about itself, and only where the wording is unambiguous: "silver fox" / "silver daddy",
// a bare "grandpa", a #oldman / #maturemen tag, or a stated age of OLDER_MIN_AGE or more ("52yo", "I'm 58", "in my 50s").
// There is deliberately NO visual age estimate: guessing a man's age from his face is unreliable and is not something this
// app does. Precision matters more than recall here, because a false match hides a legitimate creator, so these are NOT matched:
// "daddy" alone (a pet name at any age), spaced phrases like "older men" / "mature men" (a bio that says it likes them is not
// about its own age), "old man" (also a lifting term), "my grandpa", elderly / grandfather / gramps / pensioner, "mature
// content", "18+", "over 50 videos", "I'm 60 days out", "I'm 50 sets", "60 kg", or surnames like Goldman / Holderman.
const OLDER_MIN_AGE = 45;
const OLDER_GLUED = ['silverfox', 'silverdaddy', 'silverdaddies', 'greydaddy', 'graydaddy', 'greydaddies', 'graydaddies'];
const OLDER_WORDS = new RegExp([
  '\\bsilver (?:foxe?s?|daddy|daddies)\\b', '\\b(?:grey|gray) (?:daddy|daddies)\\b',
  // a bare grandpa, not somebody's: "my grandpa taught me" is about someone else
  '(?<!\\b(?:my|your|his|her|our|their|the|a|an)\\s)\\b(?:grandpas?|grandad|granddad)\\b',
  // tags and handles, glued ("#maturemen"); the spaced phrases are deliberately not matched
  '\\b(?:oldermen|olderman|oldmen|oldman|maturemen|matureman)\\b',
].join('|'));
const AGE_MIN = '(?:4[5-9]|[5-9]\\d)';
// After "I'm 58" the clause must end or an age word must follow, so "I'm 60 days out", "I'm 50 sets", "I'm 50/50" are not ages.
// A comma or full stop only ends the clause when no digit follows it: "I'm 50,000 followers strong" and "I'm 45.5 kg down" are quantities.
const AGE_END = '(?=\\s*(?:$|\\n|[,.](?!\\d)|[;:!?|)\\]•·]|-\\s|and\\b|but\\b|with\\b|&|years?\\b|yrs?\\b|y[\\/ .]?o\\b|(?:male|man|guy|dad)\\b))';
const OLDER_AGE = new RegExp([
  // "52yo", "52 y/o", "52 y o", "52 years old", "52-year-old", "52 yr old"
  `\\b${AGE_MIN}\\s*(?:y[\\/ .]?o|yrs?[- ]old|[- ]?years?[- ]?old)\\b`,
  // "age 55", "aged: 58", "I'm 52", "im 52"
  `\\b(?:age|aged|i['’]?m|i am|turning)\\s*:?\\s*${AGE_MIN}\\b${AGE_END}`,
  // "in my 50s", "in my early 50s", "late 40s", "mid-60s" (not "mid 40s": that is 44 to 46, under the line)
  `\\bin my (?:early |mid |late )?(?:50|60|70|80)['’]?s\\b`, `\\b(?:late[- ]?(?:40|50|60|70)|mid[- ]?(?:50|60|70)|early[- ]?(?:50|60|70))['’]?s\\b`,
].join('|'));

/** Does the text say its owner is an older man? @returns {string|null} the rule that matched, without a prefix */
function olderCheck(t) {
  for (const w of OLDER_GLUED) if (t.includes(w)) return `older:${w}`;
  const w = t.match(OLDER_WORDS);
  if (w) return `older:${w[0]}`;
  const a = t.match(OLDER_AGE);
  return a ? `older:${a[0].trim()}` : null;
}

/**
 * Does the text describe a heavy body, a chub community, or a man who calls himself older? Use it for titles, tags, handles,
 * bios and channel names. `kind` says which ('heavy' or 'older'); both hide the same reversible way.
 * @returns {{heavy: boolean, rule: string|null, kind: string|null}}
 */
function textCheck(...texts) {
  const flat = [].concat(texts).flat(Infinity).filter(Boolean).map(String);
  const variants = [flat.join(' \n '), flat.map((s) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')).join(' \n ')].map(normalize);
  for (const t of variants) {
    if (!t) continue;
    for (const w of HEAVY_SUBSTR) if (t.includes(w)) return { heavy: true, rule: `physique:${w.trim()}`, kind: 'heavy' };
    const g = t.match(GLUED_BEAR);
    if (g) return { heavy: true, rule: `physique:${g[0]}`, kind: 'heavy' };
    const m = t.match(HEAVY_WORDS);
    if (m) return { heavy: true, rule: `physique:${m[0]}`, kind: 'heavy' };
    const o = olderCheck(t);
    if (o) return { heavy: true, rule: `physique:${o}`, kind: 'older' };
  }
  return { heavy: false, rule: null, kind: null };
}

module.exports = { measure, textCheck, segmentsCross, OLDER_MIN_AGE, ANCHORS: { WS, WL } };
