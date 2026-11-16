// A from-scratch Markdown renderer whose output matches marked 18.1.3
// (default options: GFM on, hard breaks off) for every input string.
// The design is a two-pass scanner: first the block layout is resolved
// from lines, then each inline span is tokenized and its delimiters
// are paired. No dependency, no shared code with marked.
//
// Order of the file: character classification and escaping helpers,
// line geometry, HTML tag scanners, inline link/autolink machinery,
// the delimiter pairing engine, the inline tokenizer, the block
// lexer (headings, fences, lists, quotes, tables, HTML blocks),
// rendering, and the exported parse() function.

// ------------------------------------------------------------------
// Characters, escaping, entities, links
// ------------------------------------------------------------------

// The replacement text for each escapable character.
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// The ASCII punctuation set, as one string, for table building.
const PUNCT_CHARS = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

// 128-slot lookup: 1 where the code is ASCII punctuation.
const PUNCT_LUT = new Uint8Array(128);
for (let k = 0; k < PUNCT_CHARS.length; k++) PUNCT_LUT[PUNCT_CHARS.charCodeAt(k)] = 1;

// Unicode punctuation-or-symbol test, for characters past ASCII.
const PUNCT_RE = /[\p{P}\p{S}]/u;
// The usual whitespace test.
const SPACE_RE = /\s/;

// Is `ch` one of the six ASCII whitespace characters? Empty input
// is not whitespace here.
function isWS(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
}

// Is `ch` punctuation, ASCII or Unicode? Empty input is not.
function isPunct(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return c < 128 ? PUNCT_LUT[c] === 1 : PUNCT_RE.test(ch);
}

// Is `ch` whitespace in the Unicode sense? The empty string (either
// end of the input) counts as whitespace for flanking.
function isSpacey(ch) {
  return ch === '' || ch === undefined || SPACE_RE.test(ch);
}

// Is `ch` ASCII punctuation? Used for backslash escapes.
function asciiPunct(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return c < 128 && PUNCT_LUT[c] === 1;
}

// Does an entity-shaped reference begin at `str[pos]` (which holds
// '&')? marked's text escaping leaves `&name;`, `&#123;` and
// `&#x1F;` untouched and rewrites every other ampersand. Numeric
// references allow at most 7 decimal or 6 hexadecimal digits.
function entityAhead(str, pos) {
  const n = str.length;
  let p = pos + 1;
  if (str[p] === '#') {
    p++;
    if (str[p] === 'x' || str[p] === 'X') {
      p++;
      const start = p;
      while (p < n && p - start < 6) {
        const c = str.charCodeAt(p);
        if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102))) break;
        p++;
      }
      return p > start && str[p] === ';';
    }
    const start = p;
    while (p < n && p - start < 7) {
      const c = str.charCodeAt(p);
      if (c < 48 || c > 57) break;
      p++;
    }
    return p > start && str[p] === ';';
  }
  const start = p;
  while (p < n) {
    const c = str.charCodeAt(p);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122))) break;
    p++;
  }
  return p > start && str[p] === ';';
}

// Escape a string for HTML. In strict mode every `& < > " '` is
// rewritten; otherwise an ampersand starting an entity-shaped
// reference is kept as-is.
function esc(str, strict) {
  const finder = /[&<>"']/g;
  let hit = finder.exec(str);
  if (hit === null) return str;
  let out = '';
  let plain = 0;
  for (;;) {
    const at = hit.index;
    const ch = hit[0];
    out += str.slice(plain, at);
    out += (ch === '&' && !strict && entityAhead(str, at)) ? '&' : ESC_MAP[ch];
    plain = at + 1;
    hit = finder.exec(str);
    if (hit === null) break;
  }
  return out + str.slice(plain);
}

// What a numeric character reference decodes to: 0, surrogates and
// values above U+10FFFF become U+FFFD, 38 becomes the entity
// `&amp;`, anything else becomes its own character.
function numRefChar(code) {
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
  if (code === 38) return '&amp;';
  return String.fromCodePoint(code);
}

// Decode the numeric character references in a string, marked's way.
function decodeNumRefs(str) {
  if (str.indexOf('&#') === -1) return str;
  return str.replace(/&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/g, (whole, dec, hex) =>
    numRefChar(dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16)));
}

// marked's URL cleaning for href/src: encodeURI, with encoded
// percent signs restored. An unencodable URL gives null, and the
// link then renders as its inner content only.
function cleanHref(href) {
  let cleaned;
  try {
    cleaned = encodeURI(href);
  } catch {
    return null;
  }
  return cleaned.replace(/%25/g, '%');
}

// Fold a link label for definition lookup: trim, collapse each
// whitespace run to one space, then fold case (lower, upper, lower).
function normLabel(str) {
  return str.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Remove the backslash from backslash-punctuation pairs in link
// destinations, titles and fence info strings.
function unescPunct(str) {
  return str.replace(/\\([\p{P}\p{S}])/gu, '$1');
}

// ------------------------------------------------------------------
// Line geometry
// ------------------------------------------------------------------

// True when a line holds only spaces and tabs (or nothing at all).
function blankLine(line) {
  return /^[ \t]*$/.test(line);
}

// True when the line at `idx` acts blank inside a block run. A
// whitespace-only line is blank only when a newline follows it; at
// the very end of the input, with no trailing newline, it is
// ordinary text. A truly empty line is always blank.
function blankAt(lines, idx, end, endsWithNL) {
  if (!blankLine(lines[idx])) return false;
  if (idx + 1 < end) return true;
  if (endsWithNL) return true;
  return lines[idx] === '';
}

// The leading indent of a line as [visual columns, char index of
// the first non-blank character]. A tab jumps to the next multiple
// of four columns.
function leadIndent(line) {
  let cols = 0;
  let pos = 0;
  const n = line.length;
  while (pos < n) {
    const c = line.charCodeAt(pos);
    if (c === 32) { cols++; pos++; }
    else if (c === 9) { cols += 4 - (cols % 4); pos++; }
    else break;
  }
  return [cols, pos];
}

// Remove `n` visual columns from the front of a line. A tab that
// straddles the cut leaves the spaces on the kept side behind.
function dropCols(line, n) {
  let cols = 0;
  let pos = 0;
  const total = line.length;
  while (pos < total && cols < n) {
    const c = line.charCodeAt(pos);
    if (c === 32) { cols++; pos++; }
    else if (c === 9) {
      const w = 4 - (cols % 4);
      if (cols + w > n) return ' '.repeat(cols + w - n) + line.slice(pos + 1);
      cols += w;
      pos++;
    } else break;
  }
  return line.slice(pos);
}

// Expand the tabs in a line's leading whitespace to spaces,
// tracking columns from zero. The rest of the line is untouched.
function expandLead(line) {
  if (line.indexOf('\t') === -1) return line;
  let pos = 0;
  let col = 0;
  let head = '';
  while (pos < line.length) {
    const ch = line[pos];
    if (ch === ' ') { head += ' '; col++; pos++; }
    else if (ch === '\t') {
      const w = 4 - (col % 4);
      head += ' '.repeat(w);
      col += w;
      pos++;
    } else break;
  }
  return head + line.slice(pos);
}

// Trim the trailing blank lines of a raw block text the way marked's
// helper does: with at most one trailing blank line the text is
// kept whole; otherwise it is cut back to the last line holding
// content, with no trailing newline.
function trimTailBlanks(text) {
  const parts = text.split('\n');
  let last = parts.length - 1;
  while (last >= 0 && /^[ \t]*$/.test(parts[last])) last--;
  if (parts.length - last <= 2) return text;
  return parts.slice(0, last + 1).join('\n');
}

// Does the raw text of a list item end with a blank line? The item
// spans lines[a..b), joined with newlines, plus a trailing newline
// when `hasTrailingNL`. Only the final lines can decide, so no
// joined string is built.
function itemTailBlank(lines, a, b, hasTrailingNL) {
  if (b - a < 1) return false;
  if (hasTrailingNL) return b - a >= 2 && blankLine(lines[b - 1]);
  return b - a >= 3 && blankLine(lines[b - 1]) && blankLine(lines[b - 2]);
}

// Rebuild the raw source text of lines[a..b): the lines joined by
// '\n', plus a trailing newline when another line follows or the
// source ended with one.
function linesText(lines, a, b, endsWithNL) {
  let text = lines.slice(a, b).join('\n');
  if (b < lines.length || endsWithNL) text += '\n';
  return text;
}

// Index of the first character of `str` that is not a space, or -1.
function firstNonSpace(str) {
  let pos = 0;
  while (pos < str.length && str[pos] === ' ') pos++;
  return pos < str.length ? pos : -1;
}

// Count the leading spaces (characters, not columns) of `str`.
function spaceRun(str) {
  let pos = 0;
  while (pos < str.length && str[pos] === ' ') pos++;
  return pos;
}

// ------------------------------------------------------------------
// HTML tag scanning
// ------------------------------------------------------------------

// Tag names that can open an HTML block (CommonMark type 6).
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'meta', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param',
  'search', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'title', 'tr', 'track', 'ul',
]);

// Tag names whose HTML block runs until the matching close tag.
const RAWTEXT_TAGS = new Set(['pre', 'script', 'style', 'textarea']);

