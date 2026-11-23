// makefun-site 1.0.0, reimplemented for speed: run(input) returns, for one case's input { site, templates, files },
// the same output tree makefun-site 1.0.0's build returns — every written path and its text, byte for byte.
//
// The semantics are the reference's, restated path by path; the work is restructured:
//   - front matter is parsed in place (indexOf scans), never splitting the body into lines and rejoining it
//   - Markdown is lexed and rendered in one pass (no token objects, no per-line regex battery)
//   - inline text is scanned for the five characters that can start a mark and escaped in whole chunks
//     (the reference calls a regex replace per character)
//   - each template is parsed once, then compiled to a JavaScript function by new Function(): the node walk,
//     the scope-chain objects and the per-node dispatch of the interpreter become straight-line code, with the
//     template scope chain carried by the prototype chain of null-prototype objects (identical lookup semantics)

// ---------------------------------------------------------------- text

/** The HTML escape table, in this order: & < > " '. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;
const MARKS = /\p{M}/gu;
const NON_ASCII = /[^\x00-\x7f]/;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other than a-z and 0-9 one
 * "-", none at either end, at most SLUG_MAX characters (a "-" left at the cut dropped), and "untitled" when nothing
 * is left. A pure-ASCII text has no NFKD decomposition and no combining marks, so those steps are skipped for it.
 */
function slugify(text) {
  const plain = NON_ASCII.test(text) ? text.normalize('NFKD').replace(MARKS, '') : text;
  const codes = [];
  let gap = false;
  let outLen = 0;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === 0) {
      gap = outLen > 0;
      continue;
    }
    if (gap) codes[ outLen++ ] = 45;
    gap = false;
    codes[ outLen++ ] = keep;
    if (outLen >= SLUG_MAX) break;
  }
  let out = String.fromCharCode(...codes);
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  const re = /\S+/g;
  let n = 0;
  while (re.exec(text) !== null) n++;
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Whether `line` is empty or only spaces and tabs. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` without spaces and tabs at either end. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_TRAIL = /[ \t]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function fmString(raw) {
  const n = raw.length;
  if (n > 0 && raw.charCodeAt(0) === 34) {
    if (n < 2 || raw.charCodeAt(n - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < n - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === n - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (n > 0 && raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      let ok = false;
      if (m !== null) {
        const y = Number(m[1]);
        const mo = Number(m[2]);
        const d = Number(m[3]);
        ok = y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
      }
      return ok ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    case 'tags': {
      const n = raw.length;
      if (n === 0 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(n - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has "\n"
 * line ends. The lines are scanned in place: the opening "---" line, the closing "---" line and the body are found
 * by indexOf without splitting the whole text.
 */
function parseFrontMatter(text) {
  const len = text.length;
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // The closing line is a line that is exactly "---": "\n---" followed by "\n" or the end of the text.
  let idx = text.indexOf('\n---', 3);
  while (idx !== -1) {
    const after = idx + 4;
    if (after === len || text.charCodeAt(after) === 10) break;
    idx = text.indexOf('\n---', idx + 1);
  }
  if (idx === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // Front matter lines are the lines inside [4, idx): idx is the "\n" just before the closing "---".
  let pos = 4;
  let lineNo = 1; // the array index a split would give the line being read
  while (pos < idx) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1 || nl > idx) nl = idx;
    const line = nl === pos ? '' : text.slice(pos, nl);
    lineNo++;
    pos = nl + 1;
    if (line === '' || isBlank(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (m === null) return { error: `line ${lineNo} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(FM_TRAIL, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const after = idx + 4; // the "\n" that ends the closing "---" line, or len when it is the last line
  return { data, body: after === len ? '' : text.slice(after + 1) };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes: \ ` * _ [ ] ( ) # + - . ! > */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS = /\s/;

/** The language of a "```lang" fence opener ([A-Za-z0-9_+-]* then spaces or tabs only), or null. */
function fenceLang(line) {
  const n = line.length;
  if (n < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < n) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = line.slice(3, j);
  while (j < n) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    j++;
  }
  return lang;
}

