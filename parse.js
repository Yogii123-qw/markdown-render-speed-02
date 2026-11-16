// A Markdown renderer that produces, for every input, exactly the HTML
// marked 18.1.3 produces with its default settings (GFM enabled, hard
// breaks off). It is a hand-written scanner: block structure is derived
// from lines, inline structure from a delimiter-resolving tokenizer.
// It depends on nothing and shares no code with marked.
//
// Layout of this file: small character and text utilities first, then
// the inline engine (tags, links, emphasis), then the block engine
// (headings, lists, quotes, tables, HTML blocks), then rendering and
// the exported parse() entry point.

// The five characters that HTML escaping rewrites, and their entities.
const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// ASCII punctuation, used for backslash escapes and delimiter tests.
const ASCII_PUNCT_CHARS = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

// Fast ASCII punctuation lookup: 1 for punctuation codes, 0 otherwise.
const PUNCT_TABLE = new Uint8Array(128);
for (let t = 0; t < ASCII_PUNCT_CHARS.length; t++) {
  PUNCT_TABLE[ASCII_PUNCT_CHARS.charCodeAt(t)] = 1;
}

// Unicode punctuation/symbol test for non-ASCII characters.
const PUNCT_TEST = /[\p{P}\p{S}]/u;
// Whitespace test (Unicode-aware, like \s).
const WS_TEST = /\s/;

// True when `ch` is one of the six ASCII whitespace characters.
function isWhite(ch) {
  if (ch === undefined || ch === '') return false;
  const code = ch.charCodeAt(0);
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11;
}

// True when `ch` counts as punctuation: ASCII punctuation, or a
// Unicode punctuation/symbol character. Empty input is not punctuation.
function punctP(ch) {
  if (ch === undefined || ch === '') return false;
  const code = ch.charCodeAt(0);
  if (code < 128) return PUNCT_TABLE[code] === 1;
  return PUNCT_TEST.test(ch);
}

// True when `ch` is whitespace in the Unicode sense; the empty string
// (start/end of input) counts as whitespace for flanking purposes.
function uniSpaceP(ch) {
  return ch === '' || ch === undefined || WS_TEST.test(ch);
}