// Is this code an ASCII letter?
function alphaCode(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// The tag name beginning at `str[pos]` (the `<` is already consumed
// by the caller): a letter, then letters, digits and hyphens.
// Returned lower-cased, or '' when no name starts here.
function tagNameAt(str, pos) {
  const n = str.length;
  if (pos >= n || !alphaCode(str.charCodeAt(pos))) return '';
  let end = pos + 1;
  while (end < n) {
    const c = str.charCodeAt(end);
    if (!alphaCode(c) && !(c >= 48 && c <= 57) && c !== 45) break;
    end++;
  }
  return str.slice(pos, end).toLowerCase();
}

// Match one inline HTML tag beginning at `str[pos]` (str[pos] is
// '<'). Comments, processing instructions, CDATA sections,
// declarations and open/close tags are all covered. Returns the raw
// tag text, or null when the text here is not a tag.
function inlineTagAt(str, pos) {
  const n = str.length;
  if (str.startsWith('<!--', pos)) {
    // The short comments `<!-->` and `<!--->` finish immediately.
    if (str[pos + 4] === '>') return str.slice(pos, pos + 5);
    if (str[pos + 4] === '-' && str[pos + 5] === '>') return str.slice(pos, pos + 6);
    const close = str.indexOf('-->', pos + 4);
    return close === -1 ? str.slice(pos) : str.slice(pos, close + 3);
  }
  if (str.startsWith('<?', pos)) {
    const close = str.indexOf('?>', pos + 2);
    return close === -1 ? null : str.slice(pos, close + 2);
  }
  if (str.startsWith('<![CDATA[', pos)) {
    const close = str.indexOf(']]>', pos + 9);
    return close === -1 ? null : str.slice(pos, close + 3);
  }
  if (str.startsWith('<!', pos) && pos + 2 < n && alphaCode(str.charCodeAt(pos + 2))) {
    // A declaration: a name, then whitespace, then anything to `>`.
    let p = pos + 2;
    while (p < n && alphaCode(str.charCodeAt(p))) p++;
    if (p >= n || !isWS(str[p])) return null;
    const close = str.indexOf('>', p);
    return close === -1 ? null : str.slice(pos, close + 1);
  }
  let p = pos + 1;
  let closing = false;
  if (str[p] === '/') { closing = true; p++; }
  const name = tagNameAt(str, p);
  if (name === '') return null;
  p += name.length;
  if (closing) {
    while (p < n && isWS(str[p])) p++;
    return p < n && str[p] === '>' ? str.slice(pos, p + 1) : null;
  }
  // Open tag: what follows the name must be whitespace, `>` or
  // `/>`, and every attribute starts after whitespace, so `<a
  // href=...>` parses but `<https:` never does.
  for (;;) {
    if (p >= n) return null;
    const ch = str[p];
    if (ch === '>') return str.slice(pos, p + 1);
    if (ch === '/' && str[p + 1] === '>') return str.slice(pos, p + 2);
    if (!isWS(ch)) return null;
    while (p < n && isWS(str[p])) p++;
    if (p < n && str[p] === '>') return str.slice(pos, p + 1);
    if (p < n && str[p] === '/' && str[p + 1] === '>') return str.slice(pos, p + 2);
    if (p >= n) return null;
    // One attribute name.
    if (!/[A-Za-z_:]/.test(str[p])) return null;
    p++;
    while (p < n && /[\w.:-]/.test(str[p])) p++;
    const nameEnd = p;
    while (p < n && isWS(str[p])) p++;
    if (str[p] === '=') {
      p++;
      while (p < n && isWS(str[p])) p++;
      const quote = str[p];
      if (quote === '"' || quote === "'") {
        p++;
        while (p < n && str[p] !== quote) p++;
        if (p >= n) return null;
        p++;
      } else {
        const valueStart = p;
        while (p < n) {
          const d = str[p];
          if (isWS(d) || d === '"' || d === "'" || d === '=' || d === '<' || d === '>' || d === '`') break;
          p++;
        }
        if (p === valueStart) return null;
      }
    } else {
      // No `=`: the whitespace after the name belongs to whatever
      // comes next, so rewind to just past the name.
      p = nameEnd;
    }
  }
}

// A tag name at `str[pos]` where str[pos] is '<'. Returns
// [name, closing, end] with `end` just past the name, or null.
function tagHeadAt(str, pos) {
  let p = pos + 1;
  let closing = false;
  if (str[p] === '/') { closing = true; p++; }
  if (p >= str.length || !alphaCode(str.charCodeAt(p))) return null;
  const start = p;
  p++;
  while (p < str.length) {
    const c = str.charCodeAt(p);
    if (!alphaCode(c) && !(c >= 48 && c <= 57) && c !== 45) break;
    p++;
  }
  return [str.slice(start, p).toLowerCase(), closing, p];
}

// The narrow HTML-block start test marked uses when a line might
// interrupt a paragraph (or a lazy continuation, or a list item):
// block-level tags, pre/script/style/textarea open tags, comments,
// processing instructions, declarations and CDATA sections.
function htmlBreaksPara(str) {
  if (str.charCodeAt(0) !== 60) return false;
  if (str.startsWith('<!--') || str.startsWith('<?') || str.startsWith('<![CDATA[')) return true;
  if (str.startsWith('<!') && str.length > 2 && alphaCode(str.charCodeAt(2))) return true;
  const tag = tagHeadAt(str, 0);
  if (tag === null) return false;
  const [name, closing, end] = tag;
  const after = str[end];
  if (!closing && RAWTEXT_TAGS.has(name)) {
    return after === undefined || after === ' ' || after === '\t' || after === '>';
  }
  if (!BLOCK_TAGS.has(name)) return false;
  if (after === ' ' || after === '\t' || after === undefined || after === '>') return true;
  return after === '/' && str[end + 1] === '>';
}

// Scan a complete HTML tag beginning at `str[pos]` (str[pos] is
// '<'), honouring quoted attribute values, for the type-7 HTML
// block test. Returns the index just past the tag, or -1. A
// closing tag takes no attributes, and an attribute needs
// whitespace before it.
function fullTagEnd(str, pos) {
  const n = str.length;
  let p = pos + 1;
  const closing = str[p] === '/';
  if (closing) p++;
  if (p >= n || !alphaCode(str.charCodeAt(p))) return -1;
  while (p < n) {
    const c = str.charCodeAt(p);
    if (!alphaCode(c) && !(c >= 48 && c <= 57) && c !== 45) break;
    p++;
  }
  for (;;) {
    let gaps = 0;
    while (p < n && (str[p] === ' ' || str[p] === '\t' || str[p] === '\n')) { p++; gaps++; }
    if (p >= n) return -1;
    if (str[p] === '>') return p + 1;
    if (str[p] === '/' && str[p + 1] === '>') return p + 2;
    if (closing || gaps === 0) return -1;
    const a0 = str.charCodeAt(p);
    if (!alphaCode(a0) && a0 !== 95 && a0 !== 58) return -1;
    p++;
    while (p < n) {
      const c = str.charCodeAt(p);
      if (!alphaCode(c) && !(c >= 48 && c <= 57) && c !== 95 && c !== 46 && c !== 58 && c !== 45) break;
      p++;
    }
    const nameEnd = p;
    while (p < n && (str[p] === ' ' || str[p] === '\t')) p++;
    if (str[p] === '=') {
      p++;
      while (p < n && (str[p] === ' ' || str[p] === '\t')) p++;
      const quote = str[p];
      if (quote === '"' || quote === "'") {
        p++;
        while (p < n && str[p] !== quote && str[p] !== '\n') p++;
        if (p >= n || str[p] !== quote) return -1;
        p++;
      } else {
        const valueStart = p;
        while (p < n) {
          const d = str[p];
          if (d === ' ' || d === '\t' || d === '\n' || d === '"' || d === "'" ||
              d === '=' || d === '<' || d === '>' || d === '`') break;
          p++;
        }
        if (p === valueStart) return -1;
      }
    } else {
      p = nameEnd;
    }
  }
}

// ------------------------------------------------------------------
// Inline primitives
// ------------------------------------------------------------------

// Flanking of a delimiter run: whether it can open, whether it can
// close, from the characters around it. Follows the CommonMark
// left-flanking / right-flanking definitions, with Unicode
// whitespace and punctuation.
function flanks(before, after) {
  const beforeWs = before === '' || isSpacey(before);
  const afterWs = after === '' || isSpacey(after);
  const beforeP = isPunct(before);
  const afterP = isPunct(after);
  return {
    canOpen: !afterWs && (!afterP || beforeWs || beforeP),
    canClose: !beforeWs && (!beforeP || afterWs || afterP),
  };
}

// Match the code span whose opening backtick run starts at
// `str[pos]`. Returns {text, end} with `end` just past the closing
// run, or null when no closing run of the same length exists.
// Newlines inside become spaces, and one surrounding space is
// stripped from each side when the content holds a non-space
// character.
function codeSpanAt(str, pos) {
  const n = str.length;
  let run = 0;
  while (pos + run < n && str[pos + run] === '`') run++;
  let scan = pos + run;
  for (;;) {
    const tick = str.indexOf('`', scan);
    if (tick === -1) return null;
    let close = 0;
    while (tick + close < n && str[tick + close] === '`') close++;
    if (close === run && str[tick - 1] !== '`' && str[pos + run] !== '`') {
      let text = str.slice(pos + run, tick).replace(/\n/g, ' ');
      if (text.length > 0 && /[^ ]/.test(text) && text[0] === ' ' && text[text.length - 1] === ' ') {
        text = text.slice(1, -1);
      }
      return { text, end: tick + close };
    }
    scan = tick + close;
  }
}

// Skip a code span inside a link label, following marked's label
// pattern: a backtick run, non-backtick content, a backtick run
// (the runs need not match in length). Returns the index just past
// the closing run, or -1 when there is no closing run.
function skipLabelCode(str, pos) {
  const n = str.length;
  let run = 0;
  while (pos + run < n && str[pos + run] === '`') run++;
  const tick = str.indexOf('`', pos + run);
  if (tick === -1) return -1;
  let close = 0;
  while (tick + close < n && str[tick + close] === '`') close++;
  return tick + close;
}

// Read a bracketed label starting at `str[pos]` (str[pos] is '['),
// honouring nesting, backslash escapes and code spans. Returns
// {label, end} with `end` just past the closing bracket, or null.
function bracketAt(str, pos) {
  const n = str.length;
  let depth = 1;
  let p = pos + 1;
  while (p < n) {
    const ch = str[p];
    if (ch === '\\') { p += 2; continue; }
    if (ch === '`') {
      // A run of two or more backticks directly before `]` is plain
      // label text (marked's label pattern has its own alternative
      // for exactly that shape): it never opens a code span, even
      // when a later backtick run exists. A single backtick before
      // `]` does open one: with no closing run the label, and so
      // the link, dies here.
      let run = 0;
      while (p + run < n && str[p + run] === '`') run++;
      if (run >= 2 && str[p + run] === ']') { p += run; continue; }
      const past = skipLabelCode(str, p);
      if (past !== -1) { p = past; continue; }
      return null;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return { label: str.slice(pos + 1, p), end: p + 1 };
    }
    p++;
  }
  return null;
}

// marked's guard on link text: a raw `<` inside the label that
// opens a tag or autolink reaching past the label's end kills the
// link. `full` is the source from the link's start, `labelOff` the
// label's offset within it, `label` the label text.
function labelLeaks(full, labelOff, label) {
  const total = label.length;
  let p = 0;
  while (p < total) {
    const ch = label[p];
    if (ch === '\\') { p += 2; continue; }
    if (ch === '`') {
      const span = codeSpanAt(label, p);
      if (span) { p = span.end; continue; }
      p++;
      continue;
    }
    if (ch !== '<') { p++; continue; }
    const tail = full.slice(labelOff + p);
    const tag = inlineTagAt(tail, 0) || angleLinkAt(tail, 0);
    if (tag !== null && tag.length > total - p) return true;
    p += tag !== null ? tag.length : 1;
  }
  return false;
}

const ANG_EMAIL = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+(?![-_])/;
const ANG_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*/;

// Match `<scheme:...>` or `<user@host>` starting at `str[pos]`
// (str[pos] is '<'). Returns the matched text including the
// brackets, or null.
function angleLinkAt(str, pos) {
  const n = str.length;
  if (str[pos] !== '<') return null;
  const rest = str.slice(pos + 1);
  const email = ANG_EMAIL.exec(rest);
  if (email !== null) {
    const end = pos + 1 + email[0].length;
    if (end < n && str[end] === '>') return str.slice(pos, end + 1);
  }
  const scheme = ANG_SCHEME.exec(rest);
  if (scheme !== null) {
    const end = pos + 1 + scheme[0].length;
    if (end < n && str[end] === '>') return str.slice(pos, end + 1);
  }
  return null;
}

// ------------------------------------------------------------------
// Links and extended autolinks
// ------------------------------------------------------------------

// Read a link destination starting at `str[p]` (the first character
// after the opening paren and its whitespace). Returns
// {dest, end, ok}: the raw destination text, the index just past
// it, and whether it parsed. The `<...>` form forbids newlines and
// needs an even run of backslashes before its `>`; the bare form
// balances parentheses and stops at whitespace or a control
// character.
function readDest(str, p) {
  const n = str.length;
  if (str[p] === '<') {
    let close = -1;
    let m = p + 1;
    while (m < n) {
      if (str[m] === '\\') { m += 2; continue; }
      if (str[m] === '\n') break;
      if (str[m] === '>') { close = m; break; }
      m++;
    }
    if (close === -1) return { dest: '', end: p, ok: false };
    let slashes = 0;
    for (let t = close - 1; t >= p + 1 && str[t] === '\\'; t--) slashes++;
    if (slashes % 2 === 1) return { dest: '', end: p, ok: false };
    return { dest: str.slice(p + 1, close), end: close + 1, ok: true };
  }
  const start = p;
  let depth = 0;
  while (p < n) {
    const ch = str[p];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch.charCodeAt(0) < 0x20) break;
    if (ch === '\\') { p += 2; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) break;
      depth--;
    }
    p++;
  }
  return { dest: str.slice(start, p), end: p, ok: depth === 0 };
}

// Read an optional link title starting at `str[p]` (just past the
// destination). Returns {title, end} with `end` just past the
// closing quote, or null when no usable title follows. A title
// needs whitespace before it; a single-quoted title dies at a
// newline that a blank line follows.
function readTitle(str, p) {
  const n = str.length;
  if (!(str[p] === ' ' || str[p] === '\t' || str[p] === '\n')) return null;
  let q = p;
  if (str[q] === ' ' || str[q] === '\t') {
    while (str[q] === ' ' || str[q] === '\t') q++;
    if (str[q] === '\n') {
      q++;
      while (str[q] === ' ' || str[q] === '\t') q++;
    }
  } else {
    q++;
    while (str[q] === ' ' || str[q] === '\t') q++;
  }
  const quote = str[q];
  if (quote !== '"' && quote !== "'" && quote !== '(') return null;
  const closer = quote === '(' ? ')' : quote;
  let m = q + 1;
  let closed = false;
  while (m < n) {
    if (str[m] === '\\') { m += 2; continue; }
    if (str[m] === closer) { closed = true; break; }
    if (quote === "'" && str[m] === '\n') {
      let r = m + 1;
      while (r < n && (str[r] === ' ' || str[r] === '\t')) r++;
      if (str[r] === '\n' || r >= n) break;
    }
    m++;
  }
  if (!closed) return null;
  return { title: unescPunct(str.slice(q + 1, m)), end: m + 1 };
}

