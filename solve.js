// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// Written from scratch against makefun-site's README and reference behaviour:
// same inputs in, same output tree out, byte for byte. The speed comes from
// doing the same work with less allocation: one-pass Markdown rendering
// (no token objects), chunk-based inline rendering (no per-character escape),
// index-based front-matter parsing (no whole-text split + rejoin), regex
// slugs, and templates compiled to a flat op list rendered by one loop
// (V8's string ropes make plain += the cheapest way to build a page).
//
// No dependencies, no I/O, no clock, no randomness: the answer is a function
// of the input alone, exactly as the reference's is.

/* ------------------------------------------------------------------ text */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_TEST = /[&<>"']/;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return ESCAPE_TEST.test(text) ? text.replace(ESCAPE_RE, (c) => ESCAPES[c]) : text;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * SLUG_MAX characters (a "-" left at the cut dropped), "untitled" when
 * nothing is left. Same result as the reference's per-character walk: a
 * separator run collapses to one "-", leading/trailing runs vanish, and the
 * cut happens before the trailing "-" is dropped.
 */
const NON_ASCII_RE = /[^\x00-\x7F]/;

function slugify(text) {
  let s = NON_ASCII_RE.test(text) ? text.normalize('NFKD').replace(/\p{M}/gu, '') : text;
  s = s.replace(/[^a-zA-Z0-9]+/g, '-');
  if (s.charCodeAt(0) === 45) s = s.replace(/^-+/, '');
  s = s.slice(0, SLUG_MAX);
  if (s.charCodeAt(s.length - 1) === 45) s = s.replace(/-+$/, '');
  return s === '' ? 'untitled' : s.toLowerCase();
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = 2;
  let out = slug + '-2';
  while (taken.has(out)) { n++; out = slug + '-' + n; }
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The words of a body: its runs of characters other than whitespace. A manual
 * scan avoids building the array /\S+/g would allocate; the whitespace set is
 * exactly JavaScript's \s (space, \t, \n, \r, \f, \v, U+00A0, U+1680,
 * U+2000- U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 10 || c === 9 || c === 13 || c === 12 || c === 11 || c === 160 ||
      c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
      c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) { n++; inWord = true; }
  }
  return n;
}

/* ------------------------------------------------------------ front matter */

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return 'a quoted string is not closed';
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return 'a quoted string holds an escape other than \\" or \\';
        out += n;
        i++;
      } else if (c === '"') return 'a quoted string holds a stray quote';
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return 'a bare string opens on [';
  return { value: raw };
}

/** One key's value, or the reason it is refused. Returns {value} or a string error. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return typeof s === 'string' ? `key "${key}": ${s}` : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return 'key "tags": not a list [a, b]';
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        tags[i] = tags[i].trim();
        if (tags[i] === '' || !TAG_RE.test(tags[i])) return 'key "tags": an empty tag, or one holding " [ or ]';
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : 'key "draft": true or false';
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : 'key "layout": not a template name';
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : 'key "slug": not a slug';
    default:
      return `unknown key "${key}"`;
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The closing "---"
 * is found by index instead of splitting the whole source: the header is a
 * handful of lines, the body is not touched until the Markdown pass splits
 * it once.
 */