// Does an entity-like reference start at `str[pos]` (str[pos] === '&')?
// marked leaves such an ampersand alone when escaping: `&name;`,
// `&#123;` and `&#x1F;` pass through, anything else becomes `&amp;`.
// Numeric references are capped: at most 7 decimal or 6 hex digits.
function startsEntityLike(str, pos) {
  const total = str.length;
  let p = pos + 1;
  if (str[p] === '#') {
    p++;
    if (str[p] === 'x' || str[p] === 'X') {
      p++;
      const first = p;
      while (p < total && p - first < 6) {
        const c = str.charCodeAt(p);
        const digit = (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
        if (!digit) break;
        p++;
      }
      return p > first && str[p] === ';';
    }
    const first = p;
    while (p < total && p - first < 7) {
      const c = str.charCodeAt(p);
      if (c < 48 || c > 57) break;
      p++;
    }
    return p > first && str[p] === ';';
  }
  const first = p;
  while (p < total) {
    const c = str.charCodeAt(p);
    const alnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    if (!alnum) break;
    p++;
  }
  return p > first && str[p] === ';';
}

// Escape a string for HTML. With `strict`, every `& < > " '` is
// rewritten. Without it, an ampersand that begins an entity-like
// reference is left as-is, matching marked's text escaping.
function escapeHtml(str, strict) {
  const finder = /[&<>"']/g;
  let hit = finder.exec(str);
  if (hit === null) return str;
  let out = '';
  let plainFrom = 0;
  do {
    const at = hit.index;
    const ch = hit[0];
    out += str.slice(plainFrom, at);
    if (ch === '&' && !strict && startsEntityLike(str, at)) {
      out += '&';
    } else {
      out += HTML_ESCAPES[ch];
    }
    plainFrom = at + 1;
    hit = finder.exec(str);
  } while (hit !== null);
  return out + str.slice(plainFrom);
}

// What one numeric character reference decodes to: code point 0, the
// surrogate range and anything above U+10FFFF become U+FFFD, code
// point 38 (an ampersand) becomes the entity `&amp;`, the rest become
// the character itself.
function numericChar(code) {
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
  if (code === 38) return '&amp;';
  return String.fromCodePoint(code);
}

// Decode the numeric character references in `str` the way marked does.
// Strings without `&#` are returned untouched.
function decodeNumericEntities(str) {
  if (str.indexOf('&#') === -1) return str;
  return str.replace(/&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/g, (whole, dec, hex) => {
    const code = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    return numericChar(code);
  });
}

// marked's URL cleaning for href/src attributes: encodeURI, with any
// encoded percent sign restored. An unencodable URL yields null,
// which makes the link render as its inner content alone.
function sanitizeUrl(href) {
  let cleaned;
  try {
    cleaned = encodeURI(href);
  } catch {
    return null;
  }
  return cleaned.replace(/%25/g, '%');
}

// Fold a link label for definition lookup: trim the ends, collapse each
// run of whitespace to one space, then fold case the way marked does
// (lower, upper, lower).
function foldLabel(str) {
  return str.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// True when `line` holds only spaces and tabs (possibly none).
function isBlankStr(line) {
  return /^[ \t]*$/.test(line);
}

// True when the line at `idx` acts as a blank line inside a block run.
// A whitespace-only line is blank only when a newline follows it; at
// the very end of the input, without a trailing newline, it is
// ordinary text instead. A truly empty line is always blank.
function blankHere(lines, idx, end, endsWithNL) {
  if (!isBlankStr(lines[idx])) return false;
  if (idx + 1 < end) return true;
  if (endsWithNL) return true;
  return lines[idx] === '';
}

// The leading indent of `line`: visual columns (a tab jumps to the next
// multiple of four) and the index of the first non-blank character.
// Returned as [columns, index].
function indentOf(line) {
  let cols = 0;
  let pos = 0;
  const total = line.length;
  while (pos < total) {
    const code = line.charCodeAt(pos);
    if (code === 32) {
      cols++;
      pos++;
    } else if (code === 9) {
      cols += 4 - (cols % 4);
      pos++;
    } else {
      break;
    }
  }
  return [cols, pos];
}

// Drop `n` visual columns from the front of `line`. A tab crossing the
// cut leaves behind the spaces that fall on the kept side.
function cutColumns(line, n) {
  let cols = 0;
  let pos = 0;
  const total = line.length;
  while (pos < total && cols < n) {
    const code = line.charCodeAt(pos);
    if (code === 32) {
      cols++;
      pos++;
    } else if (code === 9) {
      const width = 4 - (cols % 4);
      if (cols + width > n) return ' '.repeat(cols + width - n) + line.slice(pos + 1);
      cols += width;
      pos++;
    } else {
      break;
    }
  }
  return line.slice(pos);
}

// Expand the tabs in the leading whitespace of `line` to spaces,
// tracking columns from zero. The rest of the line is untouched.
function expandLeading(line) {
  if (line.indexOf('\t') === -1) return line;
  let pos = 0;
  let col = 0;
  let head = '';
  while (pos < line.length) {
    const ch = line[pos];
    if (ch === ' ') {
      head += ' ';
      col++;
      pos++;
    } else if (ch === '\t') {
      const width = 4 - (col % 4);
      head += ' '.repeat(width);
      col += width;
      pos++;
    } else {
      break;
    }
  }
  return head + line.slice(pos);
}

// Trim the trailing blank lines of a raw block text the way marked's
// helper does: when at most one blank line trails, the text is kept
// whole; otherwise it is cut back to the last line holding content,
// with no trailing newline.
function dropTrailingBlanks(text) {
  const parts = text.split('\n');
  let last = parts.length - 1;
  while (last >= 0 && /^[ \t]*$/.test(parts[last])) last--;
  if (parts.length - last <= 2) return text;
  return parts.slice(0, last + 1).join('\n');
}

// Does the raw text of a list item end with a blank line? The item
// spans lines[a..b), joined with newlines, plus a trailing newline
// when `hasTrailingNL`. Only the final lines can decide: with a
// trailing newline the last line must be blank with another line
// before it; without one the last two lines must both be blank with a
// third line before them. No joined string is built.
function itemEndsWithBlank(lines, a, b, hasTrailingNL) {
  if (b - a < 1) return false;
  if (hasTrailingNL) return b - a >= 2 && isBlankStr(lines[b - 1]);
  return b - a >= 3 && isBlankStr(lines[b - 1]) && isBlankStr(lines[b - 2]);
}

// Tag names that can open an HTML block (CommonMark type 6).
const BLOCK_LEVEL_TAGS = new Set([
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
const RAW_TEXT_TAGS = new Set(['pre', 'script', 'style', 'textarea']);

// ---------------------------------------------------------------------------
// HTML tag scanning
// ---------------------------------------------------------------------------

// The tag name beginning at `str[pos]` (the `<` itself is already
// consumed by the caller): a letter, then letters, digits and hyphens.
// Returned lower-cased, or '' when no name starts here.
function readTagName(str, pos) {
  const total = str.length;
  if (pos >= total) return '';
  const first = str.charCodeAt(pos);
  const letter = (first >= 65 && first <= 90) || (first >= 97 && first <= 122);
  if (!letter) return '';
  let end = pos + 1;
  while (end < total) {
    const code = str.charCodeAt(end);
    const ok = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) || code === 45;
    if (!ok) break;
    end++;
  }
  return str.slice(pos, end).toLowerCase();
}

// Match one inline HTML tag beginning at `str[pos]` (str[pos] === '<').
// Comments, processing instructions, CDATA sections, declarations and
// open/close tags are all covered. Returns the raw tag text, or null
// when the text here is not a tag.
function scanInlineTag(str, pos) {
  const total = str.length;
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
  if (str.startsWith('<!', pos) && pos + 2 < total) {
    const afterBang = str.charCodeAt(pos + 2);
    const letter = (afterBang >= 65 && afterBang <= 90) || (afterBang >= 97 && afterBang <= 122);
    if (letter) {
      // A declaration: a name, then whitespace, then anything to `>`.
      let p = pos + 2;
      while (p < total) {
        const code = str.charCodeAt(p);
        if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) p++;
        else break;
      }
      if (p >= total || !isWhite(str[p])) return null;
      const close = str.indexOf('>', p);
      return close === -1 ? null : str.slice(pos, close + 1);
    }
  }
  let p = pos + 1;
  let closing = false;
  if (str[p] === '/') {
    closing = true;
    p++;
  }
  const name = readTagName(str, p);
  if (name === '') return null;
  p += name.length;
  if (closing) {
    while (p < total && isWhite(str[p])) p++;
    return p < total && str[p] === '>' ? str.slice(pos, p + 1) : null;
  }
  // Open tag: what follows the name must be whitespace, `>` or `/>`,
  // and every attribute starts after whitespace, so `<a href=...>`
  // parses but `<https:` never does.
  for (;;) {
    if (p >= total) return null;
    const ch = str[p];
    if (ch === '>') return str.slice(pos, p + 1);
    if (ch === '/' && str[p + 1] === '>') return str.slice(pos, p + 2);
    if (!isWhite(ch)) return null;
    while (p < total && isWhite(str[p])) p++;
    if (p < total && str[p] === '>') return str.slice(pos, p + 1);
    if (p < total && str[p] === '/' && str[p + 1] === '>') return str.slice(pos, p + 2);
    if (p >= total) return null;
    // One attribute name.
    const first = str[p];
    if (!/[A-Za-z_:]/.test(first)) return null;
    p++;
    while (p < total && /[\w.:-]/.test(str[p])) p++;
    const nameEnd = p;
    while (p < total && isWhite(str[p])) p++;
    if (str[p] === '=') {
      p++;
      while (p < total && isWhite(str[p])) p++;
      const quote = str[p];
      if (quote === '"' || quote === "'") {
        p++;
        while (p < total && str[p] !== quote) p++;
        if (p >= total) return null;
        p++;
      } else {
        const valueStart = p;
        while (p < total) {
          const d = str[p];
          if (isWhite(d) || d === '"' || d === "'" || d === '=' || d === '<' || d === '>' || d === '`') break;
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
function scanTagName(str, pos) {
  let p = pos + 1;
  let closing = false;
  if (str[p] === '/') {
    closing = true;
    p++;
  }
  if (p >= str.length) return null;
  const first = str.charCodeAt(p);
  const letter = (first >= 65 && first <= 90) || (first >= 97 && first <= 122);
  if (!letter) return null;
  const start = p;
  p++;
  while (p < str.length) {
    const code = str.charCodeAt(p);
    const ok = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) || code === 45;
    if (!ok) break;
    p++;
  }
  return [str.slice(start, p).toLowerCase(), closing, p];
}

// The narrow HTML-block start test marked uses when a line might
// interrupt a paragraph (or a lazy continuation, or a list item):
// block-level tags, pre/script/style/textarea open tags, comments,
// processing instructions, declarations and CDATA sections.
function htmlInterruptsPara(str) {
  if (str.charCodeAt(0) !== 60) return false;
  if (str.startsWith('<!--') || str.startsWith('<?') || str.startsWith('<![CDATA[')) return true;
  if (str.startsWith('<!') && str.length > 2) {
    const code = str.charCodeAt(2);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return true;
  }
  const tag = scanTagName(str, 0);
  if (tag === null) return false;
  const [name, closing, end] = tag;
  const after = str[end];
  if (!closing && RAW_TEXT_TAGS.has(name)) {
    return after === undefined || after === ' ' || after === '\t' || after === '>';
  }
  if (!BLOCK_LEVEL_TAGS.has(name)) return false;
  if (after === ' ' || after === '\t' || after === undefined || after === '>') return true;
  return after === '/' && str[end + 1] === '>';
}

// Scan a complete HTML tag beginning at `str[pos]` (str[pos] === '<'),
// honouring quoted attribute values, for the type-7 HTML block test.
// Returns the index just past the tag, or -1. Attribute names and
// values follow the shape marked accepts there; a closing tag takes
// no attributes, and an attribute needs whitespace before it.
function scanCompleteTag(str, pos) {
  const total = str.length;
  let p = pos + 1;
  const closing = str[p] === '/';
  if (closing) p++;
  if (p >= total) return -1;
  const first = str.charCodeAt(p);
  if (!((first >= 97 && first <= 122) || (first >= 65 && first <= 90))) return -1;
  while (p < total) {
    const code = str.charCodeAt(p);
    const ok = (code >= 97 && code <= 122) || (code >= 65 && code <= 90) ||
      (code >= 48 && code <= 57) || code === 45;
    if (!ok) break;
    p++;
  }
  for (;;) {
    let gaps = 0;
    while (p < total && (str[p] === ' ' || str[p] === '\t' || str[p] === '\n')) {
      p++;
      gaps++;
    }
    if (p >= total) return -1;
    if (str[p] === '>') return p + 1;
    if (str[p] === '/' && str[p + 1] === '>') return p + 2;
    if (closing || gaps === 0) return -1;
    const a0 = str.charCodeAt(p);
    const nameStart = (a0 >= 97 && a0 <= 122) || (a0 >= 65 && a0 <= 90) || a0 === 95 || a0 === 58;
    if (!nameStart) return -1;
    p++;
    while (p < total) {
      const code = str.charCodeAt(p);
      const ok = (code >= 97 && code <= 122) || (code >= 65 && code <= 90) ||
        (code >= 48 && code <= 57) || code === 95 || code === 46 || code === 58 || code === 45;
      if (!ok) break;
      p++;
    }
    const nameEnd = p;
    while (p < total && (str[p] === ' ' || str[p] === '\t')) p++;
    if (str[p] === '=') {
      p++;
      while (p < total && (str[p] === ' ' || str[p] === '\t')) p++;
      const quote = str[p];
      if (quote === '"' || quote === "'") {
        p++;
        while (p < total && str[p] !== quote && str[p] !== '\n') p++;
        if (p >= total || str[p] !== quote) return -1;
        p++;
      } else {
        const valueStart = p;
        while (p < total) {
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

// ---------------------------------------------------------------------------
// Inline primitives
// ---------------------------------------------------------------------------

// Drop the backslash from backslash-punctuation pairs (`\*` becomes
// `*`) in link destinations, titles and fence info strings.
function unescapePunctuation(str) {
  return str.replace(/\\([\p{P}\p{S}])/gu, '$1');
}

// Flanking of a delimiter run: whether it can open, whether it can
// close, from the characters around it. Follows the CommonMark
// left-flanking / right-flanking definitions, with Unicode whitespace
// and punctuation.
function flankKind(before, after) {
  const beforeWs = before === '' || uniSpaceP(before);
  const afterWs = after === '' || uniSpaceP(after);
  const beforeP = punctP(before);
  const afterP = punctP(after);
  return {
    canOpen: !afterWs && (!afterP || beforeWs || beforeP),
    canClose: !beforeWs && (!beforeP || afterWs || afterP),
  };
}

// Match the code span whose opening backtick run starts at `str[pos]`.
// Returns {text, end} with `end` just past the closing run, or null
// when no closing run of the same length exists. Newlines inside
// become spaces, and one surrounding space is stripped from each side
// when the content holds a non-space character.
function matchCodeSpan(str, pos) {
  const total = str.length;
  let run = 0;
  while (pos + run < total && str[pos + run] === '`') run++;
  let scan = pos + run;
  for (;;) {
    const tick = str.indexOf('`', scan);
    if (tick === -1) return null;
    let close = 0;
    while (tick + close < total && str[tick + close] === '`') close++;
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
// pattern: a backtick run, non-backtick content, a backtick run (the
// runs need not match in length). Returns the index just past the
// closing run, or -1 when there is no closing run.
function skipLabelSpan(str, pos) {
  const total = str.length;
  let run = 0;
  while (pos + run < total && str[pos + run] === '`') run++;
  const tick = str.indexOf('`', pos + run);
  if (tick === -1) return -1;
  let close = 0;
  while (tick + close < total && str[tick + close] === '`') close++;
  return tick + close;
}

// Read a bracketed label starting at `str[pos]` (str[pos] === '['),
// honouring nesting, backslash escapes and code spans. Returns
// {label, end} with `end` just past the closing bracket, or null.
function readBracket(str, pos) {
  const total = str.length;
  let depth = 1;
  let p = pos + 1;
  while (p < total) {
    const ch = str[p];
    if (ch === '\\') {
      p += 2;
      continue;
    }
    if (ch === '`') {
      // A run of two or more backticks directly before `]` is plain
      // label text (marked's label pattern has its own alternative
      // for exactly that shape): it never opens a code span, even
      // when a later backtick run exists. A single backtick before
      // `]` does open one: with no closing run the label, and so the
      // link, dies here.
      let run = 0;
      while (p + run < total && str[p + run] === '`') run++;
      if (run >= 2 && str[p + run] === ']') {
        p += run;
        continue;
      }
      const past = skipLabelSpan(str, p);
      if (past !== -1) {
        p = past;
        continue;
      }
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

// marked's guard on link text: a raw `<` inside the label that opens a
// tag or autolink reaching past the label's end kills the link.
// `full` is the source from the link's start, `labelOff` the label's
// offset within it, `label` the label text.
function labelHasRunaway(full, labelOff, label) {
  const total = label.length;
  let p = 0;
  while (p < total) {
    const ch = label[p];
    if (ch === '\\') {
      p += 2;
      continue;
    }
    if (ch === '`') {
      const span = matchCodeSpan(label, p);
      if (span) {
        p = span.end;
        continue;
      }
      p++;
      continue;
    }
    if (ch !== '<') {
      p++;
      continue;
    }
    const tail = full.slice(labelOff + p);
    const tag = scanInlineTag(tail, 0) || matchAngleAutolink(tail, 0);
    if (tag !== null && tag.length > total - p) return true;
    p += tag !== null ? tag.length : 1;
  }
  return false;
}

const ANGLE_EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+(?![-_])/;
const ANGLE_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*/;

// Match `<scheme:...>` or `<user@host>` starting at `str[pos]`
// (str[pos] === '<'). Returns the matched text including the brackets,
// or null.
function matchAngleAutolink(str, pos) {
  const total = str.length;
  if (str[pos] !== '<') return null;
  const rest = str.slice(pos + 1);
  const email = ANGLE_EMAIL_RE.exec(rest);
  if (email !== null) {
    const end = pos + 1 + email[0].length;
    if (end < total && str[end] === '>') return str.slice(pos, end + 1);
  }
  const scheme = ANGLE_SCHEME_RE.exec(rest);
  if (scheme !== null) {
    const end = pos + 1 + scheme[0].length;
    if (end < total && str[end] === '>') return str.slice(pos, end + 1);
  }
  return null;
}

// Parse an inline link or image beginning at `str[pos]` (str[pos] is
// `[` or `!`). Returns {atom, end} or null. `ctx` is the shared inline
// state (definitions, link nesting, raw-block flag).
function tryInlineLink(str, pos, ctx) {
  const image = str[pos] === '!';
  const open = image ? pos + 1 : pos;
  if (str[open] !== '[') return null;
  const bracket = readBracket(str, open);
  if (bracket === null) return null;
  const label = bracket.label;
  const afterLabel = bracket.end;
  let href = null;
  let title = null;
  let rawEnd = -1;
  if (str[afterLabel] === '(') {
    // Inline form: `( destination title? )`. When it fails to parse,
    // the shortcut reference for the same label is tried instead.
    let good = true;
    let p = afterLabel + 1;
    while (p < str.length && (str[p] === ' ' || str[p] === '\t' || str[p] === '\n')) p++;
    let dest = '';
    if (str[p] === '<') {
      let close = -1;
      let m = p + 1;
      while (m < str.length) {
        if (str[m] === '\\') {
          m += 2;
          continue;
        }
        if (str[m] === '\n') break;
        if (str[m] === '>') {
          close = m;
          break;
        }
        m++;
      }
      if (close === -1) {
        good = false;
      } else {
        let slashes = 0;
        for (let t = close - 1; t >= p + 1 && str[t] === '\\'; t--) slashes++;
        if (slashes % 2 === 1) good = false;
      }
      if (good) {
        dest = str.slice(p + 1, close);
        p = close + 1;
      }
    } else {
      const start = p;
      let depth = 0;
      while (p < str.length) {
        const ch = str[p];
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch.charCodeAt(0) < 0x20) break;
        if (ch === '\\') {
          p += 2;
          continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')') {
          if (depth === 0) break;
          depth--;
        }
        p++;
      }
      if (depth > 0) good = false;
      dest = str.slice(start, p);
    }
    // Optional title after the destination.
    let pastDest = p;
    if (good && (str[p] === ' ' || str[p] === '\t' || str[p] === '\n')) {
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
      if (quote === '"' || quote === "'" || quote === '(') {
        const closer = quote === '(' ? ')' : quote;
        let m = q + 1;
        let closed = false;
        while (m < str.length) {
          if (str[m] === '\\') {
            m += 2;
            continue;
          }
          if (str[m] === closer) {
            closed = true;
            break;
          }
          if (quote === "'" && str[m] === '\n') {
            let r = m + 1;
            while (r < str.length && (str[r] === ' ' || str[r] === '\t')) r++;
            if (str[r] === '\n' || r >= str.length) break;
          }
          m++;
        }
        if (closed) {
          title = unescapePunctuation(str.slice(q + 1, m));
          pastDest = m + 1;
        }
      }
    }
    if (good) {
      let e = pastDest;
      while (e < str.length && (str[e] === ' ' || str[e] === '\t' || str[e] === '\n')) e++;
      if (str[e] !== ')') {
        good = false;
      } else {
        let slashes = 0;
        for (let t = e - 1; t > afterLabel && str[t] === '\\'; t--) slashes++;
        if (slashes % 2 === 1) good = false;
      }
      if (good) rawEnd = e + 1;
    }
    if (good) {
      href = unescapePunctuation(dest);
    } else {
      // The inline form failed: fall back to the shortcut reference.
      const def = ctx.defs[foldLabel(label)];
      if (!def) return null;
      href = def.href;
      title = def.title;
      rawEnd = afterLabel;
    }
  } else if (str[afterLabel] === '[') {
    // Full reference form [label][ref]. An undefined reference leaves
    // the whole construct literal: there is no fallback to the
    // shortcut form for the same opening bracket.
    const refBracket = readBracket(str, afterLabel);
    if (refBracket === null) return null;
    const ref = refBracket.label === '' ? label : refBracket.label;
    const def = ctx.defs[foldLabel(ref)];
    if (!def) return null;
    href = def.href;
    title = def.title;
    rawEnd = refBracket.end;
  } else {
    // Shortcut reference form [label].
    const def = ctx.defs[foldLabel(label)];
    if (!def) return null;
    href = def.href;
    title = def.title;
    rawEnd = afterLabel;
  }
  if (labelHasRunaway(str.slice(pos), image ? 2 : 1, label)) return null;
  // Tokenize the label's own inline content, tracking nested links
  // the way marked's link builder does: a link inside a link kills
  // the outer link (but not an image).
  const keptInside = ctx.insideLink;
  const keptSaw = ctx.sawLink;
  const keptRaw = ctx.insideRaw;
  ctx.insideLink = true;
  ctx.sawLink = false;
  const kids = tokenizeInline(label, ctx);
  const nested = ctx.sawLink;
  ctx.insideLink = keptInside;
  ctx.sawLink = keptSaw;
  if (!image) {
    if (nested) {
      ctx.insideRaw = keptRaw;
      return null;
    }
    ctx.sawLink = true;
  }
  const atom = image
    ? { t: 'img', href, title, kids, flat: label }
    : { t: 'lnk', href, title, kids, flat: label, auto: false };
  return { atom, end: rawEnd };
}

// Trim a candidate extended autolink the way marked's backpedal does:
// keep the longest prefix built from non-punctuation runs, balanced
// parenthesised groups, `&` not starting an entity, and punctuation
// runs that are not at the very end; repeat until the prefix stops
// changing. This cuts a URL off before an unmatched `(`.
const BACKPEDAL_PATTERN = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![A-Za-z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function trimUrlTail(candidate) {
  let current = candidate;
  for (;;) {
    const hit = BACKPEDAL_PATTERN.exec(current);
    const next = hit ? hit[0] : '';
    if (next === current) return next;
    current = next;
  }
}

// Sticky forms of the extended-autolink patterns: they run on the
// whole inline string with `lastIndex` at the candidate start, so no
// suffix slice is taken (that slice, at nearly every character, was
// the hottest allocation in the parser).
const PROTO_Y = /(?:mailto|xmpp):[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?:\/[A-Za-z0-9@.]+)?(?![\w-])/y;
const WWW_Y = /(?:www\.)(?:[A-Za-z0-9-]+\.?)+[^\s<]*/y;
const SCHEME_Y = /(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/(?:[A-Za-z0-9-]+\.?)+[^\s<]*/y;
const EMAIL_Y = /[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?![\w-])/y;
const EMAIL_NOLOOK_Y = /[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+/y;

// Characters allowed in an email local part (all ASCII). A table
// lookup replaces a regex test that ran at nearly every position.
const EMAIL_LOCAL_TABLE = new Uint8Array(128);
for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+-/=?^_`{|}~") {
  EMAIL_LOCAL_TABLE[ch.charCodeAt(0)] = 1;
}
function emailLocalCharP(ch) {
  return !!ch && emailLocalCodeP(ch.charCodeAt(0));
}
function emailLocalCodeP(code) {
  return code < 128 && EMAIL_LOCAL_TABLE[code] === 1;
}

// Try to match an extended autolink (www., scheme://, email, mailto:,
// xmpp:) starting at `pos`. Returns {atom, end} or null.
function tryExtendedUrl(str, pos, ctx, atoms, masked) {
  if (ctx.insideLink) return null;
  // Each pattern can only start on its own first letter, so the
  // regexes run only for those letters (109 m, 120 x, 119 w, 104 h,
  // 72 H, 102 f, 70 F). This runs at most at word starts, so without
  // the guards every word would pay for regex calls that fail on
  // their first character.
  const first = str.charCodeAt(pos);
  if (first === 109 || first === 120) {
    PROTO_Y.lastIndex = pos;
    const hit = PROTO_Y.exec(str);
    if (hit !== null) {
      const text = hit[0];
      return { atom: { t: 'lnk', href: text, title: null, kids: null, flat: text, auto: true }, end: pos + text.length };
    }
  }
  if (first === 119 && str.startsWith('www.', pos)) {
    const prev = pos === 0 ? '' : str[pos - 1];
    if (prev === '' || isWhite(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(') {
      WWW_Y.lastIndex = pos;
      const hit = WWW_Y.exec(str);
      if (hit !== null) {
        const text = trimUrlTail(hit[0]);
        if (text.length > 4) {
          return { atom: { t: 'lnk', href: 'http://' + text, title: null, kids: null, flat: text, auto: true }, end: pos + text.length };
        }
      }
    }
  }
  if (first === 104 || first === 72 || first === 102 || first === 70) {
    SCHEME_Y.lastIndex = pos;
    const hit = SCHEME_Y.exec(str);
    if (hit !== null) {
      const text = trimUrlTail(hit[0]);
      return { atom: { t: 'lnk', href: text, title: null, kids: null, flat: text, auto: true }, end: pos + text.length };
    }
  }
  const prev = pos === 0 ? '' : str[pos - 1];
  if (emailLocalCharP(str[pos]) && (prev === '' || !emailLocalCharP(prev))) {
    // Cheap pre-check: an email needs an '@' after the local part.
    // Scan forward over local-part characters; with no '@' after
    // them the regex cannot match and is not run at all.
    let scan = pos;
    const total = str.length;
    while (scan < total && emailLocalCodeP(str.charCodeAt(scan))) scan++;
    if (str[scan] !== '@') return null;
    EMAIL_Y.lastIndex = pos;
    const match = EMAIL_Y.exec(str);
    // The lookahead can cut the domain short only because the email
    // is followed by `_`, which is exactly what an emphasis closer
    // looks like. Marked matches the email after the strong is
    // formed, so the closer is already consumed there. Accept the
    // longer match only when that `_` run really is the closer of an
    // unmatched `_` opener: build a synthetic closer atom for the run
    // and ask the closer search whether any earlier opener pairs
    // with it. That keeps `__a __b__ c@x.com__` (opener already
    // paired) literal while `__a _b_ c@x.com__` (debt swallows the
    // middle closer) still matches the email.
    if (atoms !== null && atoms !== undefined) {
      EMAIL_NOLOOK_Y.lastIndex = pos;
      const longer = EMAIL_NOLOOK_Y.exec(str);
      if (longer !== null && (match === null || longer[0].length > match[0].length)) {
        const longEnd = pos + longer[0].length;
        let runEnd = longEnd;
        while (runEnd < str.length && str[runEnd] === '_') runEnd++;
        if (runEnd > longEnd) {
          const before = str[longEnd - 1];
          const after = runEnd >= str.length ? '' : str[runEnd];
          const flank = flankKind(before, after);
          const closes = flank.canClose && (!flank.canOpen || punctP(after));
          if (closes) {
            const synthetic = {
              t: 'dlm', mark: '_', len: runEnd - longEnd, total: runEnd - longEnd,
              preceded: false,
              canOpen: flank.canOpen && (!flank.canClose || punctP(before)),
              canClose: closes,
              hidden: masked !== null && masked.slice(longEnd, runEnd) !== str.slice(longEnd, runEnd),
            };
            const probe = atoms.concat([synthetic]);
            for (let oi = atoms.length - 1; oi >= 0; oi--) {
              const cand = atoms[oi];
              if (cand.t !== 'dlm' || cand.mark !== '_' || !cand.canOpen) continue;
              const found = findCloser(probe, oi);
              if (found !== null && found.closerIdx === atoms.length) {
                const text = longer[0];
                return { atom: { t: 'lnk', href: 'mailto:' + text, title: null, kids: null, flat: text, auto: true }, end: longEnd };
              }
            }
          }
        }
      }
    }
    if (match !== null) {
      const text = match[0];
      return { atom: { t: 'lnk', href: 'mailto:' + text, title: null, kids: null, flat: text, auto: true }, end: pos + text.length };
    }
  }
  return null;
}

// The plain text of a link label (image alt text): formatting is
// stripped, code spans keep their text, line breaks vanish.
function labelPlainText(atoms) {
  let out = '';
  for (const atom of atoms) {
    switch (atom.t) {
      case 'txt': out += decodeNumericEntities(atom.str); break;
      case 'esc': out += atom.str; break;
      case 'code': out += atom.str; break;
      case 'raw': out += atom.str; break;
      case 'brk': break;
      case 'lnk': case 'img': out += atom.kids ? labelPlainText(atom.kids) : atom.flat; break;
      case 'dlm': out += atom.mark.repeat(atom.len); break;
      case 'emph': case 'strg': case 'strike': out += labelPlainText(atom.kids); break;
      default: break;
    }
  }
  return out;
}

function renderLink(atom) {
  const url = sanitizeUrl(atom.href);
  if (atom.auto) {
    const display = escapeHtml(atom.flat, true);
    if (url === null) return display;
    return '<a href="' + escapeHtml(url, true) + '">' + display + '</a>';
  }
  const inner = renderAtomList(atom.kids);
  if (url === null) return inner;
  let out = '<a href="' + escapeHtml(url, false) + '"';
  if (atom.title) out += ' title="' + escapeHtml(atom.title, false) + '"';
  return out + '>' + inner + '</a>';
}

function renderImage(atom) {
  const alt = escapeHtml(labelPlainText(atom.kids), false);
  const url = sanitizeUrl(atom.href);
  if (url === null) return alt;
  let out = '<img src="' + escapeHtml(url, false) + '" alt="' + alt + '"';
  if (atom.title) out += ' title="' + escapeHtml(atom.title, false) + '"';
  return out + '>';
}

function renderAtomList(atoms) {
  let out = '';
  for (const atom of atoms) {
    switch (atom.t) {
      case 'txt': out += atom.raw ? atom.str : escapeHtml(decodeNumericEntities(atom.str), false); break;
      case 'esc': out += escapeHtml(atom.str, false); break;
      case 'code': out += '<code>' + escapeHtml(atom.str, true) + '</code>'; break;
      case 'brk': out += '<br>'; break;
      case 'raw': out += atom.str; break;
      case 'lnk': out += renderLink(atom); break;
      case 'img': out += renderImage(atom); break;
      case 'dlm': out += atom.mark.repeat(atom.len); break;
      case 'emph': out += '<em>' + renderAtomList(atom.kids) + '</em>'; break;
      case 'strg': out += '<strong>' + renderAtomList(atom.kids) + '</strong>'; break;
      case 'strike': out += '<del>' + renderAtomList(atom.kids) + '</del>'; break;
      default: break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Delimiter resolution
// ---------------------------------------------------------------------------

// Find the delimiter atom that closes the opener at `openerIdx`.
// The search walks forward carrying a debt: the opener's length, plus
// the length of every open-only run of the same character met on the
// way, minus the length of every candidate closer. The first closer
// that pays the debt off wins. Three extra rules shape the walk:
//  * a masked run (inside a code span, link or tag placeholder) can
//    never close;
//  * for `*` and `_`, when the opener or the candidate can both open
//    and close, the rule of three applies: a candidate whose length
//    makes (opener total + candidate) a multiple of three is skipped
//    and its length is remembered, unless the opener total itself is
//    a multiple of three; and when the opener is preceded by the same
//    delimiter and the candidate can also open, the search stops;
//  * a `~` closer must match the opener's length exactly, and runs of
//    another length neither close nor add debt.
// A lone delimiter flanked by a double run of the other character
// (`__ * __`) is skipped at the start of the search. Returns
// {closerIdx, effLen, use} or null.
function findCloser(atoms, openerIdx) {
  const opener = atoms[openerIdx];
  const mark = opener.mark;
  const openLen = opener.len;
  const runTotal = opener.total;
  const preceded = opener.preceded;
  let debt = openLen;
  let skipped = 0;
  const openerCloses = opener.canClose;
  let skipTriple = -1;
  {
    const other = mark === '*' ? '_' : '*';
    const found = [];
    for (let p = openerIdx + 1; p < atoms.length && found.length < 3; p++) {
      if (atoms[p].t === 'dlm') found.push(p);
    }
    if (found.length === 3 &&
        atoms[found[0]].mark === other && atoms[found[0]].len === 2 &&
        atoms[found[1]].mark === mark && atoms[found[1]].len === 1 &&
        atoms[found[2]].mark === other && atoms[found[2]].len >= 2) {
      skipTriple = found[1];
    }
  }
  for (let cIdx = openerIdx + 1; cIdx < atoms.length; cIdx++) {
    const cand = atoms[cIdx];
    if (cand.t !== 'dlm' || cand.mark !== mark) continue;
    if (cIdx === skipTriple) continue;
    if (cand.hidden) continue;
    const candLen = cand.len;
    if (mark === '~') {
      if (candLen !== openLen) continue;
      if (!cand.canClose) {
        if (cand.canOpen) debt += candLen;
        continue;
      }
    } else {
      if (!cand.canClose) {
        if (cand.canOpen) debt += candLen;
        continue;
      }
      const dual = cand.canOpen;
      if (dual || openerCloses) {
        if (preceded && dual) return null;
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
// strikethrough nodes, in place. An opener with no closer loses its
// first character to literal text and the rest of the run is retried
// as a fresh opener (a tilde run, or a run of length one, is swallowed
// whole). A matched pair takes one or two characters from each side
// depending on the parity of the usable length; the leftovers stay
// inside the new node and are resolved by recursion, and any surplus
// of the closer run stays after it as a fresh delimiter atom.
function resolveDelimiters(atoms) {
  let idx = 0;
  while (idx < atoms.length) {
    const atom = atoms[idx];
    if (atom.t !== 'dlm' || !atom.canOpen) {
      idx++;
      continue;
    }
    const hit = findCloser(atoms, idx);
    if (hit === null) {
      if (atom.mark === '~' || atom.len === 1) {
        atoms[idx] = { t: 'txt', str: atom.mark.repeat(atom.len), raw: false };
        idx++;
      } else {
        atoms.splice(idx, 1,
          { t: 'txt', str: atom.mark, raw: false },
          {
            t: 'dlm', mark: atom.mark, len: atom.len - 1, total: atom.total,
            preceded: true, canOpen: atom.canOpen, canClose: atom.canClose,
            hidden: atom.hidden,
          });
        idx++;
      }
      continue;
    }
    const { closerIdx, effLen, use } = hit;
    const closer = atoms[closerIdx];
    const middle = atoms.slice(idx + 1, closerIdx);
    let after = null;
    if (closer.len > effLen) {
      after = {
        t: 'dlm', mark: atom.mark, len: closer.len - effLen,
        total: closer.len - effLen, preceded: true,
        canOpen: closer.canOpen, canClose: closer.canClose, hidden: closer.hidden,
      };
    }
    let node;
    if (atom.mark === '~') {
      node = { t: 'strike', kids: resolveDelimiters(middle) };
    } else {
      const take = use % 2 === 1 ? 1 : 2;
      const kids = [];
      if (atom.len > take) {
        kids.push({
          t: 'dlm', mark: atom.mark, len: atom.len - take, total: atom.len - take,
          preceded: false, canOpen: atom.canOpen, canClose: atom.canClose, hidden: atom.hidden,
        });
      }
      kids.push(...middle);
      if (effLen > take) {
        kids.push({
          t: 'dlm', mark: atom.mark, len: effLen - take, total: effLen - take,
          preceded: false, canOpen: closer.canOpen, canClose: closer.canClose, hidden: closer.hidden,
        });
      }
      node = { t: use % 2 === 1 ? 'emph' : 'strg', kids: resolveDelimiters(kids) };
    }
    const replacement = [node];
    if (after !== null) replacement.push(after);
    atoms.splice(idx, closerIdx - idx + 1, ...replacement);
    idx++;
  }
  return atoms;
}

// The masking marked applies before the emphasis closer search: code
// spans, links and tags are replaced by same-length placeholders, so
// a delimiter inside one cannot close an emphasis opened outside it.
// A "code span" here may start at any backtick run — even one inside
// a link label that never forms a real code span — so it can swallow
// a closer that sits after the link. The masked text keeps the
// original length, so positions still line up.
const MASK_SPAN_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MASK_BLOCK_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
function maskForEmphasis(str) {
  const stageOne = str.replace(MASK_SPAN_RE,
    (whole, run, escaped) => escaped
      ? '+'.repeat(whole.length)
      : run
        ? run + whole.slice(run.length, -run.length).replace(/`/g, '+') + run
        : whole);
  return stageOne.replace(MASK_BLOCK_RE,
    (whole, gA, gEmpty) => {
      const keep = gEmpty ? gEmpty.length : 0;
      return whole.slice(0, keep) + '[' + 'a'.repeat(whole.length - keep - 2) + ']';
    });
}

// The next position where the inline loop can do anything: a special
// character (space, backslash, backtick, '<', '[', '!', '*', '_',
// '~'), a URL prefix, or an '@' (whose email starts at the word start
// before it).
const NEXT_INTEREST_RE = /[ \\`<\[\[*!_~!]|www\.|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/|mailto:|xmpp:|@/g;

// Tag shapes that toggle the link/raw-block state while tokenizing.
const OPEN_A_RE = /^<a /i;
const CLOSE_A_RE = /^<\/a>/i;
const OPEN_RAW_RE = /^<(pre|code|kbd|script)(\s|>)/i;
const CLOSE_RAW_RE = /^<\/(pre|code|kbd|script)(\s|>)/i;

// True when `ch` is ASCII punctuation (the backslash-escape set).
function asciiPunctP(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return code < 128 && PUNCT_TABLE[code] === 1;
}

// Where a hard break starting at `str[pos]` ends (just past the
// newline), or -1: two or more spaces, or one backslash, directly
// before a newline.
function hardBreakEnd(str, pos) {
  if (str.charCodeAt(pos) === 32) {
    let p = pos;
    while (p < str.length && str[p] === ' ') p++;
    return (p - pos >= 2 && str[p] === '\n') ? p + 1 : -1;
  }
  return str[pos + 1] === '\n' ? pos + 2 : -1;
}

// Whether a delimiter run can open / can close, from the characters
// around it and the delimiter kind. `*` follows flanking directly;
// `_` needs a punctuation neighbour on the side it cannot flank;
// `~` only needs a non-space, non-tilde neighbour on each side.
function delimiterFlags(code, prev, next) {
  const flank = flankKind(prev, next);
  if (code === 42) return [flank.canOpen, flank.canClose];
  if (code === 95) {
    return [
      flank.canOpen && (!flank.canClose || punctP(prev)),
      flank.canClose && (!flank.canOpen || punctP(next)),
    ];
  }
  return [
    next !== '' && !isWhite(next) && next !== '~',
    prev !== '' && !isWhite(prev) && prev !== '~',
  ];
}

// Tokenize one inline string into atoms (no rendering yet). `ctx`
// carries the link definitions and the link/raw-block state.
function tokenizeInline(str, ctx) {
  const atoms = [];
  const total = str.length;
  let i = 0;
  // The plain-text run is kept as an index range [runStart, i) into
  // the source instead of a string built one character at a time: it
  // is sliced once, when flushed. `runStart` is -1 while no run is
  // open (a flush happens before an atom is consumed, so it cannot
  // be reset to `i` — the atom's own characters come after).
  // `runRaw` is the raw-block flag of the run's first character (it
  // cannot change mid-run: only a tag atom changes it, and a tag
  // atom flushes first).
  let runStart = -1;
  let runRaw = false;
  // A delimiter run is masked when the masking above replaced it: it
  // cannot close an emphasis, though it can still open one. Only
  // worth computing when a backtick could start a masking span.
  const masked = (str.includes('`') && (str.includes('*') || str.includes('_') || str.includes('~')))
    ? maskForEmphasis(str)
    : null;
  const flush = () => {
    if (runStart !== -1) {
      atoms.push({ t: 'txt', str: str.slice(runStart, i), raw: runRaw });
      runStart = -1;
    }
  };
  const emit = (atom) => {
    flush();
    atoms.push(atom);
  };
  while (i < total) {
    // Dispatch on the character code, not a one-character string:
    // reading `str[i]` allocates at every position, a code does not.
    // 32 space, 92 backslash, 96 backtick, 60 '<', 91 '[', 33 '!',
    // 42 '*', 95 '_', 126 '~'.
    const code = str.charCodeAt(i);
    if (code === 32 || code === 92) {
      // Hard break: spaces or a backslash before a newline, unless
      // nothing but whitespace follows.
      const brEnd = hardBreakEnd(str, i);
      if (brEnd !== -1) {
        let rest = brEnd;
        while (rest < total && (str[rest] === ' ' || str[rest] === '\t')) rest++;
        if (str.slice(rest).trim() !== '') {
          emit({ t: 'brk' });
          i = rest;
          continue;
        }
      }
      if (code === 92 && i + 1 < total && asciiPunctP(str[i + 1])) {
        emit({ t: 'esc', str: str[i + 1] });
        i += 2;
        continue;
      }
      if (runStart === -1) {
        runStart = i;
        runRaw = ctx.insideRaw;
      }
      i++;
      continue;
    }
    if (code === 96) {
      const span = matchCodeSpan(str, i);
      if (span !== null) {
        emit({ t: 'code', str: span.text });
        i = span.end;
        continue;
      }
      // A failed code span swallows the whole backtick run as literal
      // text (marked's text token starts with the full run); the next
      // attempt is only at the next special character.
      let p = i;
      while (p < total && str[p] === '`') p++;
      if (runStart === -1) {
        runStart = i;
        runRaw = ctx.insideRaw;
      }
      i = p;
      continue;
    }
    if (code === 60) {
      const tag = scanInlineTag(str, i);
      if (tag !== null) {
        if (!ctx.insideLink && OPEN_A_RE.test(tag)) ctx.insideLink = true;
        else if (ctx.insideLink && CLOSE_A_RE.test(tag)) ctx.insideLink = false;
        if (!ctx.insideRaw && OPEN_RAW_RE.test(tag)) ctx.insideRaw = true;
        else if (ctx.insideRaw && CLOSE_RAW_RE.test(tag)) ctx.insideRaw = false;
        emit({ t: 'raw', str: tag });
        i += tag.length;
        continue;
      }
      const auto = matchAngleAutolink(str, i);
      if (auto !== null) {
        const inner = auto.slice(1, -1);
        const isEmail = inner.indexOf(':') === -1;
        emit({ t: 'lnk', href: isEmail ? 'mailto:' + inner : inner, title: null, kids: null, flat: inner, auto: true });
        i += auto.length;
        continue;
      }
      if (runStart === -1) {
        runStart = i;
        runRaw = ctx.insideRaw;
      }
      i++;
      continue;
    }
    if (code === 91 || (code === 33 && str.charCodeAt(i + 1) === 91)) {
      const hit = tryInlineLink(str, i, ctx);
      if (hit !== null) {
        emit(hit.atom);
        i = hit.end;
        continue;
      }
      if (runStart === -1) {
        runStart = i;
        runRaw = ctx.insideRaw;
      }
      i++;
      continue;
    }
    if (code === 42 || code === 95 || code === 126) {
      let p = i;
      while (p < total && str.charCodeAt(p) === code) p++;
      const len = p - i;
      if (code === 126 && len > 2) {
        if (runStart === -1) {
          runStart = i;
          runRaw = ctx.insideRaw;
        }
        i = p;
        continue;
      }
      // An escape right before the run is `+` in the masked text
      // marked runs its flanking on, not the escaped character: a
      // `\~` before a `~~` run must not count as "preceded by `~`".
      let prev = i === 0 ? '' : str[i - 1];
      if (runStart === -1 && atoms.length > 0 && atoms[atoms.length - 1].t === 'esc') prev = '+';
      const next = p >= total ? '' : str[p];
      const [canOpen, canClose] = delimiterFlags(code, prev, next);
      // `total` is the run length (kept across split retries);
      // `preceded` says the character before this run is the same
      // delimiter — false for a freshly tokenized run.
      const hidden = masked !== null && masked.slice(i, p) !== str.slice(i, p);
      emit({ t: 'dlm', mark: str[i], len, total: len, preceded: false, canOpen, canClose, hidden });
      i = p;
      continue;
    }
    // Extended autolinks (www., scheme://, email) — only outside
    // links. The check is only worth calling where a match can
    // start: a word start (an email may begin there) or the first
    // letter of a scheme/www./mailto:/xmpp: prefix. That keeps the
    // per-character cost to a few cheap checks instead of regexes
    // over the rest of the string.
    if (!ctx.insideLink) {
      // 119 w, 104 h, 72 H, 102 f, 70 F, 109 m, 120 x.
      const prevCode = i === 0 ? -1 : str.charCodeAt(i - 1);
      const wordStart = prevCode === -1 || !emailLocalCodeP(prevCode);
      let maybe = false;
      if (wordStart) maybe = emailLocalCodeP(code);
      else if (code === 119) maybe = str.startsWith('www.', i);
      else if (code === 104 || code === 72 || code === 102 || code === 70) maybe = str[i + 1] === 't' || str[i + 1] === 'T';
      else if (code === 109) maybe = str.startsWith('mailto:', i);
      else if (code === 120) maybe = str.startsWith('xmpp:', i);
      if (maybe) {
        const hit = tryExtendedUrl(str, i, ctx, atoms, masked);
        if (hit !== null) {
          emit(hit.atom);
          i = hit.end;
          continue;
        }
      }
    }
    // Plain character: the URL/email check above already failed for
    // this position, so the rest of the plain run is jumped over in
    // one step — one regex scan finds the next position where
    // something can happen instead of one iteration per character.
    // An '@' stops the run at the word start before it (clamped to
    // just after here, so a word that started before this run is
    // never jumped back to).
    if (runStart === -1) {
      runStart = i;
      runRaw = ctx.insideRaw;
    }
    NEXT_INTEREST_RE.lastIndex = i + 1;
    const hit = NEXT_INTEREST_RE.exec(str);
    let p = hit ? hit.index : total;
    if (hit !== null && hit[0] === '@') {
      let w = p;
      while (w > i + 1 && emailLocalCodeP(str.charCodeAt(w - 1))) w--;
      p = w;
    }
    i = p;
  }
  flush();
  return resolveDelimiters(atoms);
}

// Render one inline string to HTML. The raw-block flag resets for
// each string; the link flag persists across blocks within one
// parse() call, matching marked's per-document state.
function renderInline(src, ctx) {
  ctx.insideRaw = false;
  return renderAtomList(tokenizeInline(src, ctx));
}

// ---------------------------------------------------------------------------
// Block parsing
//
// Nodes: {t:'para'|'bare', text} paragraph or bare text, {t:'head',
// depth, text}, {t:'rule'}, {t:'code', text, lang}, {t:'html', text},
// {t:'quote', kids, source}, {t:'list', ordered, start, loose, items,
// source}, {t:'table', header, aligns, rows}.
// The lexer works on lines (the source split on '\n', with the final
// empty piece of a trailing newline dropped); `endsWithNL` says
// whether the source ended with a newline, which decides trailing
// newlines in raw code and HTML block text.
// ---------------------------------------------------------------------------

// Rebuild the raw source text of lines[a..b): the lines joined by
// '\n', plus a trailing newline when another line follows or the
// source ended with one.
function sourceSlice(lines, a, b, endsWithNL) {
  let text = lines.slice(a, b).join('\n');
  if (b < lines.length || endsWithNL) text += '\n';
  return text;
}

// Index of the first character of `str` that is not a space, or -1.
function firstContentPos(str) {
  let pos = 0;
  while (pos < str.length && str[pos] === ' ') pos++;
  return pos < str.length ? pos : -1;
}

// Count leading spaces (characters, not columns) of `str`.
function spacePrefixLen(str) {
  let pos = 0;
  while (pos < str.length && str[pos] === ' ') pos++;
  return pos;
}

// ATX heading level of `str` (content after at most 3 columns of
// indent), or 0 when `str` does not start a heading.
function atxLevel(str) {
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
function thematicBreakP(str) {
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

// Setext underline level of `str` (content after at most 3 columns of
// indent): 1 for `=`, 2 for `-`, 0 otherwise.
function setextLevel(str) {
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
function fenceOpen(str) {
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

// Is `str` a closing fence for a fence of `ch` opened with `len` runs?
function fenceCloses(str, ch, len) {
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
// null. The marker must be followed by a space, a tab, or the end of
// the line.
function readMarker(str) {
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
// Only bullets, and ordered markers starting at 1, with real content
// after the marker, interrupt one.
function markerBreaksPara(line) {
  const [cols, idx] = indentOf(line);
  if (cols > 3) return false;
  const marker = readMarker(line.slice(idx));
  if (marker === null) return false;
  if (marker.ordered && marker.num !== 1) return false;
  const rest = line.slice(idx + marker.markerLen);
  let pos = 0;
  while (pos < rest.length && (rest[pos] === ' ' || rest[pos] === '\t')) pos++;
  return pos > 0 && pos < rest.length;
}

// Is `str` a table delimiter row (after at most 3 columns of indent)?
function tableDelimP(str) {
  if (/^(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/.test(str)) {
    return str.indexOf(':') !== -1 || str.indexOf('|') !== -1;
  }
  return false;
}

// Split one table row into cells the way marked's splitter does:
// split on unescaped pipes, drop a leading and a trailing empty cell,
// trim each cell and turn `\|` back into `|`. When `count` is given,
// pad or truncate to that many cells.
function splitRow(str, count) {
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

// Does a table start at lines[i]? Returns {header, aligns, rowsEnd}
// (rowsEnd is the index just past the last row) or null.
function tableAt(lines, i, end, endsWithNL) {
  const [headCols, headIdx] = indentOf(lines[i]);
  if (headCols > 3) return null;
  const headText = lines[i].slice(headIdx);
  if (headText.trim() === '') return null;
  if (i + 1 >= end) return null;
  const [delimCols, delimIdx] = indentOf(lines[i + 1]);
  if (delimCols > 3) return null;
  const delimText = lines[i + 1].slice(delimIdx);
  if (!tableDelimP(delimText)) return null;
  const header = splitRow(headText);
  const delimBody = delimText.replace(/^\|/, '').replace(/\|\s*$/, '');
  const delimCells = delimBody.split('|');
  if (header.length !== delimCells.length) return null;
  const aligns = delimCells.map((cell) => {
    if (/^ *-+: *$/.test(cell)) return 'right';
    if (/^ *:-+: *$/.test(cell)) return 'center';
    if (/^ *:-+ *$/.test(cell)) return 'left';
    return null;
  });
  let k = i + 2;
  while (k < end) {
    const line = lines[k];
    // A row line ends only on a spaces-only line that a newline
    // follows (the table pattern's ` *\n`); a line holding a tab is
    // a row, and trims to an all-empty row.
    if (/^ *$/.test(line) && (k + 1 < end || endsWithNL)) break;
    const [cols, idx] = indentOf(line);
    // The `code` exclusion needs a non-newline character after the
    // indent; a tab-only line is a row, not code.
    if (cols >= 4 && line.slice(idx).trim() !== '') break;
    const content = line.slice(idx);
    if (thematicBreakP(content) || atxLevel(content) > 0 || stripQuote(line) !== null) break;
    if (fenceOpen(content)) break;
    const marker = readMarker(content);
    if (marker !== null && (!marker.ordered || marker.num === 1)) break;
    if (htmlInterruptsPara(content)) break;
    k++;
  }
  return { header, aligns, rowsEnd: k };
}

// Strip one blockquote marker level from `line`. Returns the content
// after the marker, or null when the line does not start one. A tab
// after the marker expands to spaces first, then one space is dropped.
function stripQuote(line) {
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

// Collect an HTML block whose end is marked by `closer` appearing in
// a line (a comment close, `?>`, `]]>`, a declaration `>`, or a
// closing tag for a pre/script/style/textarea block). `from` is the
// index in lines[i] to start searching from; `closeTag` searches case
// insensitively for `</name`. The block also swallows following blank
// lines; its text is the raw text with trailing blanks trimmed the
// way marked's helper does.
function collectUntil(lines, i, end, endsWithNL, closer, from, closeTag) {
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
    // Only truly empty lines follow the closer (the pattern swallows
    // newlines, not whitespace-only lines): a tab-only line stays
    // outside the block, or the trailing-newline trim goes wrong.
    k2 = found + 1;
    while (k2 < end && lines[k2] === '') k2++;
  }
  return { node: { t: 'html', text: dropTrailingBlanks(sourceSlice(lines, i, k2, endsWithNL)) }, next: k2 };
}

// Collect a type-6/7 HTML block: lines up to (not including) the
// first blank line, swallowing the blank lines that follow.
function collectToBlank(lines, i, end, endsWithNL) {
  let k = i;
  while (k < end && !isBlankStr(lines[k])) k++;
  let k2 = k;
  while (k2 < end && isBlankStr(lines[k2])) k2++;
  return { node: { t: 'html', text: dropTrailingBlanks(sourceSlice(lines, i, k2, endsWithNL)) }, next: k2 };
}

// Try to read an HTML block starting at lines[i]. Returns
// {node, next} or null.
function tryHtml(lines, i, end, endsWithNL) {
  const line = lines[i];
  const [cols, idx] = indentOf(line);
  if (cols > 3) return null;
  const content = line.slice(idx);
  if (content.charCodeAt(0) !== 60) return null; // '<'
  if (content.startsWith('<!--')) {
    // Short comments `<!-->` and `<!--->` end on this very line.
    if (content[4] === '>' || (content[4] === '-' && content[5] === '>')) {
      let k2 = i + 1;
      while (k2 < end && lines[k2] === '') k2++;
      return { node: { t: 'html', text: dropTrailingBlanks(sourceSlice(lines, i, k2, endsWithNL)) }, next: k2 };
    }
    return collectUntil(lines, i, end, endsWithNL, '-->', 4, false);
  }
  if (content.startsWith('<?')) return collectUntil(lines, i, end, endsWithNL, '?>', 2, false);
  if (content.startsWith('<![CDATA[')) return collectUntil(lines, i, end, endsWithNL, ']]>', 9, false);
  if (content.startsWith('<!') && content.length > 2) {
    const third = content[2];
    if ((third >= 'A' && third <= 'Z') || (third >= 'a' && third <= 'z')) {
      return collectUntil(lines, i, end, endsWithNL, '>', 2, false);
    }
  }
  const tag = scanTagName(content, 0);
  if (tag === null) return null;
  const [name, closing, nameEnd] = tag;
  if (!closing && RAW_TEXT_TAGS.has(name)) {
    const after = content[nameEnd];
    // A bare name at end of line only opens the block when a newline
    // follows it (the opening pattern needs whitespace or `>`).
    if ((after === undefined && (i + 1 < end || endsWithNL)) || after === ' ' || after === '\t' || after === '>') {
      return collectUntil(lines, i, end, endsWithNL, '</' + name + '>', 0, true);
    }
  }
  if (BLOCK_LEVEL_TAGS.has(name)) {
    const after = content[nameEnd];
    if (after === ' ' || after === '\t' || after === undefined || after === '>') return collectToBlank(lines, i, end, endsWithNL);
    if (after === '/' && content[nameEnd + 1] === '>') return collectToBlank(lines, i, end, endsWithNL);
  }
  // Type 7: a complete tag, alone on its line, for a tag that is
  // neither a raw-text tag nor a block tag. Tag names may be
  // upper-case.
  if (!RAW_TEXT_TAGS.has(name)) {
    const first = content[closing ? 2 : 1];
    if ((first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z')) {
      const tagEnd = scanCompleteTag(content, 0);
      if (tagEnd !== -1) {
        let p = tagEnd;
        while (p < content.length && (content[p] === ' ' || content[p] === '\t')) p++;
        if (p === content.length) return collectToBlank(lines, i, end, endsWithNL);
      }
    }
  }
  return null;
}

// Try to read a link reference definition starting at lines[i]. When
// one matches, the first definition for its label wins; the
// definition is recorded in `defs`. Returns {next} (index just past
// the definition) or null. With `dry`, the shape is tested without
// recording anything.
function tryDefinition(lines, i, end, defs, dry) {
  const [cols, idx] = indentOf(lines[i]);
  if (cols > 3) return null;
  const maxLines = Math.min(end - i, 6);
  let src = '';
  for (let k = 0; k < maxLines; k++) src += (k ? '\n' : '') + lines[i + k];
  let p = idx;
  if (src[p] !== '[') return null;
  p++;
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
  p++; // past ']'
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
  // Optional title, on this line or the next. It must be preceded by
  // whitespace (spaces/tabs, or a newline); a title glued straight
  // onto the destination is not a title, and the definition is
  // rejected. When the title cannot be used (it never closes, or it
  // is followed by non-EOL text), the definition falls back to its
  // no-title form.
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
  // After the destination (and any title) only spaces/tabs may follow
  // on the line; otherwise the title is dropped and the no-title
  // form is re-tested.
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
  const key = foldLabel(label);
  if (!dry && !Object.prototype.hasOwnProperty.call(defs, key)) {
    defs[key] = {
      href: unescapePunctuation(bracketed ? href : href.replace(/^<(.*)>$/, '$1')),
      title: title === null ? null : unescapePunctuation(title),
    };
  }
  return { next: i + consumed };
}

// Is `line` a block start that interrupts a text run inside a list
// item (any list marker, hr, ATX heading, fence, blockquote start, or
// HTML block start, with at most `maxIndent` spaces of indent)?
function blockStartsHere(line, maxIndent) {
  const n = spacePrefixLen(line);
  if (n > maxIndent) return false;
  const content = line.slice(n);
  if (readMarker(content)) return true;
  if (thematicBreakP(content)) return true;
  if (atxLevel(content) > 0) return true;
  if (fenceOpen(content)) return true;
  if (content[0] === '>') return true;
  if (htmlInterruptsPara(content)) return true;
  return false;
}

// Would the lines `first` (one line) plus a setext underline `under`
// form a setext heading? The text line must not itself look like a
// table delimiter row.
function setextPairP(first, under) {
  const underText = under.slice(indentOf(under)[1]);
  if (setextLevel(underText) === 0) return false;
  const [cols, idx] = indentOf(first);
  if (cols >= 4) return false;
  const content = first.slice(idx);
  if (content.trim() === '') return false;
  if (readMarker(content)) return false;
  if (fenceOpen(content)) return false;
  if (content[0] === '>') return false;
  if (atxLevel(content) > 0) return false;
  if (htmlInterruptsPara(content)) return false;
  if (tableDelimP(content)) return false;
  return true;
}

// Collect a paragraph (top level, `mode` 'para') or a bare text run
// (inside a list item, `mode` 'bare') starting at lines[i]. A setext
// underline after the run turns it into a heading instead. Returns
// {node, next}.
function gatherText(lines, i, end, mode, endsWithNL) {
  const start = i;
  let j = i;
  let setext = 0;
  while (j < end) {
    const line = lines[j];
    if (j > start) {
      // In bare mode (a list item, lexed with topLevel false) a
      // whitespace-only line always ends the run: marked's text
      // token is one line and the rest becomes a space token, even
      // at the end of the text where no newline follows. In
      // paragraph mode the paragraph pattern keeps such a trailing
      // line.
      if (blankHere(lines, j, end, endsWithNL) || (mode === 'bare' && isBlankStr(line))) break;
      const [cols, idx] = indentOf(line);
      const content = line.slice(idx);
      if (cols <= 3) {
        if (thematicBreakP(content)) {
          setext = setextLevel(content);
          break;
        }
        if (atxLevel(content) > 0) break;
        if (content[0] === '>') break;
        if (fenceOpen(content)) break;
        if (htmlInterruptsPara(content)) break;
        if (mode === 'para') {
          if (markerBreaksPara(line)) break;
          if (tableAt(lines, j, end, endsWithNL)) break;
        } else {
          if (readMarker(content)) break;
          if (tableAt(lines, j, end, endsWithNL)) break;
        }
        const underline = setextLevel(content);
        if (underline > 0) {
          // A setext underline ends the run only when the run so far
          // can be its text: no line of the run may look like a
          // table delimiter row, and the first line must be a plain
          // line.
          let ok = setextPairP(lines[start], line);
          if (ok) {
            for (let k = start + 1; k < j; k++) {
              const [liCols, liIdx] = indentOf(lines[k]);
              const liContent = lines[k].slice(liIdx);
              if (liCols >= 4 || readMarker(liContent) || tableDelimP(liContent)) {
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
      } else if (mode === 'bare') {
        // An indented line starts an indented code block in bare mode.
        break;
      }
      // In paragraph mode an indented line is ordinary continuation text.
    }
    j++;
  }
  if (setext > 0) {
    const text = lines.slice(start, j).join('\n').trim();
    return { node: { t: 'head', depth: setext, text }, next: j + 1 };
  }
  // Trailing blank lines collected into the run (from a list item or
  // a blockquote chunk) are not part of the paragraph: the paragraph
  // token's text drops them, the way a blank line ends a run.
  const text = lines.slice(start, j).join('\n').replace(/\n+$/, '');
  return { node: { t: mode, text }, next: j };
}

// The main block lexer. Appends nodes for lines[0..lines.length) to
// `nodes` and returns true when a blank line separated two blocks
// inside this call (the loose-list signal). `topLevel` selects
// paragraph versus bare-text runs; `mergePrev` allows a leading
// paragraph/text/code node to merge into a trailing paragraph/text
// node left by an earlier chunk (blockquote chunks). `endsWithNL`
// says whether the text ended with a newline.
function lexBlocks(lines, defs, topLevel, nodes, mergePrev, endsWithNL) {
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
    // Outside the top level (a list item) a whitespace-only line is
    // blank even at the end of the text: it becomes a space token
    // there, never a text run of its own.
    if (blankHere(lines, i, end, endsWithNL) || (!topLevel && isBlankStr(line))) {
      i++;
      gapBlanks++;
      if (nodes.length > 0) pendingGap = true;
      afterPara = false;
      continue;
    }
    const [cols, idx] = indentOf(line);
    const content = line.slice(idx);
    // Indented code. A whitespace-only line is never code on its own.
    if (cols >= 4 && !isBlankStr(line)) {
      let k = i;
      let lastCode = -1;
      while (k < end) {
        const candidate = lines[k];
        if (isBlankStr(candidate)) {
          k++;
          continue;
        }
        const [candCols] = indentOf(candidate);
        if (candCols >= 4) {
          lastCode = k;
          k++;
          continue;
        }
        break;
      }
      // Trailing blank lines belong to the code token's raw text.
      let k2 = lastCode + 1;
      while (k2 < end && isBlankStr(lines[k2])) k2++;
      const raw = sourceSlice(lines, i, k2, endsWithNL);
      const trimmed = dropTrailingBlanks(raw);
      const text = trimmed.split('\n').map((l) => cutColumns(l, 4)).join('\n');
      const prev = nodes.length > 0 ? nodes[nodes.length - 1] : null;
      if (prev !== null && (prev.t === 'para' || prev.t === 'bare') && gapBlanks === 0) {
        prev.text += '\n' + text;
        afterPara = true;
      } else {
        pushNode({ t: 'code', text, lang: '' });
        afterPara = false;
      }
      gapBlanks = 0;
      i = k2;
      continue;
    }
    // Fenced code.
    const fence = fenceOpen(content);
    if (fence !== null) {
      let k = i + 1;
      let closed = -1;
      while (k < end) {
        const candidate = lines[k];
        const [candCols, candIdx] = indentOf(candidate);
        if (candCols <= 3 && fenceCloses(candidate.slice(candIdx), fence.ch, fence.len)) {
          closed = k;
          break;
        }
        k++;
      }
      const contentEnd = closed === -1 ? end : closed;
      let text = lines.slice(i + 1, contentEnd).join('\n');
      if (fence.ch === '`') {
        // Indented fences dedent their content by the fence's indent.
        const dedent = /^(\s+)(?:```)/.exec(sourceSlice(lines, i, i + 1, endsWithNL));
        if (dedent !== null) {
          const width = dedent[1].length;
          text = text.split('\n').map((l) => {
            const lead = /^\s+/.exec(l);
            if (lead === null) return l;
            return l.slice(Math.min(lead[0].length, width));
          }).join('\n');
        }
      }
      const lang = unescapePunctuation(fence.info.trim()).match(/^\S*/)[0];
      pushNode({ t: 'code', text, lang });
      afterPara = false;
      gapBlanks = 0;
      i = closed === -1 ? end : closed + 1;
      continue;
    }
    // ATX heading.
    const depth = atxLevel(content);
    if (depth > 0) {
      let text = content.slice(depth).trim();
      if (text.endsWith('#')) {
        const stripped = text.replace(/#+$/, '');
        if (stripped === '' || /[ \t]$/.test(stripped)) text = stripped.trim();
      }
      pushNode({ t: 'head', depth, text });
      afterPara = false;
      gapBlanks = 0;
      i++;
      continue;
    }
    // Thematic break.
    if (thematicBreakP(content)) {
      pushNode({ t: 'rule' });
      afterPara = false;
      gapBlanks = 0;
      i++;
      continue;
    }
    // Blockquote.
    if (content[0] === '>') {
      const quote = lexQuoteBlock(lines, i, end, defs, endsWithNL);
      pushNode(quote.node);
      afterPara = false;
      gapBlanks = 0;
      // A blank line swallowed at the end of the quote still
      // separates it from the next block (a nested list's raw text
      // is trimmed, so its trailing blank line belongs to the outer
      // text).
      if (quote.next > i + 1 && quote.next <= end && isBlankStr(lines[quote.next - 1]) && nodes.length > 0) pendingGap = true;
      i = quote.next;
      continue;
    }
    // List.
    if (readMarker(content)) {
      const list = lexListBlock(lines, i, end, defs, endsWithNL);
      if (list !== null) {
        pushNode(list.node);
        afterPara = false;
        gapBlanks = 0;
        if (list.next > i + 1 && list.next <= end && isBlankStr(lines[list.next - 1]) && nodes.length > 0) pendingGap = true;
        i = list.next;
        continue;
      }
    }
    // HTML block.
    const html = tryHtml(lines, i, end, endsWithNL);
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
      const dry = tryDefinition(lines, i, end, defs, true);
      if (dry !== null) {
        prevDef.text += '\n' + lines.slice(i, dry.next).join('\n');
        gapBlanks = 0;
        i = dry.next;
        continue;
      }
    }
    const def = tryDefinition(lines, i, end, defs, false);
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
    const table = tableAt(lines, i, end, endsWithNL);
    if (table !== null) {
      const rows = [];
      for (let r = i + 2; r < table.rowsEnd; r++) {
        rows.push(splitRow(lines[r], table.header.length));
      }
      pushNode({ t: 'table', header: table.header, aligns: table.aligns, rows });
      afterPara = false;
      gapBlanks = 0;
      i = table.rowsEnd;
      continue;
    }
    // Paragraph, bare text, or setext heading.
    const run = gatherText(lines, i, end, topLevel ? 'para' : 'bare', endsWithNL);
    const prev = nodes.length > 0 ? nodes[nodes.length - 1] : null;
    if (mergePrev && prev !== null && (prev.t === 'para' || prev.t === 'bare') &&
        (run.node.t === 'para' || run.node.t === 'bare') && gapBlanks === 0) {
      prev.text += '\n' + run.node.text;
      afterPara = true;
    } else if (!topLevel && prev !== null && prev.t === 'bare' && run.node.t === 'bare' && gapBlanks === 0) {
      prev.text += '\n' + run.node.text;
      afterPara = true;
    } else {
      pushNode(run.node);
      afterPara = run.node.t === 'para' || run.node.t === 'bare';
    }
    gapBlanks = 0;
    i = run.next;
  }
  return blankGap;
}

// Does `line` start a block when the content indent is `maxIndent`
// (used inside list items: a block start at an indent below the
// item's content indent ends the item)? `maxIndent` is the content
// indent minus one, matching the way marked parameterises these
// tests.
function blockStartsBelow(line, maxIndent) {
  const n = spacePrefixLen(line);
  if (n > maxIndent) return false;
  const content = line.slice(n);
  if (fenceOpen(content)) return true;
  if (atxLevel(content) > 0) return true;
  if (htmlInterruptsPara(content)) return true;
  if (content[0] === '>') return true;
  if (readMarker(content)) return true;
  if (thematicBreakP(content)) return true;
  return false;
}

// Lex a list starting at lines[i]. Returns {node, next} or null when
// the line is not really a list start.
function lexListBlock(lines, i, end, defs, endsWithNL) {
  const first = lines[i];
  const [firstCols, firstIdx] = indentOf(first);
  if (firstCols > 3) return null;
  const marker0 = readMarker(first.slice(firstIdx));
  if (marker0 === null) return null;
  const ordered = marker0.ordered;
  const delim = marker0.delim;
  const start = ordered ? marker0.num : 1;
  const items = [];
  let j = i;
  while (j < end) {
    const line = lines[j];
    const [lineCols, lineIdx] = indentOf(line);
    if (lineCols > 3) break;
    const content = line.slice(lineIdx);
    const marker = readMarker(content);
    if (marker === null || marker.ordered !== ordered || marker.delim !== delim) break;
    if (thematicBreakP(content)) break;
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
      let take = spaces > 4 ? 1 : spaces;
      firstContent = firstLine.slice(take);
      contentIndent = take + contentCol;
    }
    const itemLines = empty ? [] : [firstContent];
    let prevLine = firstLine;
    let prevBlank = empty;
    let k = j + 1;
    let absorbedBlank = false;
    if (empty && k < end && isBlankStr(lines[k])) {
      k++;
      absorbedBlank = true;
    }
    // Block-start tests inside an item use the content indent minus
    // one, clamped to 0..3.
    const br = Math.max(0, Math.min(3, contentIndent - 1));
    if (!absorbedBlank) {
      while (k < end) {
        const rawLine = lines[k];
        const expanded = expandLeading(rawLine);
        const firstPos = firstContentPos(expanded);
        const blank = firstPos === -1;
        if (!blank && blockStartsBelow(rawLine, br)) break;
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
        const prevFirst = firstContentPos(prevExpanded);
        const prevIndent = spacePrefixLen(prevLine);
        let prevIsBlock = false;
        if (prevIndent <= br) {
          const prevContent = prevLine.slice(prevIndent);
          prevIsBlock = !!fenceOpen(prevContent) || atxLevel(prevContent) > 0 ||
            htmlInterruptsPara(prevContent) || thematicBreakP(prevContent);
        }
        if (prevBlank || prevFirst >= 4 || prevIsBlock) break;
        let kept;
        if (/^ {0,3}(?:=+|-+) *$/.test(rawLine) && setextPairP(prevLine, rawLine)) {
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
    // The item's text: the collected lines, with the last item's text
    // trimmed at the end (marked trims only the last item).
    const itemEnd = k;
    let isLast = true;
    if (itemEnd < end) {
      const [nextCols, nextIdx] = indentOf(lines[itemEnd]);
      if (nextCols <= 3) {
        const nextContent = lines[itemEnd].slice(nextIdx);
        const nextMarker = readMarker(nextContent);
        if (nextMarker !== null && nextMarker.ordered === ordered && nextMarker.delim === delim &&
            !thematicBreakP(nextContent)) {
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
    // loose (unless it is the last item); the raw text is the source
    // slice from this item to the next one. Only the last lines can
    // decide that, so no joined string is built.
    const endsBlank = itemEndsWithBlank(lines, itemStart, itemEnd, itemEnd < end || endsWithNL);
    const nodes = [];
    const blankGap = lexBlocks(textLines, defs, false, nodes, false, false);
    // Task list item: strip the checkbox marker from the first text.
    // The marker can only be on the first line, so only that is read.
    let checked = null;
    if (textLines.length > 0) {
      const taskMatch = /^\[([ xX])\][ \t]+\S/.exec(textLines[0]);
      if (taskMatch !== null && nodes.length > 0 && (nodes[0].t === 'bare' || nodes[0].t === 'para')) {
        checked = taskMatch[1] !== ' ';
        nodes[0].text = nodes[0].text.replace(/^\[[ xX]\][ \t]+/, '');
      }
    }
    items.push({ check: checked, kids: nodes, blankGap, endsBlank });
    j = itemEnd;
  }
  if (items.length === 0) return null;
  const loose = items.some((it) => it.blankGap) ||
    items.slice(0, -1).some((it) => it.endsBlank);
  for (const item of items) {
    if (loose) {
      for (const node of item.kids) if (node.t === 'bare') node.t = 'para';
    }
    delete item.blankGap;
    delete item.endsBlank;
  }
  return {
    node: { t: 'list', ordered, start, loose, items, source: lines.slice(i, j) },
    next: j,
  };
}

// Lex a blockquote starting at lines[i]. Returns {node, next}.
function lexQuoteBlock(lines, i, end, defs, endsWithNL) {
  // Collect the quote's extent: marker lines, plus lazy lines that do
  // not start a block, while the inner content ends in open paragraph
  // text (or a list item).
  const rawLines = [];
  let j = i;
  let paraOpen = false;
  let inFence = null;
  let inTable = false;
  let prevKind = 'blank'; // 'blank' | 'plain' | 'block' | 'list'
  const update = (stripped, idx0) => {
    // A whitespace-only line is blank only when a newline follows
    // it; at the very end of the text it is continuation text.
    if (isBlankStr(stripped) && (idx0 + 1 < end || endsWithNL)) {
      paraOpen = false;
      inTable = false;
      prevKind = 'blank';
      return;
    }
    if (inFence !== null) {
      const [cols, idx] = indentOf(stripped);
      if (cols <= 3 && fenceCloses(stripped.slice(idx), inFence.ch, inFence.len)) inFence = null;
      paraOpen = false;
      prevKind = 'block';
      return;
    }
    const [cols, idx] = indentOf(stripped);
    const content = stripped.slice(idx);
    // An indented line merges into open paragraph or list-item text;
    // otherwise it is a code block, which closes the paragraph.
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
      const fence = fenceOpen(content);
      if (fence !== null) {
        inFence = fence;
        paraOpen = false;
        inTable = false;
        prevKind = 'block';
        return;
      }
      if (atxLevel(content) > 0 || thematicBreakP(content) || htmlInterruptsPara(content) || setextLevel(content) > 0) {
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
      if (tableDelimP(content) && prevKind === 'plain') {
        inTable = true;
        paraOpen = false;
        prevKind = 'plain';
        return;
      }
      if (readMarker(content)) {
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
    const stripped = stripQuote(line);
    if (stripped !== null) {
      rawLines.push(line);
      update(stripped, j);
      j++;
      continue;
    }
    if (blankHere(lines, j, end, endsWithNL)) break;
    if (!paraOpen) break;
    if (blockStartsHere(line, 3)) break;
    rawLines.push(line);
    update(line, j);
    j++;
  }
  // Split the extent into chunks: a chunk is the lazy lines before
  // the first marker, plus the marker lines that follow them. Each
  // chunk is lexed separately, with paragraph/code/definition merges
  // across chunk boundaries, the way marked's blockquote loop does it.
  let rest = rawLines.slice();
  const nodes = [];
  while (rest.length > 0) {
    const chunk = [];
    let seen = false;
    while (rest.length > 0) {
      const stripped = stripQuote(rest[0]);
      if (stripped !== null) {
        chunk.push(stripped);
        seen = true;
        rest.shift();
      } else if (!seen) {
        // A lazy line that looks like a setext underline is not one:
        // it is indented (four spaces) so the re-lex keeps it as
        // paragraph text.
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
    lexBlocks(chunk, defs, true, nodes, true, false);
    const last = nodes.length > 0 ? nodes[nodes.length - 1] : null;
    if (last !== null && (last.t === 'list' || last.t === 'quote') && rest.length > 0) {
      // A list or a nested quote absorbs following lazy lines:
      // re-lex it with the remaining lines appended. Lists see the
      // remaining lines raw; nested quotes see them with one marker
      // level stripped.
      const srcLines = last.source;
      let combined;
      if (last.t === 'list') {
        combined = srcLines.concat(rest);
      } else {
        combined = srcLines.concat(rest.map((l) => {
          const q = stripQuote(l);
          return q === null ? l : q;
        }));
      }
      const res = last.t === 'list'
        ? lexListBlock(combined, 0, combined.length, defs, false)
        : lexQuoteBlock(combined, 0, combined.length, defs, false);
      if (res !== null) {
        const extra = res.next - srcLines.length;
        nodes[nodes.length - 1] = res.node;
        if (extra > 0) rest.splice(0, extra);
      }
    }
  }
  return { node: { t: 'quote', kids: nodes, source: lines.slice(i, j) }, next: j };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderCell(text, align, header, ctx) {
  const tag = header ? 'th' : 'td';
  return '<' + tag + (align ? ' align="' + align + '"' : '') + '>' + renderInline(text, ctx) + '</' + tag + '>\n';
}

function renderBlock(node, ctx) {
  switch (node.t) {
    case 'para':
      return '<p>' + renderInline(node.text, ctx) + '</p>\n';
    case 'bare':
      return renderInline(node.text, ctx);
    case 'head':
      return '<h' + node.depth + '>' + renderInline(node.text, ctx) + '</h' + node.depth + '>\n';
    case 'rule':
      return '<hr>\n';
    case 'code': {
      let out = '<pre><code';
      // The language is escaped without encoding entities, and the
      // code text keeps exactly one trailing newline (or none when
      // it is empty).
      if (node.lang) out += ' class="language-' + escapeHtml(node.lang, false) + '"';
      const body = node.text ? node.text.replace(/\n$/, '') + '\n' : '';
      return out + '>' + escapeHtml(body, true) + '</code></pre>\n';
    }
    case 'html':
      return node.text;
    case 'quote':
      return '<blockquote>\n' + renderBlockList(node.kids, ctx) + '</blockquote>\n';
    case 'list': {
      let out = node.ordered
        ? '<ol' + (node.start !== 1 ? ' start="' + node.start + '"' : '') + '>\n'
        : '<ul>\n';
      for (const item of node.items) {
        const box = item.check === null
          ? ''
          : '<input ' + (item.check ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        out += '<li>';
        const kids = item.kids;
        if (kids.length > 0 && (kids[0].t === 'para' || kids[0].t === 'bare')) {
          const first = kids[0];
          if (first.t === 'para') out += '<p>' + box + renderInline(first.text, ctx) + '</p>\n';
          else out += box + renderInline(first.text, ctx);
          for (let q = 1; q < kids.length; q++) out += renderBlock(kids[q], ctx);
        } else {
          out += box;
          out += renderBlockList(kids, ctx);
        }
        out += '</li>\n';
      }
      return out + (node.ordered ? '</ol>\n' : '</ul>\n');
    }
    case 'table': {
      let head = '';
      for (let p = 0; p < node.header.length; p++) {
        head += renderCell(node.header[p], node.aligns[p], true, ctx);
      }
      let body = '';
      for (const row of node.rows) {
        let cells = '';
        for (let p = 0; p < row.length; p++) {
          cells += renderCell(row[p], node.aligns[p], false, ctx);
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

function renderBlockList(nodes, ctx) {
  let out = '';
  for (const node of nodes) out += renderBlock(node, ctx);
  return out;
}

// The entry point: the HTML marked 18.1.3 renders for `markdown`
// with its defaults (GFM on, breaks off). Stateless per call.
export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const defs = Object.create(null);
  const ctx = { defs, insideLink: false, sawLink: false, insideRaw: false };
  const lines = src.split('\n');
  const endsWithNL = src.endsWith('\n');
  if (endsWithNL) lines.pop();
  const nodes = [];
  lexBlocks(lines, defs, true, nodes, false, endsWithNL);
  return renderBlockList(nodes, ctx);
}