// Count the backslashes ending just before position `e`, stopping
// above `floor`. Used for the escaped-paren checks.
function trailingSlashes(str, e, floor) {
  let count = 0;
  for (let t = e - 1; t > floor && str[t] === '\\'; t--) count++;
  return count;
}

// Parse an inline link or image beginning at `str[pos]` (str[pos]
// is `[` or `!`). Returns {atom, end} or null. `ctx` is the shared
// inline state (definitions, link nesting, raw-block flag).
function linkAt(str, pos, ctx) {
  const image = str[pos] === '!';
  const open = image ? pos + 1 : pos;
  if (str[open] !== '[') return null;
  const bracket = bracketAt(str, open);
  if (bracket === null) return null;
  const label = bracket.label;
  const afterLabel = bracket.end;
  let href = null;
  let title = null;
  let rawEnd = -1;
  if (str[afterLabel] === '(') {
    // Inline form: `( destination title? )`. When it fails to
    // parse, the shortcut reference for the same label is tried
    // instead.
    let p = afterLabel + 1;
    while (p < str.length && (str[p] === ' ' || str[p] === '\t' || str[p] === '\n')) p++;
    const dest = readDest(str, p);
    let good = dest.ok;
    if (good) {
      p = dest.end;
      const titled = readTitle(str, p);
      if (titled !== null) {
        title = titled.title;
        p = titled.end;
      }
      let e = p;
      while (e < str.length && (str[e] === ' ' || str[e] === '\t' || str[e] === '\n')) e++;
      if (str[e] !== ')' || trailingSlashes(str, e, afterLabel) % 2 === 1) {
        good = false;
      } else {
        rawEnd = e + 1;
      }
    }
    if (good) {
      href = unescPunct(dest.dest);
    } else {
      const def = ctx.defs[normLabel(label)];
      if (!def) return null;
      href = def.href;
      title = def.title;
      rawEnd = afterLabel;
    }
  } else if (str[afterLabel] === '[') {
    // Full reference form [label][ref]. An undefined reference
    // leaves the whole construct literal: there is no fallback to
    // the shortcut form for the same opening bracket.
    const refBracket = bracketAt(str, afterLabel);
    if (refBracket === null) return null;
    const ref = refBracket.label === '' ? label : refBracket.label;
    const def = ctx.defs[normLabel(ref)];
    if (!def) return null;
    href = def.href;
    title = def.title;
    rawEnd = refBracket.end;
  } else {
    // Shortcut reference form [label].
    const def = ctx.defs[normLabel(label)];
    if (!def) return null;
    href = def.href;
    title = def.title;
    rawEnd = afterLabel;
  }
  if (labelLeaks(str.slice(pos), image ? 2 : 1, label)) return null;
  // Tokenize the label's own inline content, tracking nested links
  // the way marked's link builder does: a link inside a link kills
  // the outer link (but not an image).
  const keptLink = ctx.inLink;
  const keptSaw = ctx.sawLink;
  const keptRaw = ctx.inRaw;
  ctx.inLink = true;
  ctx.sawLink = false;
  const kids = tokenize(label, ctx);
  const nested = ctx.sawLink;
  ctx.inLink = keptLink;
  ctx.sawLink = keptSaw;
  if (!image) {
    if (nested) {
      ctx.inRaw = keptRaw;
      return null;
    }
    ctx.sawLink = true;
  }
  const atom = image
    ? { t: 'image', href, title, kids, label }
    : { t: 'link', href, title, kids, shown: label, auto: false };
  return { atom, end: rawEnd };
}

// Trim a candidate extended autolink the way marked's backpedal
// does: keep the longest prefix built from non-punctuation runs,
// balanced parenthesised groups, `&` not starting an entity, and
// punctuation runs that are not at the very end; repeat until the
// prefix stops changing. This cuts a URL off before an unmatched
// `(`.
const TRIM_URL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![A-Za-z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function trimUrl(candidate) {
  let current = candidate;
  for (;;) {
    const hit = TRIM_URL_RE.exec(current);
    const next = hit ? hit[0] : '';
    if (next === current) return next;
    current = next;
  }
}

// Sticky forms of the extended-autolink patterns: they run on the
// whole inline string with `lastIndex` at the candidate start, so
// no suffix slice is taken (that slice, at nearly every character,
// was the hottest allocation in the parser).
const P_PROTO = /(?:mailto|xmpp):[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?:\/[A-Za-z0-9@.]+)?(?![\w-])/y;
const P_WWW = /(?:www\.)(?:[A-Za-z0-9-]+\.?)+[^\s<]*/y;
const P_SCHEME = /(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/(?:[A-Za-z0-9-]+\.?)+[^\s<]*/y;
const P_MAIL = /[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?![\w-])/y;
const P_MAIL_NL = /[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+/y;

// Characters allowed in an email local part (all ASCII). A table
// lookup replaces a regex test that ran at nearly every position.
const MAIL_LOCAL_LUT = new Uint8Array(128);
for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+-/=?^_`{|}~") {
  MAIL_LOCAL_LUT[ch.charCodeAt(0)] = 1;
}
function mailLocalCh(ch) {
  return !!ch && mailLocalCode(ch.charCodeAt(0));
}
function mailLocalCode(code) {
  return code < 128 && MAIL_LOCAL_LUT[code] === 1;
}

// Try to match an extended autolink (www., scheme://, email,
// mailto:, xmpp:) starting at `pos`. Returns {atom, end} or null.
function extUrlAt(str, pos, ctx, atoms, masked) {
  if (ctx.inLink) return null;
  // Each pattern can only start on its own first letter, so the
  // regexes run only for those letters (109 m, 120 x, 119 w, 104 h,
  // 72 H, 102 f, 70 F). This runs at most at word starts, so
  // without the guards every word would pay for regex calls that
  // fail on their first character.
  const first = str.charCodeAt(pos);
  if (first === 109 || first === 120) {
    P_PROTO.lastIndex = pos;
    const hit = P_PROTO.exec(str);
    if (hit !== null) {
      const text = hit[0];
      return { atom: { t: 'link', href: text, title: null, kids: null, shown: text, auto: true }, end: pos + text.length };
    }
  }
  if (first === 119 && str.startsWith('www.', pos)) {
    const prev = pos === 0 ? '' : str[pos - 1];
    if (prev === '' || isWS(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(') {
      P_WWW.lastIndex = pos;
      const hit = P_WWW.exec(str);
      if (hit !== null) {
        const text = trimUrl(hit[0]);
        if (text.length > 4) {
          return { atom: { t: 'link', href: 'http://' + text, title: null, kids: null, shown: text, auto: true }, end: pos + text.length };
        }
      }
    }
  }
  if (first === 104 || first === 72 || first === 102 || first === 70) {
    P_SCHEME.lastIndex = pos;
    const hit = P_SCHEME.exec(str);
    if (hit !== null) {
      const text = trimUrl(hit[0]);
      return { atom: { t: 'link', href: text, title: null, kids: null, shown: text, auto: true }, end: pos + text.length };
    }
  }
  const prev = pos === 0 ? '' : str[pos - 1];
  if (mailLocalCh(str[pos]) && (prev === '' || !mailLocalCh(prev))) {
    // Cheap pre-check: an email needs an '@' after the local part.
    // Scan forward over local-part characters; with no '@' after
    // them the regex cannot match and is not run at all.
    let scan = pos;
    const total = str.length;
    while (scan < total && mailLocalCode(str.charCodeAt(scan))) scan++;
    if (str[scan] !== '@') return null;
    P_MAIL.lastIndex = pos;
    const match = P_MAIL.exec(str);
    // The lookahead can cut the domain short only because the email
    // is followed by `_`, which is exactly what an emphasis closer
    // looks like. Marked matches the email after the strong is
    // formed, so the closer is already consumed there. Accept the
    // longer match only when that `_` run really is the closer of
    // an unmatched `_` opener: build a synthetic closer atom for
    // the run and ask the closer search whether any earlier opener
    // pairs with it. That keeps `__a __b__ c@x.com__` (opener
    // already paired) literal while `__a _b_ c@x.com__` (debt
    // swallows the middle closer) still matches the email.
    if (atoms !== null && atoms !== undefined) {
      P_MAIL_NL.lastIndex = pos;
      const longer = P_MAIL_NL.exec(str);
      if (longer !== null && (match === null || longer[0].length > match[0].length)) {
        const longEnd = pos + longer[0].length;
        let runEnd = longEnd;
        while (runEnd < str.length && str[runEnd] === '_') runEnd++;
        if (runEnd > longEnd) {
          const before = str[longEnd - 1];
          const after = runEnd >= str.length ? '' : str[runEnd];
          const flank = flanks(before, after);
          const closes = flank.canClose && (!flank.canOpen || isPunct(after));
          if (closes) {
            const synthetic = {
              t: 'delim', ch: '_', n: runEnd - longEnd, run: runEnd - longEnd,
              led: false,
              open: flank.canOpen && (!flank.canClose || isPunct(before)),
              close: closes,
              veiled: masked !== null && masked.slice(longEnd, runEnd) !== str.slice(longEnd, runEnd),
            };
            const probe = atoms.concat([synthetic]);
            for (let oi = atoms.length - 1; oi >= 0; oi--) {
              const cand = atoms[oi];
              if (cand.t !== 'delim' || cand.ch !== '_' || !cand.open) continue;
              const found = closerFor(probe, oi);
              if (found !== null && found.closerIdx === atoms.length) {
                const text = longer[0];
                return { atom: { t: 'link', href: 'mailto:' + text, title: null, kids: null, shown: text, auto: true }, end: longEnd };
              }
            }
          }
        }
      }
    }
    if (match !== null) {
      const text = match[0];
      return { atom: { t: 'link', href: 'mailto:' + text, title: null, kids: null, shown: text, auto: true }, end: pos + text.length };
    }
  }
  return null;
}

// ------------------------------------------------------------------
// Atom rendering
// ------------------------------------------------------------------

// The plain text of a link label (image alt text): formatting is
// stripped, code spans keep their text, line breaks vanish.
function plainLabel(atoms) {
  let out = '';
  for (const atom of atoms) {
    switch (atom.t) {
      case 'text': out += decodeNumRefs(atom.str); break;
      case 'esc': case 'code': case 'html': out += atom.str; break;
      case 'brk': break;
      case 'link': case 'image': out += atom.kids ? plainLabel(atom.kids) : (atom.t === 'link' ? atom.shown : atom.label); break;
      case 'delim': out += atom.ch.repeat(atom.n); break;
      case 'em': case 'strong': case 'del': out += plainLabel(atom.kids); break;
      default: break;
    }
  }
  return out;
}

function linkHtml(atom) {
  const url = cleanHref(atom.href);
  if (atom.auto) {
    const display = esc(atom.shown, true);
    if (url === null) return display;
    return '<a href="' + esc(url, true) + '">' + display + '</a>';
  }
  const inner = atomsHtml(atom.kids);
  if (url === null) return inner;
  let out = '<a href="' + esc(url, false) + '"';
  if (atom.title) out += ' title="' + esc(atom.title, false) + '"';
  return out + '>' + inner + '</a>';
}

function imgHtml(atom) {
  const alt = esc(plainLabel(atom.kids), false);
  const url = cleanHref(atom.href);
  if (url === null) return alt;
  let out = '<img src="' + esc(url, false) + '" alt="' + alt + '"';
  if (atom.title) out += ' title="' + esc(atom.title, false) + '"';
  return out + '>';
}

function atomsHtml(atoms) {
  let out = '';
  for (const atom of atoms) {
    switch (atom.t) {
      case 'text': out += atom.raw ? atom.str : esc(decodeNumRefs(atom.str), false); break;
      case 'esc': out += esc(atom.str, false); break;
      case 'code': out += '<code>' + esc(atom.str, true) + '</code>'; break;
      case 'brk': out += '<br>'; break;
      case 'html': out += atom.str; break;
      case 'link': out += linkHtml(atom); break;
      case 'image': out += imgHtml(atom); break;
      case 'delim': out += atom.ch.repeat(atom.n); break;
      case 'em': out += '<em>' + atomsHtml(atom.kids) + '</em>'; break;
      case 'strong': out += '<strong>' + atomsHtml(atom.kids) + '</strong>'; break;
      case 'del': out += '<del>' + atomsHtml(atom.kids) + '</del>'; break;
      default: break;
    }
  }
  return out;
}

// ------------------------------------------------------------------
// Delimiter resolution
// ------------------------------------------------------------------

// The lone-delimiter exception: when the next three delimiter atoms
// are a double run of the other character, a single run of this
// one, and a run of two or more of the other character (`__ * __`),
// the middle one can never close this opener. Returns its index,
// or -1.
function loneBetween(atoms, openerIdx, mark) {
  const other = mark === '*' ? '_' : '*';
  const found = [];
  for (let p = openerIdx + 1; p < atoms.length && found.length < 3; p++) {
    if (atoms[p].t === 'delim') found.push(p);
  }
  if (found.length === 3 &&
      atoms[found[0]].ch === other && atoms[found[0]].n === 2 &&
      atoms[found[1]].ch === mark && atoms[found[1]].n === 1 &&
      atoms[found[2]].ch === other && atoms[found[2]].n >= 2) {
    return found[1];
  }
  return -1;
}

// Find the delimiter atom that closes the opener at `openerIdx`.
// The search walks forward carrying a debt: the opener's length,
// plus the length of every open-only run of the same character met
// on the way, minus the length of every candidate closer. The
// first closer that pays the debt off wins. Three extra rules
// shape the walk:
//  * a veiled run (inside a code span, link or tag placeholder)
//    can never close;
//  * for `*` and `_`, when the opener or the candidate can both
//    open and close, the rule of three applies: a candidate whose
//    length makes (opener total + candidate) a multiple of three
//    is skipped and its length is remembered, unless the opener
//    total itself is a multiple of three; and when the opener is
//    led by the same delimiter and the candidate can also open,
//    the search stops;
//  * a `~` closer must match the opener's length exactly, and runs
//    of another length neither close nor add debt.
// Returns {closerIdx, effLen, use} or null.
function closerFor(atoms, openerIdx) {
  const opener = atoms[openerIdx];
  const mark = opener.ch;
  const openLen = opener.n;
  const runTotal = opener.run;
  const skipIdx = loneBetween(atoms, openerIdx, mark);
  let debt = openLen;
  let skipped = 0;
  for (let cIdx = openerIdx + 1; cIdx < atoms.length; cIdx++) {
    const cand = atoms[cIdx];
    if (cand.t !== 'delim' || cand.ch !== mark) continue;
    if (cIdx === skipIdx) continue;
    if (cand.veiled) continue;
    const candLen = cand.n;
    if (mark === '~' && candLen !== openLen) continue;
    if (!cand.close) {
      if (cand.open) debt += candLen;
      continue;
    }
    if (mark !== '~') {
      const dual = cand.open;
      if (dual || opener.close) {
        if (opener.led && dual) return null;
        if (runTotal % 3 !== 0 && (runTotal + candLen) % 3 === 0) {
          skipped += candLen;
          continue;
        }
      }
    }
    debt -= candLen;
    if (debt > 0) continue;
    const effLen = Math.min(candLen, candLen + debt + skipped);
    return { closerIdx: cIdx, effLen, use: Math.min(openLen, effLen) };
  }
  return null;
}

// Resolve all delimiter atoms in `atoms` into emphasis, strong and
// strikethrough nodes, in place. An opener with no closer loses
// its first character to literal text and the rest of the run is
// retried as a fresh opener (a tilde run, or a run of length one,
// is swallowed whole). A matched pair takes one or two characters
// from each side depending on the parity of the usable length;
// the leftovers stay inside the new node and are resolved by
// recursion, and any surplus of the closer run stays after it as
// a fresh delimiter atom.
function settleDelims(atoms) {
  let idx = 0;
  while (idx < atoms.length) {
    const atom = atoms[idx];
    if (atom.t !== 'delim' || !atom.open) { idx++; continue; }
    const hit = closerFor(atoms, idx);
    if (hit === null) {
      if (atom.ch === '~' || atom.n === 1) {
        atoms[idx] = { t: 'text', str: atom.ch.repeat(atom.n), raw: false };
      } else {
        atoms.splice(idx, 1,
          { t: 'text', str: atom.ch, raw: false },
          { t: 'delim', ch: atom.ch, n: atom.n - 1, run: atom.run,
            led: true, open: atom.open, close: atom.close, veiled: atom.veiled });
      }
      idx++;
      continue;
    }
    const closer = atoms[hit.closerIdx];
    const middle = atoms.slice(idx + 1, hit.closerIdx);
    const replacement = [];
    if (atom.ch === '~') {
      replacement.push({ t: 'del', kids: settleDelims(middle) });
    } else {
      const take = hit.use % 2 === 1 ? 1 : 2;
      const kids = [];
      if (atom.n > take) {
        kids.push({ t: 'delim', ch: atom.ch, n: atom.n - take, run: atom.n - take,
          led: false, open: atom.open, close: atom.close, veiled: atom.veiled });
      }
      kids.push(...middle);
      if (hit.effLen > take) {
        kids.push({ t: 'delim', ch: atom.ch, n: hit.effLen - take, run: hit.effLen - take,
          led: false, open: closer.open, close: closer.close, veiled: closer.veiled });
      }
      replacement.push({ t: hit.use % 2 === 1 ? 'em' : 'strong', kids: settleDelims(kids) });
    }
    if (closer.n > hit.effLen) {
      replacement.push({ t: 'delim', ch: atom.ch, n: closer.n - hit.effLen, run: closer.n - hit.effLen,
        led: true, open: closer.open, close: closer.close, veiled: closer.veiled });
    }
    atoms.splice(idx, hit.closerIdx - idx + 1, ...replacement);
    idx++;
  }
  return atoms;
}

// ------------------------------------------------------------------
// Masking
// ------------------------------------------------------------------

// The masking marked applies before the emphasis closer search:
// code spans, links and tags are replaced by same-length
// placeholders, so a delimiter inside one cannot close an emphasis
// opened outside it. A "code span" here may start at any backtick
// run — even one inside a link label that never forms a real code
// span — so it can swallow a closer that sits after the link. The
// masked text keeps the original length, so positions still line
// up.
const MASK_A = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MASK_B = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
function maskDelims(str) {
  const stageOne = str.replace(MASK_A,
    (whole, run, escaped) => escaped
      ? '+'.repeat(whole.length)
      : run
        ? run + whole.slice(run.length, -run.length).replace(/`/g, '+') + run
        : whole);
  return stageOne.replace(MASK_B,
    (whole, gA, gEmpty) => {
      const keep = gEmpty ? gEmpty.length : 0;
      return whole.slice(0, keep) + '[' + 'a'.repeat(whole.length - keep - 2) + ']';
    });
}

