#!/usr/bin/env node
'use strict';
/**
 * NFR-4.3 (stage 9c) — the colour pairs this stylesheet actually paints, measured.
 *
 * A browser sweep finds a contrast failure on a screen somebody happens to open.
 * This finds every pair the stylesheet declares, in both colour schemes, without
 * a browser at all: it reads `unmask.css`, takes the token values out of the
 * `:root` / dark / light blocks the way a browser would resolve them, keeps every
 * rule that sets both a text colour and a background, and applies the WCAG 2.1
 * relative luminance formula.
 *
 * Nothing here restates a hex. If a token changes in the stylesheet, this measures
 * the new value — which is the whole point of keeping it.
 *
 * What it cannot see: a background painted by a gradient or an image, a colour set
 * inline by a component, a hover/focus/disabled state that only exists on
 * interaction, and text sitting on a background inherited from an ancestor element
 * — a rule layered over another rule of the same class chain (`.btn` under
 * `.btn.ghost`) is measured below, but anything reaching across elements is not.
 * Rules scoped by a media query or written with a combinator are left out of that
 * layering, because when they apply is a browser question. Those are the live sweep
 * described in the README.
 *
 * Thresholds: the bar for a declared rule is that rule's own `font-size`
 * (24px+, or 18.66px+ bold, asks 3:1; everything else 4.5:1). A rule that inherits
 * its size from a heading is therefore held to the stricter body-text bar, which
 * can over-report but never under-reports.
 *
 *   node scripts/a11y-tokens.js            all failures, both schemes
 *   node scripts/a11y-tokens.js --list     every measured pair, pass or fail
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CSS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', 'unmask.css');

// ------------------------------------------------------------- colour maths

function parseColor(text) {
  const t = String(text).trim();
  const hex = t.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  const rgb = t.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some(Number.isNaN)) return null;
    return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
  }
  const named = { black: [0, 0, 0], white: [255, 255, 255], transparent: null }[t.toLowerCase()];
  return Array.isArray(named) ? [...named, 1] : null;
}

function channel(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(rgb) {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

function contrast(a, b) {
  const one = luminance(a);
  const two = luminance(b);
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

const round = n => Math.round(n * 100) / 100;

// ------------------------------------------------------ reading the stylesheet

/** Blank out comments while keeping every newline, so line numbers stay true. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
}

/** `prop: value` pairs of one block body, last declaration winning per property. */
function declarations(body) {
  const props = {};
  for (const part of body.split(';')) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const prop = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    if (prop) props[prop] = value;
  }
  return props;
}

/**
 * Every declaration block, with the at-rule context it sits in kept as part of its
 * selector (`@media (prefers-color-scheme: dark) → :root:not([data-theme="light"])`).
 * The context is what lets the dark token overrides be read as dark rather than
 * mistaken for light-mode rules.
 */
function blocks(source) {
  const out = [];
  const stack = [];
  let buf = '';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') {
      if (stack.length) stack[stack.length - 1].kids += 1;
      stack.push({ prelude: buf.trim().replace(/\s+/g, ' '), open: i, kids: 0 });
      buf = '';
      continue;
    }
    if (ch === '}') {
      const frame = stack.pop();
      if (frame && frame.kids === 0) {
        out.push({
          selector: [...stack.map(f => f.prelude), frame.prelude].filter(Boolean).join(' → '),
          props: declarations(source.slice(frame.open + 1, i)),
          line: source.slice(0, frame.open).split('\n').length,
        });
      }
      buf = '';
      continue;
    }
    buf += ch;
  }
  return out;
}

const isRootish = prelude => /(^|,)\s*:root\b/.test(prelude);
const isDark = prelude =>
  /prefers-color-scheme:\s*dark/.test(prelude) ||
  (/data-theme/.test(prelude) && /dark/.test(prelude) && !/light/.test(prelude));
const isLight = prelude => /data-theme/.test(prelude) && /light/.test(prelude) && !/dark/.test(prelude);

/**
 * Custom properties in force for one scheme, in cascade order: the unconditional
 * `:root` as written, then the overrides that match the scheme.
 * `:root:not([data-theme="light"])` inside a dark media block counts as dark, and
 * the explicit `:root[data-theme="dark"]` / `[data-theme="light"]` blocks are read
 * the same way, because a student can pin either one from the account screen.
 */
