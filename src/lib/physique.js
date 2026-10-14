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
  const sm = mid(ls, rs); const hm = mid(lh, rh);
  const L = dist(sm, hm); const S = dist(ls, rs);
  if (L < MIN_TORSO_PX) return { decided: false, reason: 'body too small' };
  if (S / L < MIN_FRONTAL) return { decided: false, reason: 'body turned sideways' };

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
  /** Distance from c to the silhouette's edge along dir (a gap of 1-2 px, e.g. a navel shadow, is not an edge). */
  const edge = (c, dir) => {
    for (let k = 1; k <= maxWalk; k++) {
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
  // Either ratio clearly heavy is enough: a plain average let a belly as wide as the shoulders pass whenever the torso looked
  // long (camera below, a stretched pose). The other ratio still pulls a borderline reading down a little.
  const a = clamp01((ws - WS[0]) / (WS[1] - WS[0])); const b = clamp01((wl - WL[0]) / (WL[1] - WL[0]));
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

/**
 * Does the text describe a heavy body / a chub community? Use it for titles, tags, handles, bios and channel names.
 * @returns {{heavy: boolean, rule: string|null}}
 */
function textCheck(...texts) {
  const flat = [].concat(texts).flat(Infinity).filter(Boolean).map(String);
  const variants = [flat.join(' \n '), flat.map((s) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')).join(' \n ')].map(normalize);
  for (const t of variants) {
    if (!t) continue;
    for (const w of HEAVY_SUBSTR) if (t.includes(w)) return { heavy: true, rule: `physique:${w.trim()}` };
    const g = t.match(GLUED_BEAR);
    if (g) return { heavy: true, rule: `physique:${g[0]}` };
    const m = t.match(HEAVY_WORDS);
    if (m) return { heavy: true, rule: `physique:${m[0]}` };
  }
  return { heavy: false, rule: null };
}

module.exports = { measure, textCheck, segmentsCross, ANCHORS: { WS, WL } };