// ------------------------------------------------------------------
// Inline tokenizer
// ------------------------------------------------------------------

// The next position where the inline loop can do anything: a
// special character (space, backslash, backtick, '<', '[', '!',
// '*', '_', '~'), a URL prefix, or an '@' (whose email starts at
// the word start before it).
const JUMP_RE = /[ \\`<\[\[*!_~!]|www\.|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/|mailto:|xmpp:|@/g;

// Tag shapes that toggle the link/raw-block state while tokenizing.
const A_OPEN_RE = /^<a /i;
const A_CLOSE_RE = /^<\/a>/i;
const RAW_OPEN_RE = /^<(pre|code|kbd|script)(\s|>)/i;
const RAW_CLOSE_RE = /^<\/(pre|code|kbd|script)(\s|>)/i;

// Where a hard break starting at `str[pos]` ends (just past the
// newline), or -1: two or more spaces, or one backslash, directly
// before a newline.
function breakEnd(str, pos) {
  if (str.charCodeAt(pos) === 32) {
    let p = pos;
    while (p < str.length && str[p] === ' ') p++;
    return (p - pos >= 2 && str[p] === '\n') ? p + 1 : -1;
  }
  return str[pos + 1] === '\n' ? pos + 2 : -1;
}

// Whether a delimiter run can open / can close, from the
// characters around it and the delimiter kind. `*` follows
// flanking directly; `_` needs a punctuation neighbour on the side
// it cannot flank; `~` only needs a non-space, non-tilde neighbour
// on each side.
function delimFlags(code, prev, next) {
  const flank = flanks(prev, next);
  if (code === 42) return [flank.canOpen, flank.canClose];
  if (code === 95) {
    return [
      flank.canOpen && (!flank.canClose || isPunct(prev)),
      flank.canClose && (!flank.canOpen || isPunct(next)),
    ];
  }
  return [
    next !== '' && !isWS(next) && next !== '~',
    prev !== '' && !isWS(prev) && prev !== '~',
  ];
}

// Whether an extended autolink could start at position `i`:
// at a word start any email-local character may begin an email;
// elsewhere only the first letter of a www./scheme/mailto:/xmpp:
// prefix can start one.
function urlMaybeAt(str, i, code, prevCode) {
  const wordStart = prevCode === -1 || !mailLocalCode(prevCode);
  if (wordStart) return mailLocalCode(code);
  if (code === 119) return str.startsWith('www.', i);
  if (code === 104 || code === 72 || code === 102 || code === 70) {
    return str[i + 1] === 't' || str[i + 1] === 'T';
  }
  if (code === 109) return str.startsWith('mailto:', i);
  if (code === 120) return str.startsWith('xmpp:', i);
  return false;
}

// Tokenize one inline string into atoms (no rendering yet). `ctx`
// carries the link definitions and the link/raw-block state.
function tokenize(str, ctx) {
  const atoms = [];
  const total = str.length;
  let i = 0;
  // The plain-text run is kept as an index range [segStart, i) into
  // the source instead of a string built one character at a time:
  // it is sliced once, when flushed. `segStart` is -1 while no run
  // is open. `segRaw` is the raw-block flag of the run's first
  // character (it cannot change mid-run: only a tag atom changes
  // it, and a tag atom flushes first).
  let segStart = -1;
  let segRaw = false;
  // A delimiter run is veiled when the masking replaced it: it
  // cannot close an emphasis, though it can still open one. Only
  // worth computing when a backtick could start a masking span.
  const masked = (str.includes('`') && (str.includes('*') || str.includes('_') || str.includes('~')))
    ? maskDelims(str)
    : null;
  const flushSeg = () => {
    if (segStart !== -1) {
      atoms.push({ t: 'text', str: str.slice(segStart, i), raw: segRaw });
      segStart = -1;
    }
  };
  const pushAtom = (atom) => {
    flushSeg();
    atoms.push(atom);
  };
  while (i < total) {
    // Dispatch on the character code, not a one-character string:
    // reading `str[i]` allocates at every position, a code does
    // not. 32 space, 92 backslash, 96 backtick, 60 '<', 91 '[',
    // 33 '!', 42 '*', 95 '_', 126 '~'.
    const code = str.charCodeAt(i);
    if (code === 32 || code === 92) {
      // Hard break: spaces or a backslash before a newline, unless
      // nothing but whitespace follows.
      const brkEnd = breakEnd(str, i);
      if (brkEnd !== -1) {
        let rest = brkEnd;
        while (rest < total && (str[rest] === ' ' || str[rest] === '\t')) rest++;
        if (str.slice(rest).trim() !== '') {
          pushAtom({ t: 'brk' });
          i = rest;
          continue;
        }
      }
      if (code === 92 && i + 1 < total && asciiPunct(str[i + 1])) {
        pushAtom({ t: 'esc', str: str[i + 1] });
        i += 2;
        continue;
      }
      if (segStart === -1) {
        segStart = i;
        segRaw = ctx.inRaw;
      }
      i++;
      continue;
    }
    if (code === 96) {
      const span = codeSpanAt(str, i);
      if (span !== null) {
        pushAtom({ t: 'code', str: span.text });
        i = span.end;
        continue;
      }
      // A failed code span swallows the whole backtick run as
      // literal text; the next attempt is only at the next special
      // character.
      let p = i;
      while (p < total && str[p] === '`') p++;
      if (segStart === -1) {
        segStart = i;
        segRaw = ctx.inRaw;
      }
      i = p;
      continue;
    }
    if (code === 60) {
      const tag = inlineTagAt(str, i);
      if (tag !== null) {
        if (!ctx.inLink && A_OPEN_RE.test(tag)) ctx.inLink = true;
        else if (ctx.inLink && A_CLOSE_RE.test(tag)) ctx.inLink = false;
        if (!ctx.inRaw && RAW_OPEN_RE.test(tag)) ctx.inRaw = true;
        else if (ctx.inRaw && RAW_CLOSE_RE.test(tag)) ctx.inRaw = false;
        pushAtom({ t: 'html', str: tag });
        i += tag.length;
        continue;
      }
      const auto = angleLinkAt(str, i);
      if (auto !== null) {
        const inner = auto.slice(1, -1);
        const isEmail = inner.indexOf(':') === -1;
        pushAtom({ t: 'link', href: isEmail ? 'mailto:' + inner : inner, title: null, kids: null, shown: inner, auto: true });
        i += auto.length;
        continue;
      }
      if (segStart === -1) {
        segStart = i;
        segRaw = ctx.inRaw;
      }
      i++;
      continue;
    }
    if (code === 91 || (code === 33 && str.charCodeAt(i + 1) === 91)) {
      const hit = linkAt(str, i, ctx);
      if (hit !== null) {
        pushAtom(hit.atom);
        i = hit.end;
        continue;
      }
      if (segStart === -1) {
        segStart = i;
        segRaw = ctx.inRaw;
      }
      i++;
      continue;
    }
    if (code === 42 || code === 95 || code === 126) {
      let p = i;
      while (p < total && str.charCodeAt(p) === code) p++;
      const len = p - i;
      if (code === 126 && len > 2) {
        if (segStart === -1) {
          segStart = i;
          segRaw = ctx.inRaw;
        }
        i = p;
        continue;
      }
      // An escape right before the run is `+` in the masked text
      // the flanking is judged on, not the escaped character: a
      // `\~` before a `~~` run must not count as "preceded by `~`".
      let prev = i === 0 ? '' : str[i - 1];
      if (segStart === -1 && atoms.length > 0 && atoms[atoms.length - 1].t === 'esc') prev = '+';
      const next = p >= total ? '' : str[p];
      const [canOpen, canClose] = delimFlags(code, prev, next);
      // `run` is the run length (kept across split retries);
      // `led` says the character before this run is the same
      // delimiter — false for a freshly tokenized run.
      const veiled = masked !== null && masked.slice(i, p) !== str.slice(i, p);
      pushAtom({ t: 'delim', ch: str[i], n: len, run: len, led: false, open: canOpen, close: canClose, veiled });
      i = p;
      continue;
    }
    // Extended autolinks (www., scheme://, email) — only outside
    // links. The check is only worth calling where a match can
    // start, which keeps the per-character cost to a few cheap
    // checks instead of regexes over the rest of the string.
    if (!ctx.inLink) {
      const prevCode = i === 0 ? -1 : str.charCodeAt(i - 1);
      if (urlMaybeAt(str, i, code, prevCode)) {
        const hit = extUrlAt(str, i, ctx, atoms, masked);
        if (hit !== null) {
          pushAtom(hit.atom);
          i = hit.end;
          continue;
        }
      }
    }
    // Plain character: the URL/email check above already failed
    // for this position, so the rest of the plain run is jumped
    // over in one step — one regex scan finds the next position
    // where something can happen instead of one iteration per
    // character. An '@' stops the run at the word start before it
    // (clamped to just after here, so a word that started before
    // this run is never jumped back to).
    if (segStart === -1) {
      segStart = i;
      segRaw = ctx.inRaw;
    }
    JUMP_RE.lastIndex = i + 1;
    const hit = JUMP_RE.exec(str);
    let p = hit ? hit.index : total;
    if (hit !== null && hit[0] === '@') {
      let w = p;
      while (w > i + 1 && mailLocalCode(str.charCodeAt(w - 1))) w--;
      p = w;
    }
    i = p;
  }
  flushSeg();
  return settleDelims(atoms);
}