/** Whether `line` is "```" then spaces or tabs only. */
function fenceClose(line) {
  const n = line.length;
  if (n < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < n; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's { depth, text }, or null: 1 to 6 "#", space or tab, then text (its end trimmed; never empty). */
function headingOf(line) {
  const n = line.length;
  let d = 0;
  while (d < n && line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6 || d === n) return null;
  const c = line.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  const text = trimLine(line.slice(d));
  return text === '' ? null : { depth: d, text };
}

/** Whether `line` is "---" or "***" then spaces or tabs only. */
function isHr(line) {
  const n = line.length;
  if (n < 3) return false;
  const c = line.charCodeAt(0);
  if (c === 45) {
    if (line.charCodeAt(1) !== 45 || line.charCodeAt(2) !== 45) return false;
  } else if (c === 42) {
    if (line.charCodeAt(1) !== 42 || line.charCodeAt(2) !== 42) return false;
  } else return false;
  for (let j = 3; j < n; j++) {
    const x = line.charCodeAt(j);
    if (x !== 32 && x !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  const n = line.length;
  if (n === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 96) return fenceLang(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  if (c === 32 || c === 9) return isBlank(line);
  return false;
}

const CONTINUED = /^ {2,}\S/;
const ORDERED = /^(\d{1,9})\. (.*)$/;

// Characters that can start an inline mark: \ ` * [
const INLINE_SPECIAL = new Uint8Array(128);
INLINE_SPECIAL[92] = 1;
INLINE_SPECIAL[96] = 1;
INLINE_SPECIAL[42] = 1;
INLINE_SPECIAL[91] = 1;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const wl = what.length;
  const c0 = what.charCodeAt(0);
  const c1 = wl === 2 ? what.charCodeAt(1) : -1;
  for (let j = from; j <= s.length - wl; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.charCodeAt(j) === c0 && (wl === 1 || s.charCodeAt(j + 1) === c1)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s` rendered inline; `link(target)` resolves a link's href. */
function inline(s, link) {
  let out = '';
  let i = 0;
  let start = 0;
  const n = s.length;
  for (;;) {
    while (i < n && (s.charCodeAt(i) >= 128 || INLINE_SPECIAL[s.charCodeAt(i)] === 0)) i++;
    if (i > start) out += escapeHtml(s.slice(start, i));
    if (i >= n) break;
    const c = s.charCodeAt(i);
    if (c === 92) {
      // '\'
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        out += escapeHtml(s[i + 1]);
        i += 2;
      } else {
        out += '\\';
        i++;
      }
    } else if (c === 96) {
      // '`'
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
      } else {
        out += '`';
        i++;
      }
    } else if (c === 42) {
      // '*'
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, j), link)}</strong>`;
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          out += `<em>${inline(s.slice(i + 1, j), link)}</em>`;
          i = j + 1;
        } else {
          out += '*';
          i++;
        }
      }
    } else {
      // '['
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS.test(target)) {
        out += `<a href="${escapeHtml(link(target))}">${inline(s.slice(i + 1, k), link)}</a>`;
        i = m + 1;
      } else {
        out += '[';
        i++;
      }
    }
    start = i;
  }
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or ""). Lexing
 * and rendering run in one pass; no token list is built.
 */
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const len = line.length;
    if (len === 0) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
      // a non-blank indented line is paragraph text
    } else if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        i++;
        const body = [];
        while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        parts.push(`<pre><code${cls}>${body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`}</code></pre>\n`);
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text), ids);
        const html = inline(h.text, link);
        parts.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>\n`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        parts.push('<hr>\n');
        i++;
        continue;
      }
      if (len > 1 && line.charCodeAt(1) === 32) {
        // bullet list: "-" or "*" then a space
        const items = [];
        while (i < n) {
          const l = lines[i];
          const ll = l.length;
          if (ll > 1 && (l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) {
            items.push(trimLine(l.slice(2)));
            i++;
          } else if (CONTINUED.test(l)) {
            items[items.length - 1] += `\n${trimLine(l)}`;
            i++;
          } else break;
        }
        parts.push(`<ul>\n${items.map((item) => `<li>${inline(item, link)}</li>\n`).join('')}</ul>\n`);
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let q = lines[i].slice(1);
        if (q.charCodeAt(0) === 32) q = q.slice(1);
        q = trimLine(q);
        if (q !== '') body.push(q);
        i++;
      }
      parts.push(body.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(body.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const m = ORDERED.exec(line);
      if (m !== null) {
        const start = Number(m[1]);
        const items = [trimLine(m[2])];
        i++;
        while (i < n) {
          const l = lines[i];
          const mm = ORDERED.exec(l);
          if (mm !== null) {
            items.push(trimLine(mm[2]));
            i++;
          } else if (CONTINUED.test(l)) {
            items[items.length - 1] += `\n${trimLine(l)}`;
            i++;
          } else break;
        }
        const open = start !== 1 ? `<ol start="${start}">` : '<ol>';
        parts.push(`${open}\n${items.map((item) => `<li>${inline(item, link)}</li>\n`).join('')}</ol>\n`);
        continue;
      }
    }
    // paragraph
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    parts.push(`<p>${html}</p>\n`);
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. The message is the whole report line. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

const T_BLANK = /^[ \t]*$/;

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone {% %} tag's line taken with it. */
function tokenizeTemplate(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = T_BLANK.test(src.slice(lineStart, open)) && T_BLANK.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTemplate(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The path segment `k` of `v`: its own property, or undefined. */
function getSeg(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

/**
 * A parsed template compiled to `function (s, d, C)`: `s` is the scope — a null-prototype object whose own properties
 * are the innermost bindings and whose prototype is the enclosing scope, so `s[name]` is exactly the reference's
 * first-name lookup. `d` is the include depth. `C` carries the helpers and the table of compiled templates:
 *   C.e = escapeHtml, C.t = textOf, C.g = getSeg, C.y = truthy, C.f = compiled functions (fnIndex order).
 */
function compileTemplate(nodes, fnIndex) {
  let uid = 0;
  const exprOf = (path, s) => {
    let e = `${s}[${JSON.stringify(path[0])}]`;
    for (let k = 1; k < path.length; k++) e = `C.g(${e},${JSON.stringify(path[k])})`;
    return e;
  };
  const emit = (list, s) => {
    let code = '';
    for (const n of list) {
      switch (n.kind) {
        case 'text':
          code += `o+=${JSON.stringify(n.text)};`;
          break;
        case 'var':
          code += `o+=C.e(C.t(${exprOf(n.path, s)}));`;
          break;
        case 'raw':
          code += `o+=C.t(${exprOf(n.path, s)});`;
          break;
        case 'if':
          code += `if(${n.not ? '!' : ''}C.y(${exprOf(n.path, s)})){${emit(n.then, s)}}`;
          if (n.else !== null) code += `else{${emit(n.else, s)}}`;
          break;
        case 'for': {
          const id = ++uid;
          const sn = `s${id}`;
          code += `{const xs${id}=${exprOf(n.path, s)};if(Array.isArray(xs${id})){const L${id}=xs${id}.length;for(let k${id}=0;k${id}<L${id};k${id}++){const ${sn}=Object.create(${s});${sn}[${JSON.stringify(n.name)}]=xs${id}[k${id}];${sn}.loop={index:k${id}+1,first:k${id}===0,last:k${id}===L${id}-1,length:L${id}};${emit(n.body, sn)}}}}`;
          break;
        }
        case 'include': {
          const ti = fnIndex.get(n.name);
          if (ti !== undefined) code += `o+=d<${INCLUDE_DEPTH}?C.f[${ti}](${s},d+1,C):'';`;
          break;
        }
      }
    }
    return code;
  };
  return new Function('s', 'd', 'C', `let o='';${emit(nodes, 's')}return o;`);
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const TRAIL_SLASH = /\/+$/;
const CRLF = /\r\n?/g;

/** One site's output tree: path -> text. Identical to makefun-site 1.0.0's build for every input. */
export function run(input) {
  // Templates: parsed in code-unit order of name; a failure is reported and the template left out.
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  const parsed = new Map();
  for (const name of names) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const fnIndex = new Map();
  const fns = [];
  for (const name of names) {
    if (parsed.has(name)) {
      fnIndex.set(name, fns.length);
      fns.push(null);
    }
  }
  const C = { e: escapeHtml, t: textOf, g: getSeg, y: truthy, f: fns };
  for (const name of names) {
    const nodes = parsed.get(name);
    if (nodes !== undefined) fns[fnIndex.get(name)] = compileTemplate(nodes, fnIndex);
  }

  const base = input.site.base_url.replace(TRAIL_SLASH, '');

  // Sources, in code-unit order of path, line ends made "\n"; a file that is not .md is static.
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(CRLF, '\n') });
    else statics.push(f);
  }

  // Front matter, in order: a refused source and a draft are reported and dropped.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!parsed.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  const slugCache = new Map();
  const slugOf = (t) => {
    let v = slugCache.get(t);
    if (v === undefined) {
      v = slugify(t);
      slugCache.set(t, v);
    }
    return v;
  };
  const dateCache = new Map();
  const longOf = (d) => {
    let v = dateCache.get(d);
    if (v === undefined) {
      v = longDate(d);
      dateCache.set(d, v);
    }
    return v;
  };

  // Permalinks: a post's directory is posts/, a page's its own; the slug is unique in the directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved against the built pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // The posts, newest date first and equal dates by slug; newer/older neighbours in that order.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // The tags: each slug once (first spelling kept), named as first met in collection order, by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slugOf(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push([name, sl]);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const [name, sl] of ownTags(p)) {
      let t = bySlug.get(sl);
      if (t === undefined) {
        t = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        bySlug.set(sl, t);
      }
      t.posts.push(p);
      p.tagRefs.push(t);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map(([name, sl]) => bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards and pages as the templates read them.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longOf(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longOf(s.data.date) };
  const pageOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longOf(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: s.post ? linkOf(s.newer) : null,
    older: s.post ? linkOf(s.older) : null,
    is_post: s.post,
  });

  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const scopeFor = (extra) => Object.assign(Object.create(null), { site, tags: allTags, recent }, extra);

  const output = {};

  // Every page through its layout.
  for (const s of kept) {
    output[`${s.outDir}/index.html`] = fns[fnIndex.get(s.layout)](scopeFor({ page: pageOf(s) }), 0, C);
  }

  // The index: site.per_page posts a page, at least one even with no posts.
  const indexFn = fnIndex.has('index') ? fns[fnIndex.get('index')] : null;
  if (indexFn !== null) {
    const per = input.site.per_page;
    const pages = Math.max(1, Math.ceil(posts.length / per));
    for (let k = 1; k <= pages; k++) {
      const url = k === 1 ? `${base}/` : `${base}/page/${k}/`;
      const html = indexFn(
        scopeFor({
          posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
          pager: {
            number: k,
            total: pages,
            url,
            newer_url: k === 1 ? '' : k - 1 === 1 ? `${base}/` : `${base}/page/${k - 1}/`,
            older_url: k === pages ? '' : `${base}/page/${k + 1}/`,
          },
        }),
        0,
        C,
      );
      output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
  }

  // The tag pages and the tags index.
  const tagFn = fnIndex.has('tag') ? fns[fnIndex.get('tag')] : null;
  if (tagFn !== null) {
    for (const t of tags) {
      output[`tags/${t.slug}/index.html`] = tagFn(scopeFor({ tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } }), 0, C);
    }
  }
  const tagsFn = fnIndex.has('tags') ? fns[fnIndex.get('tags')] : null;
  if (tagsFn !== null) output['tags/index.html'] = tagsFn(scopeFor({}), 0, C);

  // Static files at their own paths, unless a built page has that path.
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line, sorted in code-unit order, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pagesCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