function parseFrontMatter(text) {
  const firstNL = text.indexOf('\n');
  if (firstNL !== 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) {
    if (firstNL === -1 && text === '---') return { error: 'the front matter is not closed' };
    return { error: 'no front matter' };
  }
  let closeAt = text.indexOf('\n---\n', 3);
  let bodyStart;
  if (closeAt !== -1) bodyStart = closeAt + 5;
  else if (text.endsWith('\n---')) { closeAt = text.length - 4; bodyStart = text.length; }
  else return { error: 'the front matter is not closed' };
  const data = {};
  const header = text.slice(4, closeAt);
  if (header !== '') {
    const lines = header.split('\n');
    for (let h = 0; h < lines.length; h++) {
      const line = lines[h];
      if (line === '' || /^[ \t]*$/.test(line) || line.charCodeAt(0) === 35) continue;
      // LINE: ^([a-z_]+):(?: (.*))?$
      let i = 0;
      while (i < line.length) {
        const c = line.charCodeAt(i);
        if ((c >= 97 && c <= 122) || c === 95) i++;
        else break;
      }
      if (i === 0 || line.charCodeAt(i) !== 58) return { error: `line ${h + 2} is not "key: value"` };
      const key = line.slice(0, i);
      const rest = line.slice(i + 1);
      let raw;
      if (rest === '') raw = '';
      else if (rest.charCodeAt(0) === 32) raw = rest.slice(1).replace(/[ \t]+$/, '');
      else return { error: `line ${h + 2} is not "key: value"` };
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if (typeof v === 'string') return { error: v };
      data[key] = v.value;
    }
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

/* ---------------------------------------------------------------- markdown */

const BLANK_RE = /^[ \t]*$/;
const FENCE_OPEN_RE = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE_RE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const CONTINUED_RE = /^ {2,}\S/;
const TRIM_RE = /^[ \t]+|[ \t]+$/g;

function headingOf(line) {
  const m = HEADING_RE.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  const c = line.length === 0 ? -1 : line.charCodeAt(0);
  if (c === -1) return true;
  if (c === 96) return FENCE_OPEN_RE.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return HR_RE.test(line);
  if (c === 32 || c === 9) return BLANK_RE.test(line);
  return false;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Plain runs
 * between the special characters are copied untouched (they hold nothing the
 * escape table names), so no per-character escaping happens.
 */
const INLINE_SPECIAL = /[\\`*\u005b&<>"']/g;

function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  INLINE_SPECIAL.lastIndex = 0;
  while (i < n) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    if (m === null) { out += s.slice(i); break; }
    const j = m.index;
    if (j > i) out += s.slice(i, j);
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) { out += ESCAPES[s[j + 1]] ?? s[j + 1]; i = j + 2; }
      else { out += '\\'; i = j + 1; }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) { out += '<code>' + escapeHtml(s.slice(j + 1, k)) + '</code>'; i = k + 1; }
      else { out += '`'; i = j + 1; }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) { out += '<strong>' + inline(s.slice(j + 2, k), env) + '</strong>'; i = k + 2; }
        else { out += '**'; i = j + 2; }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) { out += '<em>' + inline(s.slice(j + 1, k), env) + '</em>'; i = k + 1; }
        else { out += '*'; i = j + 1; }
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const p = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = p === -1 ? '' : s.slice(k + 2, p);
      if (target !== '' && !/\s/.test(target)) {
        out += '<a href="' + escapeHtml(env.link(target)) + '">' + inline(s.slice(j + 1, k), env) + '</a>';
        i = p + 1;
      } else { out += '['; i = j + 1; }
      continue;
    }
    out += ESCAPES[c];
    i = j + 1;
  }
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and
 * its inline HTML) and its excerpt (the first paragraph's inline HTML, or
 * ""). Rendered in one pass over the lines, without token objects.
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
    // Blank line (empty, or spaces/tabs only).
    if (c0 === -1 || ((c0 === 32 || c0 === 9) && BLANK_RE.test(line))) { i++; continue; }
    // A line that cannot start a block is paragraph text: dispatch on the
    // first character so most lines skip the block regexes entirely.
    if (c0 !== 96 && c0 !== 35 && c0 !== 45 && c0 !== 42 && c0 !== 62 && !(c0 >= 48 && c0 <= 57) && c0 !== 32 && c0 !== 9) {
      const body = [trimLine(line)];
      i++;
      while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
      const html = inline(body.join('\n'), env);
      if (excerpt === null) excerpt = html;
      blocks.push(`<p>${html}</p>`);
      continue;
    }
    if (c0 === 32 || c0 === 9) {
      // Indented line: text, never code.
      const body = [trimLine(line)];
      i++;
      while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
      const html = inline(body.join('\n'), env);
      if (excerpt === null) excerpt = html;
      blocks.push(`<p>${html}</p>`);
      continue;
    }
    const fence = c0 === 96 ? FENCE_OPEN_RE.exec(line) : null;
    if (fence !== null) {
      const body = [];
      i++;
      while (i < n && !FENCE_CLOSE_RE.test(lines[i])) body.push(lines[i++]);
      i++;
      let code = '';
      for (let b = 0; b < body.length; b++) code += escapeHtml(body[b]) + '\n';
      blocks.push(fence[1] === '' ? `<pre><code>${code}</code></pre>` : `<pre><code class="language-${fence[1]}">${code}</code></pre>`);
      continue;
    }
    const heading = c0 === 35 ? headingOf(line) : null;
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if ((c0 === 45 || c0 === 42) && HR_RE.test(line)) { blocks.push('<hr>'); i++; continue; }
    if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) body.push(lines[i++].replace(/^> ?/, ''));
      const kept = [];
      for (let b = 0; b < body.length; b++) {
        const t = trimLine(body[b]);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = (c0 === 45 || c0 === 42) ? BULLET_RE.exec(line) : null;
    const ordered = bullet === null && c0 >= 48 && c0 <= 57 ? ORDERED_RE.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED_RE : BULLET_RE;
      const items = [];
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (CONTINUED_RE.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const start = isOrdered ? Number(ordered[1]) : 1;
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let list = open + '\n';
      for (let k = 0; k < items.length; k++) list += `<li>${inline(items[k].join('\n'), env)}</li>\n`;
      blocks.push(list + `</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (let b = 0; b < blocks.length; b++) html += blocks[b] + '\n';
  return { html, toc, excerpt: excerpt ?? '' };
}

/* ---------------------------------------------------------------- templates */

const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/**
 * `src` parsed into a flat op list (text, var, raw, if, for, include) with
 * jump targets resolved at parse time, so rendering is one loop over the
 * list with no tree walk and no per-node object dispatch. Ops:
 *  [0,'text',string] [1,'var',path] [2,'raw',path] [3,'if',path,not,elsePc,endPc]
 *  [4,'for',name,path,endPc] [5,'include',name] [6,'endfor'] [7,'else',endPc] [8,'endif']
 * `endPc` is the index just past the matching end tag (or of the else op).
 * A for's body runs from its op+1 to its endPc; an if's then-branch from
 * op+1 to elsePc (or endPc), its else-branch from elsePc+1 to endPc.
 */
function parseTemplate(name, src) {
  const ops = [];
  // Tokenize first, exactly as the reference does (a {% %} tag alone on its
  // line takes the whole line with it, its \n included).
  let text = '';
  let i = 0;
  const tokens = [];
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
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
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });

  const stack = [];
  for (const tok of tokens) {
    if (tok.t === 'text') { ops.push([0, tok.text]); continue; }
    if (tok.t === 'var' || tok.t === 'raw') { ops.push([tok.t === 'var' ? 1 : 2, tok.path]); continue; }
    const tag = tok.tag;
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const op = [4, m[1], pathOf(name, m[2]), -1];
      stack.push(op);
      ops.push(op);
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const op = [3, pathOf(name, m[2]), m[1] !== undefined, -1, -1];
      stack.push(op);
      ops.push(op);
    } else if (tag === 'else') {
      const top = stack[stack.length - 1];
      if (top === undefined || top[0] !== 3 || top[3] !== -1) throw new TemplateError(`template "${name}": an else outside an if`);
      top[3] = ops.length;
      ops.push([7, -1]);
    } else if (tag === 'endfor' || tag === 'endif') {
      const top = stack[stack.length - 1];
      const want = tag === 'endfor' ? 4 : 3;
      if (top === undefined || top[0] !== want) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      if (want === 4) {
        top[3] = ops.length + 1;
        ops.push([6]);
      } else {
        top[4] = ops.length + 1;
        if (top[3] !== -1) ops[top[3]][1] = top[4];
        else top[3] = top[4];
        ops.push([8]);
      }
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      ops.push([5, m[1]]);
    } else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
  }
  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    throw new TemplateError(`template "${name}": a ${top[0] === 4 ? 'for' : 'if'} is not closed`);
  }
  return ops;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let k = 0; k < v.length; k++) { if (k > 0) out += ', '; out += textOf(v[k]); }
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `ops` rendered in `scope` ({ vars, parent }). `ctx` holds the parsed templates (a Map of name to ops; a
 * template that did not parse absent) and the include depth. Loops and
 * branches are handled by an explicit control stack instead of recursion,
 * so a template with many loop iterations costs no call depth per item.
 */
function renderOps(ops, scope, ctx, depth) {
  let out = '';
  // Control stack entries: {pc, end, scope, name, xs, k} for an active for.
  const ctrl = [];
  let pc = 0;
  let cur = scope;
  while (pc < ops.length) {
    const op = ops[pc];
    switch (op[0]) {
      case 0: out += op[1]; pc++; break;
      case 1: out += escapeHtml(textOf(lookup(cur, op[1]))); pc++; break;
      case 2: out += textOf(lookup(cur, op[1])); pc++; break;
      case 3: {
        const v = truthy(lookup(cur, op[1]));
        if (v !== op[2]) pc++;
        else if (op[3] !== op[4]) pc = op[3] + 1;
        else pc = op[4];
        break;
      }
      case 4: {
        const xs = lookup(cur, op[2]);
        if (!Array.isArray(xs) || xs.length === 0) { pc = op[3]; break; }
        const vars = {};
        vars[op[1]] = xs[0];
        vars.loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
        ctrl.push({ pc, end: op[3], scope: cur, name: op[1], xs, k: 0 });
        cur = { vars, parent: cur };
        pc++;
        break;
      }
      case 5: {
        const t = ctx.templates.get(op[1]);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderOps(t, cur, ctx, depth + 1);
        pc++;
        break;
      }
      case 6: {
        const f = ctrl[ctrl.length - 1];
        const k = f.k + 1;
        if (k < f.xs.length) {
          f.k = k;
          f.scope = cur.parent;
          const vars = {};
          vars[f.name] = f.xs[k];
          vars.loop = { index: k + 1, first: false, last: k === f.xs.length - 1, length: f.xs.length };
          cur = { vars, parent: f.scope };
          pc = f.pc + 1;
        } else {
          ctrl.pop();
          cur = f.scope;
          pc = f.end;
        }
        break;
      }
      case 7: pc = op[1]; break; // else: reached by falling through the then-branch, skip the else-branch
      case 8: pc++; break; // endif
    }
  }
  return out;
}

/* -------------------------------------------------------------------- build */

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const dirOf = (path) => {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
};

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

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : {
  title: s.data.title,
  url: s.url,
  date: s.data.date ?? '',
  date_long: s.data.date === undefined ? '' : longDate(s.data.date),
});

/** A post's card, as lists show it. The reading time is counted once per
 * source and kept on it, and the card itself is built once per source and
 * kept on it: a post's card is needed twice (once for the lists, once for
 * its own page), with the same values both times. */
function cardOf(s) {
  let card = s.card;
  if (card !== undefined) return card;
  let rm = s.reading_minutes;
  if (rm === undefined) {
    rm = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
    s.reading_minutes = rm;
  }
  card = {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: rm,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
  s.card = card;
  return card;
}

/** A page as its layout reads it. */
function pageOf(s) {
  const card = cardOf(s);
  return {
    title: card.title,
    url: card.url,
    date: card.date,
    date_long: card.date_long,
    summary: card.summary,
    excerpt: card.excerpt,
    reading_minutes: card.reading_minutes,
    tags: card.tags,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  // Templates, parsed in code-unit order of name; one that does not parse
  // is reported and left out, as if it were not there.
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let n = 0; n < names.length; n++) {
    const name = names[n];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of path; line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in source order; the first failing check is reported.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  // 3. Permalinks: each slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // 4. Markdown, each body's links resolved to the pages and static files.
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
        if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, equal dates by slug; neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags: grouped by slug, named as first met in collection order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (let i = 0; i < tags.length; i++) {
      const slug = slugify(tags[i]);
      if (!seen.has(slug)) { seen.add(slug); out.push(tags[i]); }
    }
    return out;
  };
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const names = ownTags(p);
    for (let j = 0; j < names.length; j++) {
      const slug = slugify(names[j]);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name: names[j], slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts: every page through its layout, index and tag pages.
  const cards = new Map();
  for (let i = 0; i < posts.length; i++) cards.set(posts[i], cardOf(posts[i]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  const render = (name, vars) => {
    const ops = templates.get(name);
    if (ops === undefined) return null;
    return renderOps(ops, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0);
  };
  const output = {};
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const html = render('tag', { tag: tagOf(tags[i]) });
    if (html !== null) output['tags/' + tags[i].slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  let pageCount = 0;
  for (let i = 0; i < kept.length; i++) if (!kept[i].post) pageCount++;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = lines.join('\n') + '\n';
  return output;
}