// Render one inline string to HTML. The raw-block flag resets for
// each string; the link flag persists across blocks within one
// parse() call, matching marked's per-document state.
function inlineHtml(src, ctx) {
  ctx.inRaw = false;
  return atomsHtml(tokenize(src, ctx));
}

// ------------------------------------------------------------------
// Block parsing
// ------------------------------------------------------------------
// Nodes: {t:'paragraph'|'baretext', text}, {t:'heading', level,
// text}, {t:'hr'}, {t:'codeblock', text, info}, {t:'htmlblock',
// text}, {t:'blockquote', children, rawLines}, {t:'listblock',
// ordered, start, loose, entries, rawLines}, {t:'tableblock',
// headCells, alignments, bodyRows}.
// The lexer works on lines (the source split on '\n', with the
// final empty piece of a trailing newline dropped); `endsNL` says
// whether the source ended with a newline, which decides trailing
// newlines in raw code and HTML block text.

// ATX heading level of `str` (content after at most 3 columns of
// indent), or 0 when `str` does not start a heading.
function atxDepth(str) {
  let depth = 0;
  while (depth < str.length && str[depth] === '#') depth++;
  if (depth === 0 || depth > 6) return 0;
  if (depth >= str.length) return depth;
  const after = str[depth];
  return (after === ' ' || after === '\t') ? depth : 0;
}

// Is `str` (content after at most 3 columns of indent) a thematic
// break? At least three of one marker character, with only spaces
// and tabs between them.
function isRule(str) {
  if (str.length < 3) return false;
  const mark = str[0];
  if (mark !== '-' && mark !== '_' && mark !== '*') return false;
  let count = 0;
  for (let p = 0; p < str.length; p++) {
    const ch = str[p];
    if (ch === mark) count++;
    else if (ch !== ' ' && ch !== '\t') return false;
  }
  return count >= 3;
}

// Setext underline level of `str` (content after at most 3 columns
// of indent): 1 for `=`, 2 for `-`, 0 otherwise.
function setextDepth(str) {
  if (!str) return 0;
  const mark = str[0];
  if (mark !== '=' && mark !== '-') return 0;
  let pos = 0;
  while (pos < str.length && str[pos] === mark) pos++;
  while (pos < str.length && (str[pos] === ' ' || str[pos] === '\t')) pos++;
  return pos === str.length ? (mark === '=' ? 1 : 2) : 0;
}

// A fence opening in `str` (content after at most 3 columns of
// indent). Returns {ch, len, info} or null; a backtick fence whose
// info string contains a backtick is not a fence.
function fenceStart(str) {
  if (str.length < 3) return null;
  const ch = str[0];
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (len < str.length && str[len] === ch) len++;
  if (len < 3) return null;
  const info = str.slice(len);
  if (ch === '`' && info.indexOf('`') !== -1) return null;
  return { ch, len, info };
}

// Is `str` a closing fence for a fence of `ch` opened with `len`?
function fenceEnds(str, ch, len) {
  let run = 0;
  while (run < str.length && str[run] === ch) run++;
  if (run < len) return false;
  for (let p = run; p < str.length; p++) {
    if (str[p] !== ' ' && str[p] !== '\t') return false;
  }
  return true;
}

// A list marker at the start of `str` (content after at most 3
// columns of indent). Returns {ordered, delim, num, markerLen} or
// null. The marker must be followed by a space, a tab, or the end
// of the line.
function readBullet(str) {
  const first = str[0];
  if (first === '*' || first === '+' || first === '-') {
    if (str.length === 1) return { ordered: false, delim: first, num: 0, markerLen: 1 };
    const after = str[1];
    if (after === ' ' || after === '\t') return { ordered: false, delim: first, num: 0, markerLen: 1 };
    return null;
  }
  if (first >= '0' && first <= '9') {
    let pos = 0;
    while (pos < str.length && str[pos] >= '0' && str[pos] <= '9') pos++;
    if (pos === 0 || pos > 9) return null;
    if (pos >= str.length) return null;
    const delim = str[pos];
    if (delim !== '.' && delim !== ')') return null;
    const num = +str.slice(0, pos);
    if (pos + 1 >= str.length) return { ordered: true, delim, num, markerLen: pos + 1 };
    const after = str[pos + 1];
    if (after === ' ' || after === '\t') return { ordered: true, delim, num, markerLen: pos + 1 };
    return null;
  }
  return null;
}

// Does a list marker at the start of `line` interrupt a paragraph?
// Only bullets, and ordered markers starting at 1, with real
// content after the marker, interrupt one.
function markerInterrupts(line) {
  const [cols, idx] = leadIndent(line);
  if (cols > 3) return false;
  const marker = readBullet(line.slice(idx));
  if (marker === null) return false;
  if (marker.ordered && marker.num !== 1) return false;
  const rest = line.slice(idx + marker.markerLen);
  let pos = 0;
  while (pos < rest.length && (rest[pos] === ' ' || rest[pos] === '\t')) pos++;
  return pos > 0 && pos < rest.length;
}

// Is `str` a table delimiter row (after at most 3 columns of
// indent)?
function isTableDelim(str) {
  if (/^(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/.test(str)) {
    return str.indexOf(':') !== -1 || str.indexOf('|') !== -1;
  }
  return false;
}

// Split one table row into cells the way marked's splitter does:
// split on unescaped pipes, drop a leading and a trailing empty
// cell, trim each cell and turn `\|` back into `|`. When `count`
// is given, pad or truncate to that many cells.
function splitCells(str, count) {
  let rebuilt = '';
  for (let p = 0; p < str.length; p++) {
    const ch = str[p];
    if (ch === '|') {
      let slashes = 0;
      for (let q = p - 1; q >= 0 && str[q] === '\\'; q--) slashes++;
      rebuilt += (slashes % 2 === 1) ? '|' : ' |';
    } else {
      rebuilt += ch;
    }
  }
  const cells = rebuilt.split(' |');
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.length = count;
    else while (cells.length < count) cells.push('');
  }
  for (let p = 0; p < cells.length; p++) cells[p] = cells[p].trim().replace(/\\\|/g, '|');
  return cells;
}

// Does a table start at lines[i]? Returns {headCells, alignments,
// rowsEnd} (rowsEnd is the index just past the last row) or null.
function tableStart(lines, i, end, endsNL) {
  const [headCols, headIdx] = leadIndent(lines[i]);
  if (headCols > 3) return null;
  const headText = lines[i].slice(headIdx);
  if (headText.trim() === '') return null;
  if (i + 1 >= end) return null;
  const [delimCols, delimIdx] = leadIndent(lines[i + 1]);
  if (delimCols > 3) return null;
  const delimText = lines[i + 1].slice(delimIdx);
  if (!isTableDelim(delimText)) return null;
  const headCells = splitCells(headText);
  const delimBody = delimText.replace(/^\|/, '').replace(/\|\s*$/, '');
  const delimCells = delimBody.split('|');
  if (headCells.length !== delimCells.length) return null;
  const alignments = delimCells.map((cell) => {
    if (/^ *-+: *$/.test(cell)) return 'right';
    if (/^ *:-+: *$/.test(cell)) return 'center';
    if (/^ *:-+ *$/.test(cell)) return 'left';
    return null;
  });
  let k = i + 2;
  while (k < end) {
    const line = lines[k];
    // A row line ends only on a spaces-only line that a newline
    // follows; a line holding a tab is a row, and trims to an
    // all-empty row.
    if (/^ *$/.test(line) && (k + 1 < end || endsNL)) break;
    const [cols, idx] = leadIndent(line);
    // The code exclusion needs a non-newline character after the
    // indent; a tab-only line is a row, not code.
    if (cols >= 4 && line.slice(idx).trim() !== '') break;
    const content = line.slice(idx);
    if (isRule(content) || atxDepth(content) > 0 || stripMarker(line) !== null) break;
    if (fenceStart(content)) break;
    const marker = readBullet(content);
    if (marker !== null && (!marker.ordered || marker.num === 1)) break;
    if (htmlBreaksPara(content)) break;
    k++;
  }
  return { headCells, alignments, rowsEnd: k };
}

