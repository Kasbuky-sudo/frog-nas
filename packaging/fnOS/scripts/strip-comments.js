#!/usr/bin/env node
'use strict';
/**
 * Remove comments from the two project-authored game scripts before they are
 * packed, keeping the code byte-for-byte identical in behaviour.
 *
 * Why this exists: `game/__offline-engine.js` and `game/__probe.js` were written
 * while porting, so they carry long design notes (why a rule is what it is, what
 * was measured, which client function forced a decision). Those notes are useful
 * in the repo, but they ship inside the .fpk -- which anybody can download and
 * unpack. The published package should contain the game, not the worklog.
 *
 * What it does NOT do: touch the source tree. Stripping happens on the staged
 * copy only, so `vendor/` stays byte-identical to the source it is fetched from.
 * The file's opening block comment (attribution / generation notice) is kept.
 *
 * Correctness: a single-pass state machine, not a regex. Comments inside string
 * and template literals survive (the engine is full of URLs like
 * "http://gm.mmstat.com/fsp.1.1" that a naive `//` strip would truncate), and
 * regex literals are recognised by looking at the previous significant token.
 * Newlines inside removed comments are preserved so stack-trace line numbers
 * still line up.
 *
 * Usage:
 *   node strip-comments.js <file> [--keep-first-block] [--check]
 *   node strip-comments.js <file> --check      # report only, writes nothing
 */
const fs = require('fs');

/** Previous significant character decides whether `/` starts a regex. */
function regexAllowed(prev) {
  if (!prev) return true;
  return '(,=:[!&|?{};+-*%^~<>'.indexOf(prev) !== -1 || prev === '\n';
}

function strip(src, keepFirstBlock) {
  let out = '';
  let i = 0;
  const n = src.length;
  let prevSig = '';
  let firstBlockKept = false;
  let removed = 0;

  const record = (ch) => { if (!/\s/.test(ch)) prevSig = ch; };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    // --- line comment -------------------------------------------------------
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { removed++; i++; }
      continue;
    }

    // --- block comment ------------------------------------------------------
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      const body = src.slice(i, stop);
      // Keep the file's own opening block (attribution / generation notice).
      if (keepFirstBlock && !firstBlockKept && out.trim() === '') {
        out += body;
        firstBlockKept = true;
      } else {
        for (const ch of body) { if (ch === '\n') out += '\n'; }
        removed += body.length;
      }
      i = stop;
      continue;
    }

    // --- strings ------------------------------------------------------------
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) { j++; break; }
        // A template can contain ${ ... } expressions, which may themselves
        // hold strings -- they are balanced, so tracking depth is enough.
        if (quote === '`' && src[j] === '$' && src[j + 1] === '{') {
          let depth = 1;
          j += 2;
          while (j < n && depth > 0) {
            if (src[j] === '\\') { j += 2; continue; }
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            j++;
          }
          continue;
        }
        j++;
      }
      out += src.slice(i, j);
      prevSig = quote;
      i = j;
      continue;
    }

    // --- regex literal ------------------------------------------------------
    if (c === '/' && regexAllowed(prevSig)) {
      let j = i + 1;
      let inClass = false;
      let ok = false;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '\n') break;                       // not a regex after all
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { ok = true; j++; break; }
        j++;
      }
      if (ok) {
        while (j < n && /[a-z]/.test(src[j])) j++;    // flags
        out += src.slice(i, j);
        prevSig = '/';
        i = j;
        continue;
      }
      // fall through: it was division
    }

    out += c;
    record(c);
    i++;
  }

  return { code: out, removed };
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const keepFirstBlock = args.includes('--keep-first-block');
  const checkOnly = args.includes('--check');
  if (!file) {
    console.error('usage: node strip-comments.js <file> [--keep-first-block] [--check]');
    process.exit(2);
  }

  const src = fs.readFileSync(file, 'utf8');
  const { code, removed } = strip(src, keepFirstBlock);

  // Never write something that does not parse.
  try {
    new Function(code);                                    // eslint-disable-line no-new-func
  } catch (e) {
    console.error('REFUSING: stripped output does not parse: ' + e.message);
    process.exit(1);
  }

  const pct = ((removed / src.length) * 100).toFixed(1);
  console.log('%s  %d -> %d bytes  (-%d, %s%%)',
    file, src.length, code.length, removed, pct);
  if (!checkOnly) fs.writeFileSync(file, code, 'utf8');
}

if (require.main === module) main();
module.exports = { strip };