function tokensFor(all, scheme) {
  const tokens = {};
  const apply = block => {
    for (const [prop, value] of Object.entries(block.props)) {
      if (prop.startsWith('--')) tokens[prop] = value;
    }
  };
  const rootish = [];
  for (const block of all) {
    const chain = block.selector.split(' → ');
    if (!chain.some(isRootish)) continue;
    rootish.push({ block, dark: chain.some(isDark), light: chain.some(isLight) });
  }
  // Base first, then the scheme's own overrides — same order the browser uses.
  for (const { block, dark, light } of rootish) {
    if (dark || light) continue;
    apply(block);
  }
  for (const { block, dark, light } of rootish) {
    if (scheme === 'dark' && dark) apply(block);
    if (scheme === 'light' && light) apply(block);
  }
  return tokens;
}

/** Follow `var(--x)` through the token table. Returns a colour or null. */
function resolve(value, tokens, depth = 0) {
  if (depth > 8) return null;
  let text = String(value).trim();
  const use = text.match(/^var\(\s*(--[a-zA-Z0-9-]+)\s*(?:,([\s\S]*))?\)$/);
  if (use) {
    const own = tokens[use[1]];
    if (own === undefined) return use[2] ? resolve(use[2], tokens, depth + 1) : null;
    return resolve(own, tokens, depth + 1);
  }
  // A colour-producing function we cannot evaluate (color-mix, color-match) is a
  // real colour in the browser but not one we can measure. Say so, do not guess.
  if (/^(color-mix|color-contrast|light-dark|oklch|oklab|hsl|hwb)\(/i.test(text)) return undefined;
  return parseColor(text);
}

const transparentish = rgb => Array.isArray(rgb) && rgb[3] < 1;

function thresholdFor(props, pair) {
  if (pair.ui) return 3;
  const size = Number.parseFloat(props['font-size'] || pair.size || 16);
  const weight = Number.parseFloat(String(props['font-weight'] || pair.weight || 400));
  return size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
}

// Selector fragments of the blocks that paint a brand fill and hold no words: a
// status dot, a meter bar, a photo stand-in. The inherited-text check below skips
// these, and skipping is written down rather than inferred, so the next shape that
// lands on the list gets read before it is excused.
const SHAPES = ['.status-dot', '.meter-bar', '.silhouette'];

// ------------------------------------------------- the pairs worth naming here
//
// These are the pairings the design is *supposed* to paint, named in words, so a
// rename or a re-pointed token shows up as a number rather than a surprise.
// Anything else the stylesheet declares is swept separately below.
// `ui: true` is a non-text item — a border or a focus ring — where AA asks 3:1.

const NAMED = [
  { name: 'body text on the page', fg: 'var(--text)', bg: 'var(--paper)', size: 14.5 },
  { name: 'body text on a card', fg: 'var(--text)', bg: 'var(--paper-2)', size: 14.5 },
  { name: 'muted text on the page', fg: 'var(--text-dim)', bg: 'var(--paper)', size: 12.5 },
  { name: 'muted text on a card', fg: 'var(--text-dim)', bg: 'var(--paper-2)', size: 12.5 },
  { name: 'default button: --on-yellow on --yellow', fg: 'var(--on-yellow)', bg: 'var(--yellow)', size: 14 },
  { name: 'timestamp inside your own bubble', fg: 'var(--on-yellow-dim)', bg: 'var(--yellow)', size: 10.5 },
  { name: 'primary button: --on-pink on --pink-deep', fg: 'var(--on-pink)', bg: 'var(--pink-deep)', size: 14 },
  { name: 'blue button: --on-blue on --blue', fg: 'var(--on-blue)', bg: 'var(--blue)', size: 14 },
  { name: 'brand pink as text, on the page', fg: 'var(--pink-text)', bg: 'var(--paper)', size: 13 },
  { name: 'brand pink as text, on a card', fg: 'var(--pink-text)', bg: 'var(--paper-2)', size: 13 },
  { name: 'brand blue as text, on the page', fg: 'var(--blue-text)', bg: 'var(--paper)', size: 42 },
  { name: 'brand blue as text, on a card', fg: 'var(--blue-text)', bg: 'var(--paper-2)', size: 42 },
  { name: 'muted text on an ink surface', fg: 'var(--on-ink-dim)', bg: 'var(--ink)', size: 12.5 },
  { name: 'link hover on an ink surface', fg: 'var(--on-ink-accent)', bg: 'var(--ink)', size: 12.5 },
  { name: 'keyboard ring: --ring on the page', fg: 'var(--ring)', bg: 'var(--paper)', ui: true },
  { name: 'border that draws a shape', fg: 'var(--border)', bg: 'var(--paper)', ui: true },
];

// ---------------------------------------------------------------- the checks

const source = stripComments(fs.readFileSync(CSS, 'utf8'));
const all = blocks(source);

// ------------------------------------------------------- the cascade inputs
//
// Bare class rules only — `.btn`, `.btn.ghost`, `button.btn.small`. A selector with
// a pseudo-class, a combinator, a comma or an at-rule parent is left to the live
// sweep, because deciding *when* it applies is a browser question, not a text one.
const SIMPLE_RULE = /^(?:[a-zA-Z][a-zA-Z0-9-]*)?(?:\.[a-zA-Z0-9_-]+)+$/;
const simpleRules = all
  .map((block, index) => ({ ...block, index }))
  .filter(block => !block.selector.includes(' → ') && SIMPLE_RULE.test(block.selector))
  .map(block => ({ ...block, classes: block.selector.match(/\.[a-zA-Z0-9_-]+/g) }));

let cascaded = 0;
let cascadePairs = 0;
let ringPairs = 0;
let ringBands = 0;
const list = process.argv.includes('--list');
const failures = [];
const passing = [];
const unclear = [];

for (const scheme of ['light', 'dark']) {
  const tokens = tokensFor(all, scheme);

  for (const pair of NAMED) {
    const fg = resolve(pair.fg, tokens);
    const bg = resolve(pair.bg, tokens);
    if (fg === undefined || bg === undefined) {
      unclear.push({ scheme, what: pair.name, note: 'a colour the script cannot evaluate' });
      continue;
    }
    if (!fg || !bg) {
      failures.push({ scheme, what: pair.name, ratio: null, need: 4.5, note: `"${!fg ? pair.fg : pair.bg}" is not a colour any more` });
      continue;
    }
    const ratio = round(contrast(fg, bg));
    const need = thresholdFor({}, pair);
    (ratio >= need ? passing : failures).push({ scheme, what: pair.name, ratio, need, pair: `${pair.fg} on ${pair.bg}` });
  }

  // Every rule that paints both a colour and a background, whether or not anyone
  // named it — so a rule added later cannot slip in an unmeasured pair.
  for (const block of all) {
    const color = block.props.color;
    const background = block.props.background || block.props['background-color'];
    if (!color || !background) continue;
    if (/gradient|url\(/i.test(background)) continue;
    const fg = resolve(color, tokens);
    const bg = resolve(background.split(/\s+/)[0], tokens);
    if (fg === undefined || bg === undefined) {
      unclear.push({ scheme, what: `${block.selector} (line ${block.line})`, note: `paints ${fg === undefined ? color : background}, which this script cannot evaluate` });
      continue;
    }
    if (!fg || !bg) continue;
    if (transparentish(fg) || transparentish(bg)) continue;
    const ratio = round(contrast(fg, bg));
    const need = thresholdFor(block.props, {});
    const what = `${block.selector} (line ${block.line})`;
    if (ratio < need) {
      failures.push({ scheme, what, ratio, need, pair: `${color} on ${background}` });
    } else {
      passing.push({ scheme, what, ratio, need });
    }
  }

  // A fixed fill with no colour of its own: the text inside it is inherited --text,
  // and --text flips to near-white in dark mode while the fill never moves. This is
  // a pairing the sweep above cannot see, because no single block writes down both
  // halves of it.
  // Shapes that hold no words are named in SHAPES above.
  for (const block of all) {
    const background = block.props.background || block.props['background-color'] || '';
    const fill = background.match(/var\((--yellow|--blue|--pink|--pink-deep)\)/);
    if (!fill || block.props.color) continue;
    if (/gradient|url\(/i.test(background)) continue;
    if (SHAPES.some(shape => block.selector.includes(shape))) continue;
    failures.push({
      scheme,
      what: `${block.selector} (line ${block.line})`,
      ratio: null,
      need: 4.5,
      note: `paints ${fill[1]} with no colour of its own, so its text inherits --text`,
    });
  }

  // The cascade case a per-rule read cannot see: `.btn.ghost` names a background
  // and inherits `.btn`'s colour, and in the dark scheme that pairs a fixed
  // near-black text with a near-black paper (measured 1.03:1). Layer each bare
  // class rule over every earlier bare class rule whose classes are a strict subset
  // of its own, the way a browser would, and measure the pair that comes out.
  for (const rule of simpleRules) {
    if (rule.props.color && (rule.props.background || rule.props['background-color'])) continue;
    const merged = {};
    const under = [];
    for (const other of simpleRules) {
      if (other.index >= rule.index) continue;
      if (other.classes.length >= rule.classes.length) continue;
      if (!other.classes.every(cls => rule.classes.includes(cls))) continue;
      Object.assign(merged, other.props);
      under.push(other.selector);
    }
    Object.assign(merged, rule.props);
    const color = merged.color;
    const background = merged.background || merged['background-color'];
    if (!color || !background || /gradient|url\(/i.test(background)) continue;
    const fg = resolve(color, tokens);
    const bg = resolve(background.split(/\s+/)[0], tokens);
    if (fg === undefined || bg === undefined) continue;
    if (!fg || !bg || transparentish(fg) || transparentish(bg)) continue;
    const ratio = round(contrast(fg, bg));
    const need = thresholdFor(merged, {});
    cascadePairs += 1;
    if (ratio < need) {
      cascaded += 1;
      failures.push({
        scheme,
        what: `${rule.selector} (line ${rule.line})`,
        ratio,
        need,
        pair: `${color} on ${background}`,
        note: `painted under ${under.join(', ')}`,
      });
    }
  }

  // --------------------------------------------- the keyboard ring
  //
  // The ring is drawn *outside* the control, so the surface it has to beat is the one
  // behind it — a pairing no rule writes down in one place. Both of these were live
  // defects before they were fixes: the page ring against the dark scheme's card
  // measured 2.81:1, and the same ring inside the --blue reveal band measured 1.00:1.
  const pageRing = resolve(tokens['--ring'], tokens);
  for (const surface of ['--paper', '--paper-2']) {
    const bg = resolve(tokens[surface], tokens);
    if (!pageRing || !bg) continue;
    ringPairs += 1;
    const ratio = round(contrast(pageRing, bg));
    const what = `keyboard ring on the ${surface.replace(/^--/, '')}`;
    if (ratio < 3) {
      failures.push({ scheme, what, ratio, need: 3, pair: `${tokens['--ring']} on ${tokens[surface]}`, note: 'the ring is the state indicator; SC 1.4.11 asks 3:1' });
    } else {
      passing.push({ scheme, what, ratio, need: 3 });
    }
  }
  // A band that repaints itself has to say which ring its controls wear. This checks
  // the ones that did say; the live sweep is what finds a band that holds controls
  // and stayed silent, because only a browser knows what sits inside a rule.
  for (const block of all) {
    const declared = block.props['--ring'];
    const background = block.props.background || block.props['background-color'];
    if (!declared || !background) continue;
    if (/gradient|url\(/i.test(background)) continue;
    const ring = resolve(declared, tokens);
    const bg = resolve(background.split(/\s+/)[0], tokens);
    if (!ring || !bg || transparentish(ring) || transparentish(bg)) continue;
    const ratio = round(contrast(ring, bg));
    const what = `${block.selector} (line ${block.line})`;
    ringBands += 1;
    if (ratio < 3) {
      failures.push({ scheme, what, ratio, need: 3, pair: `${declared} on ${background}`, note: 'the ring inside this band is invisible against it' });
    } else {
      passing.push({ scheme, what, ratio, need: 3 });
    }
  }
}

// --------------------------------------------- two rules the screens lean on
//
// Neither is a colour. Both are one deleted rule away from being quietly untrue:
// `.sr-only` is how an announcement reaches a screen reader without landing on the
// page (the thread's live region and every field label depend on it), and the
// reduced-motion block is the promise NFR-4.4 makes to a student who asked for it.
const structural = [];

const srOnly = all.find(block => block.selector.trim() === '.sr-only');
if (
  !srOnly ||
  !/absolute/.test(srOnly.props.position || '') ||
  !(srOnly.props['clip-path'] || srOnly.props.clip) ||
  Number.parseFloat(srOnly.props.width) !== 1
) {
  failures.push({
    scheme: 'both',
    what: '.sr-only',
    ratio: null,
    need: null,
    note: 'is no longer a visually-hidden-but-readable box, so an announced message would either show or vanish',
  });
} else {
  structural.push(`.sr-only hides visually and stays readable (line ${srOnly.line})`);
}

const reduced = all.find(block => /prefers-reduced-motion/.test(block.selector));
const collapses = prop => /^0\.0*\d*ms\s*!important$/.test((reduced?.props[prop] || '').trim());
if (!reduced || !collapses('animation-duration') || !collapses('transition-duration')) {
  failures.push({
    scheme: 'both',
    what: '@media (prefers-reduced-motion: reduce)',
    ratio: null,
    need: null,
    note: 'no longer forces every animation and transition duration to a near-zero',
  });
} else {
  structural.push(`prefers-reduced-motion collapses both durations (line ${reduced.line})`);
}

// Rules that set a colour but no background cannot be judged here: their backdrop
// comes from an ancestor. Listed so the count is honest about what was skipped.
const unbacked = all.filter(block => {
  const color = block.props.color;
  const background = block.props.background || block.props['background-color'];
  return color && !background && !/inherit|currentcolor|transparent/i.test(color);
});

const seen = new Set();
const unique = failures.filter(f => {
  const key = `${f.scheme}|${f.what}|${f.ratio}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}).sort((a, b) => (a.scheme === b.scheme ? a.ratio - b.ratio : a.scheme === 'light' ? -1 : 1));

console.log(
  `\n${all.length} declaration blocks read from unmask.css, ${Object.keys(tokensFor(all, 'light')).length} light tokens, ${Object.keys(tokensFor(all, 'dark')).length} dark tokens, ${NAMED.length} named pairs, two schemes.`,
);
console.log(
  `${unbacked.length} rules set a colour with no background of their own and are judged by the live sweep instead.`,
);
console.log(
  `${simpleRules.length} bare class rules were layered the way a browser layers them: ${cascadePairs} inherited pairs measured, ${cascaded} below AA.`,
);
console.log(
  `Keyboard ring: ${ringPairs / 2} pairings against the page surfaces and ${ringBands / 2} bands that re-declare --ring, measured at 3:1 in both schemes.`,
);
if (structural.length) console.log(`Also holding: ${structural.join('; ')}.`);

if (list) {
  console.log('\nmeasured and passing:');
  for (const p of passing) {
    console.log(`  ${p.scheme.padEnd(5)} ${String(p.ratio).padStart(5)} : 1  ${p.what}`);
  }
}
if (unclear.length) {
  console.log('\ncannot be measured here:');
  for (const u of unclear) console.log(`  ${u.scheme.padEnd(5)} ${u.what} — ${u.note}`);
}

if (unique.length === 0) {
  console.log('\nPASS — no declared colour pair falls below WCAG 2.1 AA in either scheme.');
  process.exit(0);
}

console.log(`\nFAIL — ${unique.length} pair${unique.length === 1 ? '' : 's'} below AA:`);
for (const f of unique) {
  const r = f.ratio === null ? '  n/a' : String(f.ratio).padStart(5);
  console.log(`  ${f.scheme.padEnd(5)} ${r} : 1 (needs ${f.need})  ${f.what}${f.pair ? '  [' + f.pair + ']' : ''}${f.note ? '  ' + f.note : ''}`);
}
process.exit(1);