// Strip one blockquote marker level from `line`. Returns the
// content after the marker, or null when the line does not start
// one. A tab after the marker expands to spaces first, then one
// space is dropped.
function stripMarker(line) {
  let cols = 0;
  let pos = 0;
  while (pos < line.length) {
    const ch = line[pos];
    if (ch === ' ') {
      if (cols >= 3) break;
      cols++;
      pos++;
    } else {
      break;
    }
  }
  if (line[pos] !== '>') return null;
  pos++;
  let col = cols + 1;
  let spaces = 0;
  let p = pos;
  while (p < line.length && (line[p] === ' ' || line[p] === '\t')) {
    if (line[p] === ' ') {
      spaces++;
      col++;
      p++;
    } else {
      const width = 4 - (col % 4);
      spaces += width;
      col += width;
      p++;
    }
  }
  if (spaces > 0) spaces -= 1;
  return ' '.repeat(spaces) + line.slice(p);
}

// Collect an HTML block whose end is marked by `closer` appearing
// in a line (a comment close, `?>`, `]]>`, a declaration `>`, or a
// closing tag for a pre/script/style/textarea block). `from` is
// the index in lines[i] to start searching from; `closeTag`
// searches case insensitively for `</name`. The block also
// swallows following blank lines; its text is the raw text with
// trailing blanks trimmed the way marked's helper does.
function collectToCloser(lines, i, end, endsNL, closer, from, closeTag) {
  let k = i;
  let found = -1;
  for (; k < end; k++) {
    const line = lines[k];
    const start = k === i ? from : 0;
    if (closeTag) {
      const at = line.toLowerCase().indexOf(closer, start);
      if (at !== -1) {
        found = k;
        break;
      }
    } else {
      const at = line.indexOf(closer, start);
      if (at !== -1) {
        found = k;
        break;
      }
    }
  }
  let k2;
  if (found === -1) {
    k2 = end;
  } else {
    // Only truly empty lines follow the closer: a tab-only line
    // stays outside the block, or the trailing-newline trim goes
    // wrong.
    k2 = found + 1;
    while (k2 < end && lines[k2] === '') k2++;
  }
  return { node: { t: 'htmlblock', text: trimTailBlanks(linesText(lines, i, k2, endsNL)) }, next: k2 };
}

// Collect a type-6/7 HTML block: lines up to (not including) the
// first blank line, swallowing the blank lines that follow.
function collectToGap(lines, i, end, endsNL) {
  let k = i;
  while (k < end && !blankLine(lines[k])) k++;
  let k2 = k;
  while (k2 < end && blankLine(lines[k2])) k2++;
  return { node: { t: 'htmlblock', text: trimTailBlanks(linesText(lines, i, k2, endsNL)) }, next: k2 };
}

// Try to read an HTML block starting at lines[i]. Returns
// {node, next} or null.
function htmlBlockAt(lines, i, end, endsNL) {
  const line = lines[i];
  const [cols, idx] = leadIndent(line);
  if (cols > 3) return null;
  const content = line.slice(idx);
  if (content.charCodeAt(0) !== 60) return null; // '<'
  if (content.startsWith('<!--')) {
    // Short comments `<!-->` and `<!--->` end on this very line.
    if (content[4] === '>' || (content[4] === '-' && content[5] === '>')) {
      let k2 = i + 1;
      while (k2 < end && lines[k2] === '') k2++;
      return { node: { t: 'htmlblock', text: trimTailBlanks(linesText(lines, i, k2, endsNL)) }, next: k2 };
    }
    return collectToCloser(lines, i, end, endsNL, '-->', 4, false);
  }
  if (content.startsWith('<?')) return collectToCloser(lines, i, end, endsNL, '?>', 2, false);
  if (content.startsWith('<![CDATA[')) return collectToCloser(lines, i, end, endsNL, ']]>', 9, false);
  if (content.startsWith('<!') && content.length > 2) {
    const third = content[2];
    if ((third >= 'A' && third <= 'Z') || (third >= 'a' && third <= 'z')) {
      return collectToCloser(lines, i, end, endsNL, '>', 2, false);
    }
  }
  const tag = tagHeadAt(content, 0);
  if (tag === null) return null;
  const [name, closing, nameEnd] = tag;
  if (!closing && RAWTEXT_TAGS.has(name)) {
    const after = content[nameEnd];
    // A bare name at end of line only opens the block when a
    // newline follows it (the opening pattern needs whitespace or
    // `>`).
    if ((after === undefined && (i + 1 < end || endsNL)) || after === ' ' || after === '\t' || after === '>') {
      return collectToCloser(lines, i, end, endsNL, '</' + name + '>', 0, true);
    }
  }
  if (BLOCK_TAGS.has(name)) {
    const after = content[nameEnd];
    if (after === ' ' || after === '\t' || after === undefined || after === '>') return collectToGap(lines, i, end, endsNL);
    if (after === '/' && content[nameEnd + 1] === '>') return collectToGap(lines, i, end, endsNL);
  }
  // Type 7: a complete tag, alone on its line, for a tag that is
  // neither a raw-text tag nor a block tag. Tag names may be
  // upper-case.
  if (!RAWTEXT_TAGS.has(name)) {
    const first = content[closing ? 2 : 1];
    if ((first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z')) {
      const tagEnd = fullTagEnd(content, 0);
      if (tagEnd !== -1) {
        let p = tagEnd;
        while (p < content.length && (content[p] === ' ' || content[p] === '\t')) p++;
        if (p === content.length) return collectToGap(lines, i, end, endsNL);
      }
    }
  }
  return null;
}

// Read the label of a link reference definition: `src[p]` is the
// character just after the opening bracket. Returns {label, end}
// with `end` just past the closing bracket, or null. Backslash
// pairs stay in the label; a newline inside is kept only when a
// non-blank line follows.
function defLabel(src, p) {
  let label = '';
  let closed = false;
  while (p < src.length) {
    const ch = src[p];
    if (ch === '\\') {
      if (p + 1 >= src.length) return null;
      label += src.slice(p, p + 2);
      p += 2;
      continue;
    }
    if (ch === ']') {
      closed = true;
      break;
    }
    if (ch === '[') return null;
    if (ch === '\n') {
      let q = p + 1;
      while (q < src.length && (src[q] === ' ' || src[q] === '\t')) q++;
      if (q >= src.length || src[q] === '\n') return null;
      label += '\n';
      p++;
      continue;
    }
    label += ch;
    p++;
  }
  if (!closed) return null;
  if (label.trim() === '') return null;
  return { label, end: p + 1 };
}

// Try to read a link reference definition starting at lines[i].
// When one matches, the first definition for its label wins; the
// definition is recorded in `defs`. Returns {next} (index just
// past the definition) or null. With `dry`, the shape is tested
// without recording anything.
function defAt(lines, i, end, defs, dry) {
  const [cols, idx] = leadIndent(lines[i]);
  if (cols > 3) return null;
  const maxLines = Math.min(end - i, 6);
  let src = '';
  for (let k = 0; k < maxLines; k++) src += (k ? '\n' : '') + lines[i + k];
  let p = idx;
  if (src[p] !== '[') return null;
  const labelRes = defLabel(src, p + 1);
  if (labelRes === null) return null;
  const label = labelRes.label;
  p = labelRes.end;
  if (src[p] !== ':') return null;
  p++;
  while (src[p] === ' ' || src[p] === '\t') p++;
  if (src[p] === '\n') {
    p++;
    while (src[p] === ' ' || src[p] === '\t') p++;
  }
  let href = '';
  let bracketed = false;
  if (src[p] === '<') {
    const close = src.indexOf('>', p + 1);
    if (close === -1) return null;
    const dest = src.slice(p + 1, close);
    if (dest.indexOf('\n') !== -1) return null;
    href = dest;
    bracketed = true;
    p = close + 1;
  } else {
    const start = p;
    while (p < src.length && src[p] !== ' ' && src[p] !== '\t' && src[p] !== '\n') p++;
    if (p === start) return null;
    href = src.slice(start, p);
    let depth = 0;
    let bad = false;
    for (let k = 0; k < href.length; k++) {
      const ch = href[k];
      if (ch === '\\') {
        k++;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth < 0) {
          bad = true;
          break;
        }
      }
    }
    if (bad || depth !== 0) return null;
  }
  // Optional title, on this line or the next. It must be preceded
  // by whitespace (spaces/tabs, or a newline); a title glued
  // straight onto the destination is not a title, and the
  // definition is rejected. When the title cannot be used (it
  // never closes, or it is followed by non-EOL text), the
  // definition falls back to its no-title form.
  let title = null;
  const saveP = p;
  let q = p;
  while (src[q] === ' ' || src[q] === '\t') q++;
  if (src[q] === '\n') {
    q++;
    while (src[q] === ' ' || src[q] === '\t') q++;
  }
  if (q > p) {
    const quote = src[q];
    if (quote === '"' || quote === "'" || quote === '(') {
      const closer = quote === '(' ? ')' : quote;
      let r = q + 1;
      let ok = false;
      while (r < src.length) {
        const ch = src[r];
        if (ch === '\\') {
          r += 2;
          continue;
        }
        if (ch === closer) {
          ok = true;
          break;
        }
        if (quote === "'" && ch === '\n') {
          let ahead = r + 1;
          while (ahead < src.length && (src[ahead] === ' ' || src[ahead] === '\t')) ahead++;
          if (ahead >= src.length || src[ahead] === '\n') break;
        }
        if (quote === '(' && ch === '(') break;
        r++;
      }
      if (ok) {
        title = src.slice(q + 1, r);
        p = r + 1;
      }
    }
  }
  // After the destination (and any title) only spaces/tabs may
  // follow on the line; otherwise the title is dropped and the
  // no-title form is re-tested.
  let afterTitle = p;
  while (src[afterTitle] === ' ' || src[afterTitle] === '\t') afterTitle++;
  if (afterTitle < src.length && src[afterTitle] !== '\n' && title !== null) {
    p = saveP;
    title = null;
  }
  while (src[p] === ' ' || src[p] === '\t') p++;
  if (p < src.length && src[p] !== '\n') return null;
  let consumed = 1;
  for (let k = 0; k < p; k++) if (src[k] === '\n') consumed++;
  const key = normLabel(label);
  if (!dry && !Object.prototype.hasOwnProperty.call(defs, key)) {
    defs[key] = {
      href: unescPunct(bracketed ? href : href.replace(/^<(.*)>$/, '$1')),
      title: title === null ? null : unescPunct(title),
    };
  }
  return { next: i + consumed };
}

// Is `line` a block start that interrupts a text run inside a list
// item (any list marker, hr, ATX heading, fence, blockquote start,
// or HTML block start, with at most `maxIndent` spaces of indent)?
function blockStartAt(line, maxIndent) {
  const n = spaceRun(line);
  if (n > maxIndent) return false;
  const content = line.slice(n);
  if (readBullet(content)) return true;
  if (isRule(content)) return true;
  if (atxDepth(content) > 0) return true;
  if (fenceStart(content)) return true;
  if (content[0] === '>') return true;
  if (htmlBreaksPara(content)) return true;
  return false;
}

// Would the lines `first` (one line) plus a setext underline
// `under` form a setext heading? The text line must not itself
// look like a table delimiter row.
function setextPair(first, under) {
  const underText = under.slice(leadIndent(under)[1]);
  if (setextDepth(underText) === 0) return false;
  const [cols, idx] = leadIndent(first);
  if (cols >= 4) return false;
  const content = first.slice(idx);
  if (content.trim() === '') return false;
  if (readBullet(content)) return false;
  if (fenceStart(content)) return false;
  if (content[0] === '>') return false;
  if (atxDepth(content) > 0) return false;
  if (htmlBreaksPara(content)) return false;
  if (isTableDelim(content)) return false;
  return true;
}

// Collect a paragraph (top level, `mode` 'paragraph') or a bare
// text run (inside a list item, `mode` 'baretext') starting at
// lines[i]. A setext underline after the run turns it into a
// heading instead. Returns {node, next}.
function gatherRun(lines, i, end, mode, endsNL) {
  const start = i;
  let j = i;
  let setext = 0;
  while (j < end) {
    const line = lines[j];
    if (j > start) {
      // In bare mode a whitespace-only line always ends the run,
      // even at the end of the text where no newline follows. In
      // paragraph mode the paragraph keeps such a trailing line.
      if (blankAt(lines, j, end, endsNL) || (mode === 'baretext' && blankLine(line))) break;
      const [cols, idx] = leadIndent(line);
      const content = line.slice(idx);
      if (cols <= 3) {
        if (isRule(content)) {
          setext = setextDepth(content);
          break;
        }
        if (atxDepth(content) > 0) break;
        if (content[0] === '>') break;
        if (fenceStart(content)) break;
        if (htmlBreaksPara(content)) break;
        if (mode === 'paragraph') {
          if (markerInterrupts(line)) break;
          if (tableStart(lines, j, end, endsNL)) break;
        } else {
          if (readBullet(content)) break;
          if (tableStart(lines, j, end, endsNL)) break;
        }
        const underline = setextDepth(content);
        if (underline > 0) {
          // A setext underline ends the run only when the run so
          // far can be its text: no line of the run may look like
          // a table delimiter row, and the first line must be a
          // plain line.
          let ok = setextPair(lines[start], line);
          if (ok) {
            for (let k = start + 1; k < j; k++) {
              const [liCols, liIdx] = leadIndent(lines[k]);
              const liContent = lines[k].slice(liIdx);
              if (liCols >= 4 || readBullet(liContent) || isTableDelim(liContent)) {
                ok = false;
                break;
              }
            }
          }
          if (ok) {
            setext = underline;
            break;
          }
          // Otherwise the underline is just another text line.
        }
      } else if (mode === 'baretext') {
        // An indented line starts an indented code block in bare mode.
        break;
      }
      // In paragraph mode an indented line is ordinary continuation text.
    }
    j++;
  }
  if (setext > 0) {
    const text = lines.slice(start, j).join('\n').trim();
    return { node: { t: 'heading', level: setext, text }, next: j + 1 };
  }
  // Trailing blank lines collected into the run (from a list item
  // or a blockquote chunk) are not part of the paragraph: the
  // paragraph token's text drops them, the way a blank line ends a
  // run.
  const text = lines.slice(start, j).join('\n').replace(/\n+$/, '');
  return { node: { t: mode, text }, next: j };
}

// The main block lexer. Appends nodes for lines[0..lines.length)
// to `nodes` and returns true when a blank line separated two
// blocks inside this call (the loose-list signal). `topLevel`
// selects paragraph versus bare-text runs; `mergePrev` allows a
// leading paragraph/text/code node to merge into a trailing
// paragraph/text node left by an earlier chunk (blockquote
// chunks). `endsNL` says whether the text ended with a newline.
function lexLines(lines, defs, topLevel, nodes, mergePrev, endsNL) {
  const end = lines.length;
  let i = 0;
  let gapBlanks = 0; // blank lines skipped since the last node was added
  let blankGap = false;
  let pendingGap = false; // a blank line seen after a node, before the next node
  // The last thing added was a paragraph/text run, or a definition
  // merged into one (so a following definition merges too).
  let afterPara = false;
  const pushNode = (node) => {
    if (pendingGap) {
      blankGap = true;
      pendingGap = false;
    }
    nodes.push(node);
  };
  while (i < end) {
    const line = lines[i];
    // Outside the top level (a list item) a whitespace-only line
    // is blank even at the end of the text: it becomes a space
    // token there, never a text run of its own.
    if (blankAt(lines, i, end, endsNL) || (!topLevel && blankLine(line))) {
      i++;
      gapBlanks++;
      if (nodes.length > 0) pendingGap = true;
      afterPara = false;
      continue;
    }
    const [cols, idx] = leadIndent(line);
    const content = line.slice(idx);
    // Indented code. A whitespace-only line is never code on its own.
    if (cols >= 4 && !blankLine(line)) {
      let k = i;
      let lastCode = -1;
      while (k < end) {
        const candidate = lines[k];
        if (blankLine(candidate)) {
          k++;
          continue;
        }
        const [candCols] = leadIndent(candidate);
        if (candCols >= 4) {
          lastCode = k;
          k++;
          continue;
        }
        break;
      }
      // Trailing blank lines belong to the code token's raw text.
      let k2 = lastCode + 1;
      while (k2 < end && blankLine(lines[k2])) k2++;
      const raw = linesText(lines, i, k2, endsNL);
      const trimmed = trimTailBlanks(raw);
      const text = trimmed.split('\n').map((l) => dropCols(l, 4)).join('\n');
      const prev = nodes.length > 0 ? nodes[nodes.length - 1] : null;
      if (prev !== null && (prev.t === 'paragraph' || prev.t === 'baretext') && gapBlanks === 0) {
        prev.text += '\n' + text;
        afterPara = true;
      } else {
        pushNode({ t: 'codeblock', text, info: '' });
        afterPara = false;
      }
      gapBlanks = 0;
      i = k2;
      continue;
    }
    // Fenced code.
    const fence = fenceStart(content);
    if (fence !== null) {
      let k = i + 1;
      let closed = -1;
      while (k < end) {
        const candidate = lines[k];
        const [candCols, candIdx] = leadIndent(candidate);
        if (candCols <= 3 && fenceEnds(candidate.slice(candIdx), fence.ch, fence.len)) {
          closed = k;
          break;
        }
        k++;
      }
      const contentEnd = closed === -1 ? end : closed;
      let text = lines.slice(i + 1, contentEnd).join('\n');
      if (fence.ch === '`') {
        // Indented fences dedent their content by the fence's indent.
        const dedent = /^(\s+)(?:```)/.exec(linesText(lines, i, i + 1, endsNL));
        if (dedent !== null) {
          const width = dedent[1].length;
          text = text.split('\n').map((l) => {
            const lead = /^\s+/.exec(l);
            if (lead === null) return l;
            return l.slice(Math.min(lead[0].length, width));
          }).join('\n');
        }
      }
      const lang = unescPunct(fence.info.trim()).match(/^\S*/)[0];
      pushNode({ t: 'codeblock', text, info: lang });
      afterPara = false;
      gapBlanks = 0;
      i = closed === -1 ? end : closed + 1;
      continue;
    }
    // ATX heading.
    const depth = atxDepth(content);
    if (depth > 0) {
      let text = content.slice(depth).trim();
      if (text.endsWith('#')) {
        const stripped = text.replace(/#+$/, '');
        if (stripped === '' || /[ \t]$/.test(stripped)) text = stripped.trim();
      }
      pushNode({ t: 'heading', level: depth, text });
      afterPara = false;
      gapBlanks = 0;
      i++;
      continue;
    }
    // Thematic break.
    if (isRule(content)) {
      pushNode({ t: 'hr' });
      afterPara = false;
      gapBlanks = 0;
      i++;
      continue;
    }
    // Blockquote.
    if (content[0] === '>') {
      const quote = quoteAt(lines, i, end, defs, endsNL);
      pushNode(quote.node);
      afterPara = false;
      gapBlanks = 0;
      // A blank line swallowed at the end of the quote still
      // separates it from the next block.
      if (quote.next > i + 1 && quote.next <= end && blankLine(lines[quote.next - 1]) && nodes.length > 0) pendingGap = true;
      i = quote.next;
      continue;
    }
    // List.
    if (readBullet(content)) {
      const list = listAt(lines, i, end, defs, endsNL);
      if (list !== null) {
        pushNode(list.node);
        afterPara = false;
        gapBlanks = 0;
        if (list.next > i + 1 && list.next <= end && blankLine(lines[list.next - 1]) && nodes.length > 0) pendingGap = true;
        i = list.next;
        continue;
      }
    }
    // HTML block.
    const html = htmlBlockAt(lines, i, end, endsNL);
    if (html !== null) {
      pushNode(html.node);
      afterPara = false;
      gapBlanks = 0;
      i = html.next;
      continue;
    }
    // Link reference definition. A definition directly after
    // paragraph text is part of that paragraph (and defines
    // nothing), so it is parsed without registering when the
    // previous node is a paragraph or text run with no blank line
    // between. Once one definition has merged, the next one merges
    // too.
    if (afterPara) {
      const prevDef = nodes[nodes.length - 1];
      const dry = defAt(lines, i, end, defs, true);
      if (dry !== null) {
        prevDef.text += '\n' + lines.slice(i, dry.next).join('\n');
        gapBlanks = 0;
        i = dry.next;
        continue;
      }
    }
    const def = defAt(lines, i, end, defs, false);
    if (def !== null) {
      // A definition is a token too: a blank line before it still
      // separates two blocks inside this call.
      if (pendingGap) {
        blankGap = true;
        pendingGap = false;
      }
      afterPara = false;
      gapBlanks = 0;
      i = def.next;
      continue;
    }
    // Table.
    const table = tableStart(lines, i, end, endsNL);
    if (table !== null) {
      const rows = [];
      for (let r = i + 2; r < table.rowsEnd; r++) {
        rows.push(splitCells(lines[r], table.headCells.length));
      }
      pushNode({ t: 'tableblock', headCells: table.headCells, alignments: table.alignments, bodyRows: rows });
      afterPara = false;
      gapBlanks = 0;
      i = table.rowsEnd;
      continue;
    }
    // Paragraph, bare text, or setext heading.
    const run = gatherRun(lines, i, end, topLevel ? 'paragraph' : 'baretext', endsNL);
    const prev = nodes.length > 0 ? nodes[nodes.length - 1] : null;
    if (mergePrev && prev !== null && (prev.t === 'paragraph' || prev.t === 'baretext') &&
        (run.node.t === 'paragraph' || run.node.t === 'baretext') && gapBlanks === 0) {
      prev.text += '\n' + run.node.text;
      afterPara = true;
    } else if (!topLevel && prev !== null && prev.t === 'baretext' && run.node.t === 'baretext' && gapBlanks === 0) {
      prev.text += '\n' + run.node.text;
      afterPara = true;
    } else {
      pushNode(run.node);
      afterPara = run.node.t === 'paragraph' || run.node.t === 'baretext';
    }
    gapBlanks = 0;
    i = run.next;
  }
  return blankGap;
}

// Does `line` start a block when the content indent is `maxIndent`
// (used inside list items: a block start at an indent below the
// item's content indent ends the item)? `maxIndent` is the content
// indent minus one.
function blockStartBelow(line, maxIndent) {
  const n = spaceRun(line);
  if (n > maxIndent) return false;
  const content = line.slice(n);
  if (fenceStart(content)) return true;
  if (atxDepth(content) > 0) return true;
  if (htmlBreaksPara(content)) return true;
  if (content[0] === '>') return true;
  if (readBullet(content)) return true;
  if (isRule(content)) return true;
  return false;
}

// Lex a list starting at lines[i]. Returns {node, next} or null
// when the line is not really a list start.
function listAt(lines, i, end, defs, endsNL) {
  const first = lines[i];
  const [firstCols, firstIdx] = leadIndent(first);
  if (firstCols > 3) return null;
  const marker0 = readBullet(first.slice(firstIdx));
  if (marker0 === null) return null;
  const ordered = marker0.ordered;
  const delim = marker0.delim;
  const start = ordered ? marker0.num : 1;
  const entries = [];
  let j = i;
  while (j < end) {
    const line = lines[j];
    const [lineCols, lineIdx] = leadIndent(line);
    if (lineCols > 3) break;
    const content = line.slice(lineIdx);
    const marker = readBullet(content);
    if (marker === null || marker.ordered !== ordered || marker.delim !== delim) break;
    if (isRule(content)) break;
    // One item, starting at line j.
    const itemStart = j;
    const contentCol = lineIdx + marker.markerLen; // column where the content begins
    const rest = content.slice(marker.markerLen);
    // Expand tabs in the leading whitespace of the content, from
    // column contentCol.
    let restExpanded = '';
    {
      let col = contentCol;
      let k = 0;
      while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) {
        if (rest[k] === ' ') {
          restExpanded += ' ';
          col++;
          k++;
        } else {
          const width = 4 - (col % 4);
          restExpanded += ' '.repeat(width);
          col += width;
          k++;
        }
      }
      restExpanded += rest.slice(k);
    }
    const firstLine = restExpanded;
    const empty = firstLine.trim() === '';
    let contentIndent;
    let firstContent = '';
    if (empty) {
      contentIndent = contentCol + 1;
    } else {
      let spaces = 0;
      while (spaces < firstLine.length && firstLine[spaces] === ' ') spaces++;
      const take = spaces > 4 ? 1 : spaces;
      firstContent = firstLine.slice(take);
      contentIndent = take + contentCol;
    }
    const itemLines = empty ? [] : [firstContent];
    let prevLine = firstLine;
    let prevBlank = empty;
    let k = j + 1;
    let absorbedBlank = false;
    if (empty && k < end && blankLine(lines[k])) {
      k++;
      absorbedBlank = true;
    }
    // Block-start tests inside an item use the content indent minus
    // one, clamped to 0..3.
    const br = Math.max(0, Math.min(3, contentIndent - 1));
    if (!absorbedBlank) {
      while (k < end) {
        const rawLine = lines[k];
        const expanded = expandLead(rawLine);
        const firstPos = firstNonSpace(expanded);
        const blank = firstPos === -1;
        if (!blank && blockStartBelow(rawLine, br)) break;
        if (blank || firstPos >= contentIndent) {
          itemLines.push(expanded.slice(contentIndent));
          prevBlank = blank;
          prevLine = expanded.slice(contentIndent);
          k++;
          continue;
        }
        // A less-indented, non-blank line: a lazy continuation,
        // unless the previous line was blank, indented code, or a
        // block start.
        const prevExpanded = prevLine.replace(/\t/g, '    ');
        const prevFirst = firstNonSpace(prevExpanded);
        const prevIndent = spaceRun(prevLine);
        let prevIsBlock = false;
        if (prevIndent <= br) {
          const prevContent = prevLine.slice(prevIndent);
          prevIsBlock = !!fenceStart(prevContent) || atxDepth(prevContent) > 0 ||
            htmlBreaksPara(prevContent) || isRule(prevContent);
        }
        if (prevBlank || prevFirst >= 4 || prevIsBlock) break;
        let kept;
        if (/^ {0,3}(?:=+|-+) *$/.test(rawLine) && setextPair(prevLine, rawLine)) {
          kept = '    ' + expanded.replace(/^ {0,3}/, '');
        } else {
          kept = rawLine;
        }
        itemLines.push(kept);
        prevBlank = false;
        prevLine = expanded.slice(contentIndent);
        k++;
      }
    }
    // The item's text: the collected lines, with the last item's
    // text trimmed at the end (only the last item is trimmed).
    const itemEnd = k;
    let isLast = true;
    if (itemEnd < end) {
      const [nextCols, nextIdx] = leadIndent(lines[itemEnd]);
      if (nextCols <= 3) {
        const nextContent = lines[itemEnd].slice(nextIdx);
        const nextMarker = readBullet(nextContent);
        if (nextMarker !== null && nextMarker.ordered === ordered && nextMarker.delim === delim &&
            !isRule(nextContent)) {
          isLast = false;
        }
      }
    }
    let textLines = itemLines.slice();
    if (isLast) {
      const joined = textLines.join('\n').replace(/[ \t\n]+$/, '');
      textLines = joined === '' ? [] : joined.split('\n');
    }
    // An item whose raw text ends with a blank line makes the list
    // loose (unless it is the last item); the raw text is the
    // source slice from this item to the next one. Only the last
    // lines can decide that, so no joined string is built.
    const endsBlank = itemTailBlank(lines, itemStart, itemEnd, itemEnd < end || endsNL);
    const nodes = [];
    const blankGap = lexLines(textLines, defs, false, nodes, false, false);
    // Task list item: strip the checkbox marker from the first
    // text. The marker can only be on the first line, so only that
    // is read.
    let checked = null;
    if (textLines.length > 0) {
      const taskMatch = /^\[([ xX])\][ \t]+\S/.exec(textLines[0]);
      if (taskMatch !== null && nodes.length > 0 && (nodes[0].t === 'baretext' || nodes[0].t === 'paragraph')) {
        checked = taskMatch[1] !== ' ';
        nodes[0].text = nodes[0].text.replace(/^\[[ xX]\][ \t]+/, '');
      }
    }
    entries.push({ checked, children: nodes, blankGap, endsBlank });
    j = itemEnd;
  }
  if (entries.length === 0) return null;
  const loose = entries.some((it) => it.blankGap) ||
    entries.slice(0, -1).some((it) => it.endsBlank);
  for (const item of entries) {
    if (loose) {
      for (const node of item.children) if (node.t === 'baretext') node.t = 'paragraph';
    }
    delete item.blankGap;
    delete item.endsBlank;
  }
  return {
    node: { t: 'listblock', ordered, start, loose, entries, rawLines: lines.slice(i, j) },
    next: j,
  };
}

// Lex a blockquote starting at lines[i]. Returns {node, next}.
function quoteAt(lines, i, end, defs, endsNL) {
  // Collect the quote's extent: marker lines, plus lazy lines that
  // do not start a block, while the inner content ends in open
  // paragraph text (or a list item).
  const rawLines = [];
  let j = i;
  let paraOpen = false;
  let inFence = null;
  let inTable = false;
  let prevKind = 'blank'; // 'blank' | 'plain' | 'block' | 'list'
  const update = (stripped, idx0) => {
    // A whitespace-only line is blank only when a newline follows
    // it; at the very end of the text it is continuation text.
    if (blankLine(stripped) && (idx0 + 1 < end || endsNL)) {
      paraOpen = false;
      inTable = false;
      prevKind = 'blank';
      return;
    }
    if (inFence !== null) {
      const [cols, idx] = leadIndent(stripped);
      if (cols <= 3 && fenceEnds(stripped.slice(idx), inFence.ch, inFence.len)) inFence = null;
      paraOpen = false;
      prevKind = 'block';
      return;
    }
    const [cols, idx] = leadIndent(stripped);
    const content = stripped.slice(idx);
    // An indented line merges into open paragraph or list-item
    // text; otherwise it is a code block, which closes the
    // paragraph.
    if (cols >= 4) {
      if (prevKind === 'plain' || prevKind === 'list') {
        paraOpen = true;
        inTable = false;
        return;
      }
      paraOpen = false;
      inTable = false;
      prevKind = 'block';
      return;
    }
    if (cols <= 3) {
      const fence = fenceStart(content);
      if (fence !== null) {
        inFence = fence;
        paraOpen = false;
        inTable = false;
        prevKind = 'block';
        return;
      }
      if (atxDepth(content) > 0 || isRule(content) || htmlBreaksPara(content) || setextDepth(content) > 0) {
        paraOpen = false;
        inTable = false;
        prevKind = 'block';
        return;
      }
      if (inTable) {
        paraOpen = false;
        prevKind = 'plain';
        return;
      }
      if (isTableDelim(content) && prevKind === 'plain') {
        inTable = true;
        paraOpen = false;
        prevKind = 'plain';
        return;
      }
      if (readBullet(content)) {
        paraOpen = true;
        inTable = false;
        prevKind = 'list';
        return;
      }
    }
    paraOpen = true;
    inTable = false;
    prevKind = 'plain';
  };
  while (j < end) {
    const line = lines[j];
    const stripped = stripMarker(line);
    if (stripped !== null) {
      rawLines.push(line);
      update(stripped, j);
      j++;
      continue;
    }
    if (blankAt(lines, j, end, endsNL)) break;
    if (!paraOpen) break;
    if (blockStartAt(line, 3)) break;
    rawLines.push(line);
    update(line, j);
    j++;
  }
  // Split the extent into chunks: a chunk is the lazy lines before
  // the first marker, plus the marker lines that follow them. Each
  // chunk is lexed separately, with paragraph/code/definition
  // merges across chunk boundaries.
  let rest = rawLines.slice();
  const nodes = [];
  while (rest.length > 0) {
    const chunk = [];
    let seen = false;
    while (rest.length > 0) {
      const stripped = stripMarker(rest[0]);
      if (stripped !== null) {
        chunk.push(stripped);
        seen = true;
        rest.shift();
      } else if (!seen) {
        // A lazy line that looks like a setext underline is not
        // one: it is indented (four spaces) so the re-lex keeps it
        // as paragraph text.
        let lazy = rest[0];
        if (chunk.length > 0) {
          const m = /^ {0,3}((?:=+|-+)[ \t]*)$/.exec(lazy);
          if (m !== null) lazy = '    ' + m[1];
        }
        chunk.push(lazy);
        rest.shift();
      } else {
        break;
      }
    }
    lexLines(chunk, defs, true, nodes, true, false);
    const last = nodes.length > 0 ? nodes[nodes.length - 1] : null;
    if (last !== null && (last.t === 'listblock' || last.t === 'blockquote') && rest.length > 0) {
      // A list or a nested quote absorbs following lazy lines:
      // re-lex it with the remaining lines appended. Lists see the
      // remaining lines raw; nested quotes see them with one marker
      // level stripped.
      const srcLines = last.rawLines;
      let combined;
      if (last.t === 'listblock') {
        combined = srcLines.concat(rest);
      } else {
        combined = srcLines.concat(rest.map((l) => {
          const q = stripMarker(l);
          return q === null ? l : q;
        }));
      }
      const res = last.t === 'listblock'
        ? listAt(combined, 0, combined.length, defs, false)
        : quoteAt(combined, 0, combined.length, defs, false);
      if (res !== null) {
        const extra = res.next - srcLines.length;
        nodes[nodes.length - 1] = res.node;
        if (extra > 0) rest.splice(0, extra);
      }
    }
  }
  return { node: { t: 'blockquote', children: nodes, rawLines: lines.slice(i, j) }, next: j };
}

// ------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------

function cellHtml(text, align, header, ctx) {
  const tag = header ? 'th' : 'td';
  return '<' + tag + (align ? ' align="' + align + '"' : '') + '>' + inlineHtml(text, ctx) + '</' + tag + '>\n';
}

function blockHtml(node, ctx) {
  switch (node.t) {
    case 'paragraph':
      return '<p>' + inlineHtml(node.text, ctx) + '</p>\n';
    case 'baretext':
      return inlineHtml(node.text, ctx);
    case 'heading':
      return '<h' + node.level + '>' + inlineHtml(node.text, ctx) + '</h' + node.level + '>\n';
    case 'hr':
      return '<hr>\n';
    case 'codeblock': {
      let out = '<pre><code';
      // The language is escaped without encoding entities, and the
      // code text keeps exactly one trailing newline (or none when
      // it is empty).
      if (node.info) out += ' class="language-' + esc(node.info, false) + '"';
      const body = node.text ? node.text.replace(/\n$/, '') + '\n' : '';
      return out + '>' + esc(body, true) + '</code></pre>\n';
    }
    case 'htmlblock':
      return node.text;
    case 'blockquote':
      return '<blockquote>\n' + blocksHtml(node.children, ctx) + '</blockquote>\n';
    case 'listblock': {
      let out = node.ordered
        ? '<ol' + (node.start !== 1 ? ' start="' + node.start + '"' : '') + '>\n'
        : '<ul>\n';
      for (const item of node.entries) {
        const box = item.checked === null
          ? ''
          : '<input ' + (item.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        out += '<li>';
        const kids = item.children;
        if (kids.length > 0 && (kids[0].t === 'paragraph' || kids[0].t === 'baretext')) {
          const first = kids[0];
          if (first.t === 'paragraph') out += '<p>' + box + inlineHtml(first.text, ctx) + '</p>\n';
          else out += box + inlineHtml(first.text, ctx);
          for (let q = 1; q < kids.length; q++) out += blockHtml(kids[q], ctx);
        } else {
          out += box;
          out += blocksHtml(kids, ctx);
        }
        out += '</li>\n';
      }
      return out + (node.ordered ? '</ol>\n' : '</ul>\n');
    }
    case 'tableblock': {
      let head = '';
      for (let p = 0; p < node.headCells.length; p++) {
        head += cellHtml(node.headCells[p], node.alignments[p], true, ctx);
      }
      let body = '';
      for (const row of node.bodyRows) {
        let cells = '';
        for (let p = 0; p < row.length; p++) {
          cells += cellHtml(row[p], node.alignments[p], false, ctx);
        }
        body += '<tr>\n' + cells + '</tr>\n';
      }
      return '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n' +
        (body ? '<tbody>' + body + '</tbody>' : '') + '</table>\n';
    }
    default:
      return '';
  }
}

function blocksHtml(nodes, ctx) {
  let out = '';
  for (const node of nodes) out += blockHtml(node, ctx);
  return out;
}

// The entry point: the HTML marked 18.1.3 renders for `markdown`
// with its defaults (GFM on, breaks off). Stateless per call.
export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const defs = Object.create(null);
  const ctx = { defs, inLink: false, sawLink: false, inRaw: false };
  const lines = src.split('\n');
  const endsNL = src.endsWith('\n');
  if (endsNL) lines.pop();
  const nodes = [];
  lexLines(lines, defs, true, nodes, false, endsNL);
  return blocksHtml(nodes, ctx);
}
