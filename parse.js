
// A fast, dependency-free Markdown renderer producing exactly the HTML
// that marked 18.1.3 produces with its defaults (GFM on, breaks off).
// Written from scratch as a hand scanner: line based block parsing plus a
// delimiter-stack inline parser. No part of marked's source is used here.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// ASCII punctuation characters, for backslash escapes and delimiter checks.
const ASCII_PUNCT = '!\"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const PUNCT_RE = /[\p{P}\p{S}]/u;
const SPACE_RE = /\s/;

// Escape `& < > " '` fully when `all` is set; otherwise leave alone an
// ampersand that starts something shaped like an entity or numeric
// reference (`&word;`, `&#123;`, `&#x1F;`), exactly as marked does.
function escText(s, all) {
  if (all) {
    if (!/[&<>"']/.test(s)) return s;
    return s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
  }
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '&') {
      // Is this the start of a valid entity-like reference?
      let j = i + 1;
      let ok = false;
      if (s[j] === '#') {
        j++;
        if (s[j] === 'x' || s[j] === 'X') {
          j++;
          const st = j;
          while (j < n && /[0-9A-Fa-f]/.test(s[j]) && j - st < 6) j++;
          if (j > st && s[j] === ';') ok = true;
        } else {
          const st = j;
          while (j < n && s[j] >= '0' && s[j] <= '9' && j - st < 7) j++;
          if (j > st && s[j] === ';') ok = true;
        }
      } else {
        const st = j;
        while (j < n && /[A-Za-z0-9]/.test(s[j])) j++;
        if (j > st && s[j] === ';') ok = true;
      }
      if (ok) { out += '&'; i++; continue; }
      out += '&amp;'; i++; continue;
    }
    const rep = ESCAPES[c];
    if (rep) { out += rep; i++; continue; }
    out += c; i++;
  }
  return out;
}

// Decode numeric character references (`&#35;`, `&#x22;`) the way marked
// does: 0, surrogates and > U+10FFFF become U+FFFD, 38 becomes `&amp;`.
function decodeNumeric(s) {
  if (s.indexOf('&#') === -1) return s;
  return s.replace(/&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/g, (m, dec, hex) => {
    const code = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// marked's cleanUrl: encodeURI, with %25 turned back into %.
function cleanUrl(href) {
  let u;
  try { u = encodeURI(href); } catch { return null; }
  return u.replace(/%25/g, '%');
}

// Normalise a link label: trim, collapse inner whitespace, fold case
// through upper then lower (the Unicode case fold marked uses).
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function isSpace(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'; }
function isPunctChar(ch) {
  if (ch === undefined || ch === '') return false;
  const code = ch.charCodeAt(0);
  if (code < 128) return ASCII_PUNCT.indexOf(ch) !== -1;
  return PUNCT_RE.test(ch);
}
function isWordChar(ch) {
  if (ch === undefined || ch === '') return false;
  const code = ch.charCodeAt(0);
  if (code < 128) return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || ch === '_';
  return !isSpace(ch) && !isPunctChar(ch);
}
function isBlankLine(line) { return /^[ \t]*$/.test(line); }

// A whitespace-only line counts as blank only when a newline follows
// it; at the very end of the text (no trailing newline) it is ordinary
// continuation text. An empty line is always blank: it contributes
// nothing to the text either way.
function isBlankAt(lines, i, end, endsNL) {
  return isBlankLine(lines[i]) && (i + 1 < end || endsNL || lines[i] === '');
}

// Visual column of the leading indent of `line` (tabs stop every 4),
// and the index of the first character that is not a space or tab.
function lineIndent(line) {
  let cols = 0;
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { cols++; i++; }
    else if (c === 9) { cols += 4 - (cols % 4); i++; }
    else break;
  }
  return { cols, idx: i };
}

// Remove `n` visual columns from the start of `line`; a tab that
// straddles the boundary leaves the right number of spaces behind.
function stripCols(line, n) {
  let cols = 0;
  let i = 0;
  const len = line.length;
  while (i < len && cols < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { cols++; i++; }
    else if (c === 9) {
      const w = 4 - (cols % 4);
      if (cols + w > n) return ' '.repeat(cols + w - n) + line.slice(i + 1);
      cols += w; i++;
    } else break;
  }
  return line.slice(i);
}

// Expand every tab in `line` to spaces, tracking the column from
// `startCol` (tabs advance to the next multiple of four).
function expandTabs(line, startCol) {
  if (line.indexOf('\t') === -1) return line;
  let col = startCol;
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
    } else { out += ch; col++; }
  }
  return out;
}

// Expand tabs in the leading whitespace run of `line` only, from column 0.
function expandLeadingTabs(line) {
  if (line.indexOf('\t') === -1) return line;
  let i = 0;
  let col = 0;
  let out = '';
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') { out += ' '; col++; i++; }
    else { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
  }
  return out + line.slice(i);
}

// Trim trailing blank lines the way marked's `ge` helper does: keep the
// text as-is when at most one blank line trails, otherwise cut back to
// the last non-blank line (without a trailing newline).
function trimTrailingBlanks(text) {
  const parts = text.split('\n');
  let t = parts.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(parts[t])) t--;
  if (parts.length - t <= 2) return text;
  return parts.slice(0, t + 1).join('\n');
}

// Strip up to `n` leading spaces from every line of `text` (the indent
// compensation marked applies to fenced code whose fence is indented).
function dedentLines(text, n) {
  if (n <= 0) return text;
  return text.split('\n').map((l) => {
    let i = 0;
    while (i < l.length && i < n && l[i] === ' ') i++;
    return l.slice(i);
  }).join('\n');
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));
const PRE_TAGS = new Set(['pre', 'script', 'style', 'textarea']);

// A tag name starting at `s[i]` (`<` already consumed): letters, digits,
// hyphens. Returns the name in lower case, or '' when there is none.
function tagNameAt(s, i) {
  let j = i;
  const n = s.length;
  if (j >= n || !/[A-Za-z]/.test(s[j])) return '';
  j++;
  while (j < n && /[A-Za-z0-9-]/.test(s[j])) j++;
  return s.slice(i, j).toLowerCase();
}

// Try to match an inline HTML tag starting at position `i` of `s`
// (s[i] === '<'). Returns the raw tag text, or null. Covers comments,
// processing instructions, declarations, CDATA, open and close tags.
function matchInlineTag(s, i) {
  const n = s.length;
  if (s.startsWith('<!--', i)) {
    // Short comments `<!-->` and `<!--->` end right here.
    if (s[i + 4] === '>') return s.slice(i, i + 5);
    if (s[i + 4] === '-' && s[i + 5] === '>') return s.slice(i, i + 6);
    const end = s.indexOf('-->', i + 4);
    return end === -1 ? s.slice(i) : s.slice(i, end + 3);
  }
  if (s.startsWith('<?', i)) {
    const end = s.indexOf('?>', i + 2);
    return end === -1 ? null : s.slice(i, end + 2);
  }
  if (s.startsWith('<![CDATA[', i)) {
    const end = s.indexOf(']]>', i + 9);
    return end === -1 ? null : s.slice(i, end + 3);
  }
  if (s.startsWith('<!', i) && i + 2 < n && /[A-Za-z]/.test(s[i + 2])) {
    // A declaration needs whitespace after its name, then anything up
    // to the next `>`.
    let j = i + 2;
    while (j < n && /[A-Za-z]/.test(s[j])) j++;
    if (j >= n || !isSpace(s[j])) return null;
    const end = s.indexOf('>', j);
    return end === -1 ? null : s.slice(i, end + 1);
  }
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  const name = tagNameAt(s, j);
  if (!name) return null;
  j += name.length;
  if (closing) {
    while (j < n && isSpace(s[j])) j++;
    if (j < n && s[j] === '>') return s.slice(i, j + 1);
    return null;
  }
  // Open tag: after the name must come whitespace, `>` or `/>`, then
  // attributes (each starting with whitespace), so a `<` followed by
  // something like `https:` is not a tag at all.
  while (j < n) {
    const c = s[j];
    if (c === '>') return s.slice(i, j + 1);
    if (c === '/' && s[j + 1] === '>') return s.slice(i, j + 2);
    if (!isSpace(c)) return null;
    while (j < n && isSpace(s[j])) j++;
    if (j < n && s[j] === '>') return s.slice(i, j + 1);
    if (j < n && s[j] === '/' && s[j + 1] === '>') return s.slice(i, j + 2);
    // Attribute name.
    if (j >= n) return null;
    const a0 = s[j];
    if (!/[A-Za-z_:]/.test(a0)) return null;
    j++;
    while (j < n && /[\w.:-]/.test(s[j])) j++;
    // Whitespace after the name belongs to the next attribute unless
    // an `=` follows it.
    const afterName = j;
    while (j < n && isSpace(s[j])) j++;
    if (s[j] === '=') {
      j++;
      while (j < n && isSpace(s[j])) j++;
      if (s[j] === '"' || s[j] === "'") {
        const q = s[j];
        j++;
        while (j < n && s[j] !== q) j++;
        if (j >= n) return null;
        j++;
      } else {
        const v0 = j;
        while (j < n) {
          const d = s[j];
          if (isSpace(d) || d === '"' || d === "'" || d === '=' || d === '<' || d === '>' || d === '`') break;
          j++;
        }
        if (j === v0) return null;
      }
    } else {
      j = afterName;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// Unescape backslash-punctuation (`\*` -> `*`) in link destinations,
// titles and fenced-code info strings.
function unescapePunct(s) {
  return s.replace(/\\([\p{P}\p{S}])/gu, '$1');
}

// Unicode whitespace (marked's flanking test uses \s, which covers
// non-breaking spaces and the other Unicode space characters).
function isUniSpace(ch) {
  return ch === '' || /\s/.test(ch);
}

function flanking(prev, next) {
  const prevWs = prev === '' || isUniSpace(prev);
  const nextWs = next === '' || isUniSpace(next);
  const prevP = isPunctChar(prev);
  const nextP = isPunctChar(next);
  const left = !nextWs && (!nextP || prevWs || prevP);
  const right = !prevWs && (!prevP || nextWs || nextP);
  return { left, right };
}

// Find a code span closing run for the run of backticks starting at `i`.
// Returns {text, end} (end just past the closing run) or null.
function findCodeSpan(s, i) {
  const n = s.length;
  let k = 0;
  while (i + k < n && s[i + k] === '`') k++;
  let j = i + k;
  while (j < n) {
    if (s[j] === '`') {
      let m = 0;
      while (j + m < n && s[j + m] === '`') m++;
      if (m === k && s[j - 1] !== '`' && s[i + k] !== '`') {
        let text = s.slice(i + k, j).replace(/\n/g, ' ');
        if (text.length > 0 && /[^ ]/.test(text) && text[0] === ' ' && text[text.length - 1] === ' ') {
          text = text.slice(1, -1);
        }
        return { text, end: j + m };
      }
      j += m;
    } else j++;
  }
  return null;
}

// Parse a bracketed label starting at `i` (s[i] === '['). Handles nested
// brackets and code spans. Returns {label, end} or null.
// Skip a code span inside a link label, following marked's label
// pattern: a backtick run, non-backtick content, a backtick run (the
// two runs need not have the same length). Returns the index just past
// the closing run, or -1 when there is no closing run.
function skipLabelCodeSpan(s, j) {
  const n = s.length;
  let k = 0;
  while (j + k < n && s[j + k] === '`') k++;
  let m = j + k;
  while (m < n) {
    if (s[m] === '`') {
      let l = 0;
      while (m + l < n && s[m + l] === '`') l++;
      return m + l;
    }
    m++;
  }
  return -1;
}

function parseBracket(s, i) {
  const n = s.length;
  let depth = 1;
  let j = i + 1;
  while (j < n) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') {
      // A code span in a label needs a closing run (the two runs need
      // not match in length); without one, a run right before `]`
      // still belongs to the label, and anything else ends the label
      // (and so the link) here.
      const end = skipLabelCodeSpan(s, j);
      if (end !== -1) { j = end; continue; }
      let k = 0;
      while (j + k < n && s[j + k] === '`') k++;
      if (s[j + k] === ']') { j += k; continue; }
      return null;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return { label: s.slice(i + 1, j), end: j + 1 };
    }
    j++;
  }
  return null;
}

// The guard marked applies to link text: a raw `<` in the label that
// starts a tag or autolink running past the end of the label kills the
// link. `full` is the source from the link start, `labelOff` the offset
// of the label inside it, `label` the label text.
function linkTextHasRunawayTag(full, labelOff, label) {
  const n = label.length;
  for (let s = 0; s < n; s++) {
    const c = label[s];
    if (c === '\\') { s++; continue; }
    if (c === '`') {
      const cs = findCodeSpan(label, s);
      if (cs) { s = cs.end - 1; continue; }
      continue;
    }
    if (c !== '<') continue;
    const rest = full.slice(labelOff + s);
    const tag = matchInlineTag(rest, 0) || matchAutolink(rest, 0);
    if (tag && tag.length > n - s) return true;
    if (tag) s += tag.length - 1;
  }
  return false;
}

// Match `<scheme:...>` or `<user@host>` starting at `i` (s[i] === '<').
// Returns the raw matched text (including brackets) or null.
function matchAutolink(s, i) {
  const n = s.length;
  if (s[i] !== '<') return null;
  let j = i + 1;
  const emailRe = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+(?![-_])/;
  const em = emailRe.exec(s.slice(j));
  if (em) {
    const end = j + em[0].length;
    if (end < n && s[end] === '>') return s.slice(i, end + 1);
  }
  const scRe = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*/;
  const sm = scRe.exec(s.slice(j));
  if (sm) {
    const end = j + sm[0].length;
    if (end < n && s[end] === '>') return s.slice(i, end + 1);
  }
  return null;
}

// Parse an inline link or image starting at `i` (s[i] is '[' or '!').
// Returns {atom, end} or null. `st` is the shared inline state.
function tryLink(s, i, st) {
  const isImage = s[i] === '!';
  let p = isImage ? i + 1 : i;
  if (s[p] !== '[') return null;
  const br = parseBracket(s, p);
  if (!br) return null;
  const label = br.label;
  let j = br.end;
  let href = null;
  let title = null;
  let rawEnd = -1;
  if (s[j] === '(') {
    // Inline link: ( dest title? ). When it fails to parse, the
    // shortcut reference form for the same label is tried instead.
    let ok = true;
    let k = j + 1;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    let dest = '';
    if (s[k] === '<') {
      let m = k + 1;
      let closed = -1;
      while (m < s.length) {
        if (s[m] === '\\') { m += 2; continue; }
        if (s[m] === '\n') break;
        if (s[m] === '>') { closed = m; break; }
        m++;
      }
      if (closed === -1) ok = false;
      let bs = 0;
      if (ok) {
        for (let t = closed - 1; t >= k + 1 && s[t] === '\\'; t--) bs++;
        if (bs % 2 === 1) ok = false;
      }
      if (ok) {
        dest = s.slice(k + 1, closed);
        k = closed + 1;
      }
    } else {
      const start = k;
      let depth = 0;
      while (k < s.length) {
        const c = s[k];
        if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 0x20) break;
        if (c === '\\') { k += 2; continue; }
        if (c === '(') depth++;
        else if (c === ')') {
          if (depth === 0) break;
          depth--;
        }
        k++;
      }
      if (depth > 0) ok = false;
      dest = s.slice(start, k);
    }
    // Optional title.
    let afterDest = k;
    if (ok) {
      let tp = k;
      if (s[tp] === ' ' || s[tp] === '\t' || s[tp] === '\n') {
        let q = tp;
        if (s[q] === ' ' || s[q] === '\t') {
          while (s[q] === ' ' || s[q] === '\t') q++;
          if (s[q] === '\n') { q++; while (s[q] === ' ' || s[q] === '\t') q++; }
        } else {
          q++;
          while (s[q] === ' ' || s[q] === '\t') q++;
        }
        const qc = s[q];
        if (qc === '"' || qc === "'" || qc === '(') {
          const close = qc === '(' ? ')' : qc;
          let m = q + 1;
          let okT = false;
          while (m < s.length) {
            if (s[m] === '\\') { m += 2; continue; }
            if (s[m] === close) { okT = true; break; }
            if (qc === "'" && s[m] === '\n') {
              let r = m + 1;
              while (r < s.length && (s[r] === ' ' || s[r] === '\t')) r++;
              if (s[r] === '\n' || r >= s.length) break;
            }
            m++;
          }
          if (okT) {
            title = unescapePunct(s.slice(q + 1, m));
            afterDest = m + 1;
          }
        }
      }
    }
    if (ok) {
      let e = afterDest;
      while (e < s.length && (s[e] === ' ' || s[e] === '\t' || s[e] === '\n')) e++;
      if (s[e] !== ')') ok = false;
      let bs = 0;
      if (ok) {
        for (let t = e - 1; t > j && s[t] === '\\'; t--) bs++;
        if (bs % 2 === 1) ok = false;
      }
      if (ok) rawEnd = e + 1;
    }
    if (ok) {
      href = unescapePunct(dest);
    } else {
      // Inline parse failed: fall back to the shortcut reference.
      const def = st.links[normLabel(label)];
      if (!def) return null;
      href = def.href;
      title = def.title;
      rawEnd = j;
    }
  } else if (s[j] === '[') {
    // Full reference link [label][ref]. When the reference is
    // undefined, the whole construct stays literal: there is no
    // fallback to the shortcut form for the same opening bracket.
    const rb = parseBracket(s, j);
    if (!rb) return null;
    const ref = rb.label === '' ? label : rb.label;
    const def = st.links[normLabel(ref)];
    if (!def) return null;
    href = def.href;
    title = def.title;
    rawEnd = rb.end;
  } else {
    // Shortcut reference link [label].
    const def = st.links[normLabel(label)];
    if (!def) return null;
    href = def.href;
    title = def.title;
    rawEnd = j;
  }
  if (linkTextHasRunawayTag(s.slice(i), isImage ? 2 : 1, label)) return null;
  // Parse the label's inline content, tracking nested links the way
  // marked's link builder does.
  const savedInLink = st.inLink;
  const savedEmitted = st.linkEmitted;
  const savedRawBlock = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const labelAtoms = parseInlineAtoms(label, st);
  const nestedLink = st.linkEmitted;
  st.inLink = savedInLink;
  st.linkEmitted = savedEmitted;
  if (!isImage) {
    if (nestedLink) {
      st.inRawBlock = savedRawBlock;
      return null;
    }
    st.linkEmitted = true;
  }
  const atom = isImage
    ? { k: 'i', href, title, label: labelAtoms, labelText: label }
    : { k: 'l', href, title, label: labelAtoms, labelText: label, auto: false };
  return { atom, end: rawEnd };
}

// Trim a candidate extended autolink the way marked's backpedal does:
// keep the longest prefix made of non-punctuation runs, balanced
// parenthesised groups, `&` not starting an entity, and punctuation
// runs that are not at the very end; repeat until the prefix is
// stable. This is what cuts a URL off before an unmatched `(`.
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![A-Za-z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function backpedalUrl(m) {
  let r;
  do {
    r = m;
    const hit = BACKPEDAL_RE.exec(m);
    m = hit ? hit[0] : '';
  } while (r !== m);
  return m;
}

const EMAIL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?![\w-])/;
const EMAIL_RE_NOLOOK = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+/;
const EMAIL_LOCAL = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/;

// Try to match an extended autolink (www., scheme://, email, mailto:,
// xmpp:) starting at `i`. Returns {atom, end} or null.
function tryUrl(s, i, st, atoms, masked) {
  if (st.inLink) return null;
  const rest = s.slice(i);
  const protoRe = /^(?:mailto|xmpp):[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?:\/[A-Za-z0-9@.]+)?(?![\w-])/;
  let m = protoRe.exec(rest);
  if (m) {
    const text = m[0];
    return { atom: { k: 'l', href: text, title: null, label: null, labelText: text, auto: true }, end: i + text.length };
  }
  if (rest.startsWith('www.')) {
    const prev = i === 0 ? '' : s[i - 1];
    if (prev === '' || isSpace(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(') {
      const dm = /^(?:www\.)(?:[A-Za-z0-9-]+\.?)+[^\s<]*/.exec(rest);
      if (dm) {
        const text = backpedalUrl(dm[0]);
        if (text.length > 4) {
          return { atom: { k: 'l', href: 'http://' + text, title: null, label: null, labelText: text, auto: true }, end: i + text.length };
        }
      }
    }
  }
  const sc = /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/(?:[A-Za-z0-9-]+\.?)+[^\s<]*/.exec(rest);
  if (sc) {
    const text = backpedalUrl(sc[0]);
    return { atom: { k: 'l', href: text, title: null, label: null, labelText: text, auto: true }, end: i + text.length };
  }
  const prev = i === 0 ? '' : s[i - 1];
  if (EMAIL_LOCAL.test(s[i]) && (prev === '' || !EMAIL_LOCAL.test(prev))) {
    const em = EMAIL_RE.exec(rest);
    // The lookahead can cut the domain short only because the email
    // is followed by `_` — which is exactly what an emphasis closer
    // looks like. Marked matches the email after the strong is
    // formed, so the closer is already consumed there. Accept the
    // longer match only when that `_` run really is the closer of an
    // unmatched `_` opener: build a synthetic closer atom for the run
    // and ask the closer scan whether any earlier opener pairs with
    // it. That keeps `__a __b__ c@x.com__` (opener already paired)
    // literal while `__a _b_ c@x.com__` (debt swallows the middle
    // closer) still matches the email.
    if (atoms) {
      const em2 = EMAIL_RE_NOLOOK.exec(rest);
      if (em2 && (!em || em2[0].length > em[0].length)) {
        const end2 = i + em2[0].length;
        let j = end2;
        while (j < s.length && s[j] === '_') j++;
        if (j > end2) {
          const p2 = s[end2 - 1];
          const n2 = j >= s.length ? '' : s[j];
          const fl = flanking(p2, n2);
          const synClose = fl.right && (!fl.left || isPunctChar(n2));
          if (synClose) {
            const syn = { k: 'd', ch: '_', len: j - end2, y: j - end2, o: false,
              open: fl.left && (!fl.right || isPunctChar(p2)), close: synClose,
              masked: masked !== null && masked.slice(end2, j) !== s.slice(end2, j) };
            const cand = atoms.concat([syn]);
            for (let oi = atoms.length - 1; oi >= 0; oi--) {
              const a = atoms[oi];
              if (a.k !== 'd' || a.ch !== '_' || !a.open) continue;
              const hit = findDelimClose(cand, oi);
              if (hit && hit.cIdx === atoms.length) {
                const text = em2[0];
                return { atom: { k: 'l', href: 'mailto:' + text, title: null, label: null, labelText: text, auto: true }, end: end2 };
              }
            }
          }
        }
      }
    }
    if (em) {
      const text = em[0];
      return { atom: { k: 'l', href: 'mailto:' + text, title: null, label: null, labelText: text, auto: true }, end: i + text.length };
    }
  }
  return null;
}

// Render the plain text of a link label (image alt text): formatting is
// stripped, code spans keep their text, line breaks vanish.
function plainText(atoms) {
  let out = '';
  for (const a of atoms) {
    switch (a.k) {
      case 't': out += decodeNumeric(a.s); break;
      case 'e': out += a.s; break;
      case 'c': out += a.s; break;
      case 'h': out += a.s; break;
      case 'b': break;
      case 'l': case 'i': out += a.label ? plainText(a.label) : a.labelText; break;
      case 'd': out += a.ch.repeat(a.len); break;
      case 'em': case 'strong': case 'del': out += plainText(a.children); break;
      default: break;
    }
  }
  return out;
}

function renderLinkAtom(a) {
  const url = cleanUrl(a.href);
  if (a.auto) {
    const display = escText(a.labelText, true);
    if (url === null) return display;
    return '<a href="' + escText(url, true) + '">' + display + '</a>';
  }
  const inner = renderAtoms(a.label);
  if (url === null) return inner;
  let out = '<a href="' + escText(url, false) + '"';
  if (a.title) out += ' title="' + escText(a.title, false) + '"';
  return out + '>' + inner + '</a>';
}

function renderImageAtom(a) {
  const alt = escText(plainText(a.label), false);
  const url = cleanUrl(a.href);
  if (url === null) return alt;
  let out = '<img src="' + escText(url, false) + '" alt="' + alt + '"';
  if (a.title) out += ' title="' + escText(a.title, false) + '"';
  return out + '>';
}

function renderAtoms(atoms) {
  let out = '';
  for (const a of atoms) {
    switch (a.k) {
      case 't': out += a.raw ? a.s : escText(decodeNumeric(a.s), false); break;
      case 'e': out += escText(a.s, false); break;
      case 'c': out += '<code>' + escText(a.s, true) + '</code>'; break;
      case 'b': out += '<br>'; break;
      case 'h': out += a.s; break;
      case 'l': out += renderLinkAtom(a); break;
      case 'i': out += renderImageAtom(a); break;
      case 'd': out += a.ch.repeat(a.len); break;
      case 'em': out += '<em>' + renderAtoms(a.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderAtoms(a.children) + '</strong>'; break;
      case 'del': out += '<del>' + renderAtoms(a.children) + '</del>'; break;
      default: break;
    }
  }
  return out;
}

// Resolve emphasis/strikethrough delimiter runs with a forward scan,
// the way marked does it: for each opener, scan forward for a usable
// closer. An open-only closer cannot close but adds its length to the
// debt; a closer that can also open is blocked by the rule of three
// (and when the opener can also close, the rule applies to close-only
// closers too); a close-only closer is otherwise always usable. A
// usable closer first pays off the debt; only then does it match, with
// an effective length shortened by what the debt consumed. The number
// of delimiters used decides em (odd) or strong (even); the unused
// delimiters land inside the node and are resolved recursively, and any
// closer delimiters beyond the effective length stay after the node.
// A strikethrough closer must have the same length as its opener, and
// has no rule of three. When an opener finds no closer, its first
// delimiter becomes literal text and the rest of the run is tried
// again as a fresh opener (a tilde run is swallowed whole as text, so
// it is never retried). A lone `*` (or `_`) sitting inside a `__...__`
// (or `**...**`) region at the start of the search is skipped outright.
function findDelimClose(atoms, opIdx) {
  const a = atoms[opIdx];
  const k = a.len;
  const y = a.y;
  const o = a.o;
  let m = k;
  let f = 0;
  const R = a.close;
  // Skip a lone delimiter inside the opposite pair at the start of
  // the search: `__ * __` for `*`, `** _ **` for `_`.
  let skipIdx = -1;
  {
    const other = a.ch === '*' ? '_' : '*';
    const ds = [];
    for (let j = opIdx + 1; j < atoms.length && ds.length < 3; j++) {
      if (atoms[j].k === 'd') ds.push(j);
    }
    if (ds.length === 3
      && atoms[ds[0]].ch === other && atoms[ds[0]].len === 2
      && atoms[ds[1]].ch === a.ch && atoms[ds[1]].len === 1
      && atoms[ds[2]].ch === other && atoms[ds[2]].len >= 2) {
      skipIdx = ds[1];
    }
  }
  for (let cIdx = opIdx + 1; cIdx < atoms.length; cIdx++) {
    const b = atoms[cIdx];
    if (b.k !== 'd' || b.ch !== a.ch) continue;
    if (cIdx === skipIdx) continue;
    // A masked run cannot close: the closer search runs on the masked
    // text, where it is hidden inside a placeholder.
    if (b.masked) continue;
    const bl = b.len;
    if (a.ch === '~') {
      // A strikethrough closer must have the same length as its
      // opener, and a run of a different length is skipped outright —
      // it does not add to the debt the way an open-only run does
      // for `*` and `_`.
      if (bl !== k) continue;
      if (!b.close) { if (b.open) m += bl; continue; }
    } else {
      if (!b.close) {
        // Open-only: it cannot close, but its length adds to the debt.
        if (b.open) m += bl;
        continue;
      }
      const both = b.open;
      if (both || R) {
        // The scan stops outright when the opener is preceded by the
        // same delimiter and the closer can also open.
        if (o && both) return null;
        if (y % 3 !== 0 && (y + bl) % 3 === 0) { f += bl; continue; }
      }
    }
    m -= bl;
    if (m > 0) continue;
    const bEff = Math.min(bl, bl + m + f);
    return { cIdx, bEff, use: Math.min(k, bEff) };
  }
  return null;
}

function resolveDelims(atoms) {
  let idx = 0;
  while (idx < atoms.length) {
    const a = atoms[idx];
    if (a.k !== 'd' || !a.open) { idx++; continue; }
    const hit = findDelimClose(atoms, idx);
    if (!hit) {
      // No closer: the first delimiter becomes literal text and the
      // rest of the run is tried again as a fresh opener. A tilde run
      // is swallowed whole as text, so it is never retried.
      if (a.ch === '~' || a.len === 1) {
        atoms[idx] = { k: 't', s: a.ch.repeat(a.len), raw: false };
        idx++;
      } else {
        atoms.splice(idx, 1,
          { k: 't', s: a.ch, raw: false },
          { k: 'd', ch: a.ch, len: a.len - 1, y: a.y, o: true, open: a.open, close: a.close, masked: a.masked });
        idx++;
      }
      continue;
    }
    const { cIdx, bEff, use } = hit;
    const closer = atoms[cIdx];
    const middle = atoms.slice(idx + 1, cIdx);
    let node;
    let after = null;
    if (closer.len > bEff) {
      after = { k: 'd', ch: a.ch, len: closer.len - bEff, y: closer.len - bEff, o: true, open: closer.open, close: closer.close, masked: closer.masked };
    }
    if (a.ch === '~') {
      node = { k: 'del', children: resolveDelims(middle) };
    } else {
      const n = use % 2 === 1 ? 1 : 2;
      const children = [];
      if (a.len > n) children.push({ k: 'd', ch: a.ch, len: a.len - n, y: a.len - n, o: false, open: a.open, close: a.close, masked: a.masked });
      children.push(...middle);
      if (bEff > n) children.push({ k: 'd', ch: a.ch, len: bEff - n, y: bEff - n, o: false, open: closer.open, close: closer.close, masked: closer.masked });
      node = { k: use % 2 === 1 ? 'em' : 'strong', children: resolveDelims(children) };
    }
    const repl = [node];
    if (after) repl.push(after);
    atoms.splice(idx, cIdx - idx + 1, ...repl);
    idx = idx + 1;
  }
  return atoms;
}

// The masking marked applies before the emphasis closer search:
// code spans, links and tags are replaced by same-length placeholders,
// so a delimiter inside one cannot close an emphasis opened outside
// it. A "code span" here may start at any backtick run — even one
// inside a link label that never forms a real code span — so it can
// swallow a closer that sits after the link. The masked text keeps
// the original length, so positions still line up.
const MASK_ANY_PUNCT_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MASK_BLOCK_SKIP_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
function maskInlineText(s) {
  const t = s.replace(MASK_ANY_PUNCT_RE,
    (m, g1, g2) => g2 ? '+'.repeat(m.length) : g1 ? g1 + m.slice(g1.length, -g1.length).replace(/`/g, '+') + g1 : m);
  return t.replace(MASK_BLOCK_SKIP_RE,
    (m, g1, g2) => { const o = g2 ? g2.length : 0; return m.slice(0, o) + '[' + 'a'.repeat(m.length - o - 2) + ']'; });
}

// Tokenise one inline string into atoms (no rendering yet).
function parseInlineAtoms(s, st) {
  const atoms = [];
  const n = s.length;
  let i = 0;
  let buf = '';
  let bufRaw = false;
  // A delimiter run is masked when the masking above replaced it: it
  // cannot close an emphasis, though it can still open one. Only
  // worth computing when a backtick could start a masking span.
  const masked = (s.includes('`') && (s.includes('*') || s.includes('_') || s.includes('~'))) ? maskInlineText(s) : null;
  const flush = () => {
    if (buf !== '') { atoms.push({ k: 't', s: buf, raw: bufRaw }); buf = ''; }
  };
  const pushAtom = (a) => { flush(); atoms.push(a); };
  while (i < n) {
    const c = s[i];
    // Hard break: two or more spaces, or a backslash, before a newline,
    // unless nothing but whitespace follows.
    if (c === ' ' || c === '\\') {
      let isBr = false;
      let brEnd = -1;
      if (c === ' ') {
        let j = i;
        while (j < n && s[j] === ' ') j++;
        if (j - i >= 2 && s[j] === '\n') { isBr = true; brEnd = j + 1; }
      } else if (s[i + 1] === '\n') { isBr = true; brEnd = i + 2; }
      if (isBr) {
        let rest = s.slice(brEnd);
        let k = 0;
        while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) k++;
        if (rest.slice(k).trim() !== '') {
          while (brEnd < n && (s[brEnd] === ' ' || s[brEnd] === '\t')) brEnd++;
          pushAtom({ k: 'b' });
          i = brEnd;
          continue;
        }
      }
      if (c === '\\' && i + 1 < n && ASCII_PUNCT.indexOf(s[i + 1]) !== -1) {
        pushAtom({ k: 'e', s: s[i + 1] });
        i += 2;
        continue;
      }
      buf += c; bufRaw = st.inRawBlock; i++;
      continue;
    }
    if (c === '`') {
      const cs = findCodeSpan(s, i);
      if (cs) { pushAtom({ k: 'c', s: cs.text }); i = cs.end; continue; }
      // A failed code span swallows the whole backtick run as literal
      // text (marked's text token starts with the full run); the next
      // attempt is only at the next special character.
      let j = i;
      while (j < n && s[j] === '`') j++;
      buf += s.slice(i, j); bufRaw = st.inRawBlock; i = j;
      continue;
    }
    if (c === '<') {
      const tag = matchInlineTag(s, i);
      if (tag) {
        if (!st.inLink && /^<a /i.test(tag)) st.inLink = true;
        else if (st.inLink && /^<\/a>/i.test(tag)) st.inLink = false;
        if (!st.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(tag)) st.inRawBlock = true;
        else if (st.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(tag)) st.inRawBlock = false;
        pushAtom({ k: 'h', s: tag });
        i += tag.length;
        continue;
      }
      const auto = matchAutolink(s, i);
      if (auto) {
        const inner = auto.slice(1, -1);
        const isEmail = inner.indexOf(':') === -1;
        pushAtom({ k: 'l', href: isEmail ? 'mailto:' + inner : inner, title: null, label: null, labelText: inner, auto: true });
        i += auto.length;
        continue;
      }
      buf += c; bufRaw = st.inRawBlock; i++;
      continue;
    }
    if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const hit = tryLink(s, i, st);
      if (hit) { pushAtom(hit.atom); i = hit.end; continue; }
      buf += c; bufRaw = st.inRawBlock; i++;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < n && s[j] === c) j++;
      const len = j - i;
      if (c === '~' && len > 2) { buf += s.slice(i, j); bufRaw = st.inRawBlock; i = j; continue; }
      // An escape right before the run is `+` in the masked text
      // marked runs its flanking on, not the escaped character: a
      // `\~` before a `~~` run must not count as "preceded by `~`".
      let prev = i === 0 ? '' : s[i - 1];
      if (buf === '' && atoms.length > 0 && atoms[atoms.length - 1].k === 'e') prev = '+';
      const next = j >= n ? '' : s[j];
      const { left, right } = flanking(prev, next);
      let open = false, close = false;
      if (c === '*') { open = left; close = right; }
      else if (c === '_') {
        open = left && (!right || isPunctChar(prev));
        close = right && (!left || isPunctChar(next));
      } else {
        open = next !== '' && !isSpace(next) && next !== '~';
        close = prev !== '' && !isSpace(prev) && prev !== '~';
      }
      // y is the total run length (kept across split retries); o says
      // the character before this run is the same delimiter.
      const isMasked = masked !== null && masked.slice(i, j) !== s.slice(i, j);
      pushAtom({ k: 'd', ch: c, len, y: len, o: false, open, close, masked: isMasked });
      i = j;
      continue;
    }
    // Extended autolinks (www., scheme://, email) — only outside links.
    if (!st.inLink && (c === 'w' || c === 'h' || c === 'H' || c === 'f' || c === 'F' || EMAIL_LOCAL.test(c))) {
      const hit = tryUrl(s, i, st, atoms, masked);
      if (hit) { pushAtom(hit.atom); i = hit.end; continue; }
    }
    buf += c; bufRaw = st.inRawBlock; i++;
  }
  flush();
  return resolveDelims(atoms);
}

// Render one inline string to HTML.
function inlineHtml(src, st) {
  st.inRawBlock = false;
  const atoms = parseInlineAtoms(src, st);
  return renderAtoms(atoms);
}

// ---------------------------------------------------------------------------
// Block parsing
//
// Nodes: {k:'para'|'text', x} paragraph or bare text, {k:'head', d, x},
// {k:'hr'}, {k:'code', x, lang}, {k:'html', x}, {k:'quote', c, src},
// {k:'list', o, s, l, i, src}, {k:'table', h, a, r}.
// The lexer works on lines (the source split on '\n', with the final
// empty piece of a trailing newline dropped); `endsNL` says whether the
// source ended with a newline, which decides trailing newlines in raw
// code and HTML block text.
// ---------------------------------------------------------------------------

// Rebuild the raw source text of lines[i..k): the lines joined by '\n',
// plus a trailing newline when another line follows or the source ended
// with one.
function rawText(lines, i, k, endsNL) {
  let t = lines.slice(i, k).join('\n');
  if (k < lines.length || endsNL) t += '\n';
  return t;
}

// Index of the first character of `s` that is not a space, or -1.
function firstNonSpaceIdx(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ') i++;
  return i < s.length ? i : -1;
}

// Count leading spaces (characters, not columns) of `s`.
function leadingSpaces(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ') i++;
  return i;
}

// ATX heading depth of `s` (content after at most 3 spaces of indent),
// or 0 when `s` does not start a heading.
function atxDepth(s) {
  let d = 0;
  while (d < s.length && s[d] === '#') d++;
  if (d === 0 || d > 6) return 0;
  if (d >= s.length) return d;
  const c = s[d];
  return (c === ' ' || c === '\t') ? d : 0;
}

// Is `s` (content after at most 3 spaces of indent) a thematic break?
function isHrText(s) {
  if (s.length < 3) return false;
  const m = s[0];
  if (m !== '-' && m !== '_' && m !== '*') return false;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === m) n++;
    else if (c !== ' ' && c !== '\t') return false;
  }
  return n >= 3;
}

// Setext underline depth of `s` (content after at most 3 spaces of
// indent): 1 for `=`, 2 for `-`, 0 otherwise.
function setextDepth(s) {
  if (!s) return 0;
  const m = s[0];
  if (m !== '=' && m !== '-') return 0;
  let i = 0;
  while (i < s.length && s[i] === m) i++;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return i === s.length ? (m === '=' ? 1 : 2) : 0;
}

// Fence opening in `s` (content after at most 3 spaces of indent).
// Returns {ch, len, info} or null; a backtick fence whose info string
// contains a backtick is not a fence.
function fenceStart(s) {
  if (s.length < 3) return null;
  const ch = s[0];
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (len < s.length && s[len] === ch) len++;
  if (len < 3) return null;
  const info = s.slice(len);
  if (ch === '`' && info.indexOf('`') !== -1) return null;
  return { ch, len, info };
}

// Is `s` a closing fence for a fence of `ch` opened with `len` runs?
function isFenceClose(s, ch, len) {
  let n = 0;
  while (n < s.length && s[n] === ch) n++;
  if (n < len) return false;
  for (let i = n; i < s.length; i++) if (s[i] !== ' ' && s[i] !== '\t') return false;
  return true;
}

// A list marker at the start of `s` (content after at most 3 spaces of
// indent). Returns {ordered, delim, num, markerLen} or null. The marker
// must be followed by a space, a tab, or the end of the line.
function listMarker(s) {
  const c = s[0];
  if (c === '*' || c === '+' || c === '-') {
    if (s.length === 1) return { ordered: false, delim: c, num: 0, markerLen: 1 };
    const n = s[1];
    if (n === ' ' || n === '\t') return { ordered: false, delim: c, num: 0, markerLen: 1 };
    return null;
  }
  if (c >= '0' && c <= '9') {
    let i = 0;
    while (i < s.length && s[i] >= '0' && s[i] <= '9') i++;
    if (i === 0 || i > 9) return null;
    if (i >= s.length) return null;
    const d = s[i];
    if (d !== '.' && d !== ')') return null;
    const num = +s.slice(0, i);
    if (i + 1 >= s.length) return { ordered: true, delim: d, num, markerLen: i + 1 };
    const n = s[i + 1];
    if (n === ' ' || n === '\t') return { ordered: true, delim: d, num, markerLen: i + 1 };
    return null;
  }
  return null;
}

// Does a list marker at the start of `line` interrupt a paragraph?
// Only bullets, and ordered markers starting at 1, with real content
// after the marker, interrupt one.
function isListInterruptPara(line) {
  const { cols, idx } = lineIndent(line);
  if (cols > 3) return false;
  const mk = listMarker(line.slice(idx));
  if (!mk) return false;
  if (mk.ordered && mk.num !== 1) return false;
  const rest = line.slice(idx + mk.markerLen);
  let i = 0;
  while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) i++;
  return i > 0 && i < rest.length;
}

// A tag name at `s[i]` where s[i] is '<'. Returns
// {name, closing, end} (end just past the name) or null.
function tagNameOf(s, i) {
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (j >= s.length) return null;
  const c = s[j];
  if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'))) return null;
  const ns = j;
  j++;
  while (j < s.length) {
    const d = s[j];
    if ((d >= 'A' && d <= 'Z') || (d >= 'a' && d <= 'z') || (d >= '0' && d <= '9') || d === '-') j++;
    else break;
  }
  return { name: s.slice(ns, j).toLowerCase(), closing, end: j };
}

// The narrow HTML-block start test marked applies when deciding whether
// a line interrupts a paragraph (or a lazy line, or a list item): block
// tags, script/pre/style/textarea open tags, comments, processing
// instructions, declarations and CDATA.
function isHtmlStartPara(s) {
  if (s.charCodeAt(0) !== 60) return false; // '<'
  if (s.startsWith('<!--') || s.startsWith('<?') || s.startsWith('<![CDATA[')) return true;
  if (s.startsWith('<!') && s.length > 2) {
    const c = s[2];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) return true;
  }
  const t = tagNameOf(s, 0);
  if (!t) return false;
  if (!t.closing && PRE_TAGS.has(t.name)) {
    const c = s[t.end];
    if (c === undefined || c === ' ' || c === '\t' || c === '>') return true;
    return false;
  }
  if (BLOCK_TAGS.has(t.name)) {
    const c = s[t.end];
    if (c === ' ' || c === '\t' || c === undefined || c === '>') return true;
    if (c === '/' && s[t.end + 1] === '>') return true;
    return false;
  }
  return false;
}

// Is `s` a table delimiter row (after at most 3 spaces of indent)?
function isTableDelimLine(s) {
  if (/^(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/.test(s)) {
    return s.indexOf(':') !== -1 || s.indexOf('|') !== -1;
  }
  return false;
}

// Split one table row into cells the way marked's splitter does: split
// on unescaped pipes, drop a leading and a trailing empty cell, trim
// each cell and turn `\|` back into `|`. When `count` is given, pad or
// truncate to that many cells.
function splitTableCells(s, count) {
  let t = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '|') {
      let bs = 0;
      for (let k = i - 1; k >= 0 && s[k] === '\\'; k--) bs++;
      t += (bs % 2 === 1) ? '|' : ' |';
    } else t += c;
  }
  const cells = t.split(' |');
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.length = count;
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Does a table start at lines[i]? Returns {header, align, rowsEnd}
// (rowsEnd is the index just past the last row) or null.
function tableInfo(lines, i, end, endsNL) {
  const hline = lines[i];
  const hi = lineIndent(hline);
  if (hi.cols > 3) return null;
  const htext = hline.slice(hi.idx);
  if (htext.trim() === '') return null;
  if (i + 1 >= end) return null;
  const dline = lines[i + 1];
  const di = lineIndent(dline);
  if (di.cols > 3) return null;
  const d = dline.slice(di.idx);
  if (!isTableDelimLine(d)) return null;
  const header = splitTableCells(htext);
  let dd = d.replace(/^\|/, '').replace(/\|\s*$/, '');
  const delimCells = dd.split('|');
  if (header.length !== delimCells.length) return null;
  const align = delimCells.map((cell) => {
    if (/^ *-+: *$/.test(cell)) return 'right';
    if (/^ *:-+: *$/.test(cell)) return 'center';
    if (/^ *:-+ *$/.test(cell)) return 'left';
    return null;
  });
  let k = i + 2;
  while (k < end) {
    const line = lines[k];
    // A row line ends only on a spaces-only line that a newline
    // follows (the table regex's ` *\n`); a line holding a tab is a
    // row, and trims to an all-empty row.
    if (/^ *$/.test(line) && (k + 1 < end || endsNL)) break;
    const { cols, idx } = lineIndent(line);
    // The `code` exclusion needs a non-newline character after the
    // indent; a tab-only line is a row, not code.
    if (cols >= 4 && line.slice(idx).trim() !== '') break;
    const s = line.slice(idx);
    if (isHrText(s) || atxDepth(s) > 0 || quoteMarker(line) !== null) break;
    if (fenceStart(s)) break;
    if (listMarker(s) && (!listMarker(s).ordered || listMarker(s).num === 1)) break;
    if (isHtmlStartPara(s)) break;
    k++;
  }
  return { header, align, rowsEnd: k };
}

// Strip one blockquote marker level from `line`. Returns the content
// after the marker, or null when the line does not start one. A tab
// after the marker expands to spaces first, then one space is dropped.
function quoteMarker(line) {
  let cols = 0;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') { if (cols >= 3) break; cols++; i++; }
    else break;
  }
  if (line[i] !== '>') return null;
  i++;
  let col = cols + 1;
  let spaces = 0;
  let j = i;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
    if (line[j] === ' ') { spaces++; col++; j++; }
    else { const w = 4 - (col % 4); spaces += w; col += w; j++; }
  }
  if (spaces > 0) spaces -= 1;
  return ' '.repeat(spaces) + line.slice(j);
}

// Scan a complete HTML tag starting at `s[i]` (s[i] === '<'), honouring
// quoted attribute values. Returns the index just past the tag, or -1.
// Attribute names and values follow the shape marked accepts for a
// type-7 HTML block tag.
function scanTagEnd(s, i) {
  let j = i + 1;
  const closing = s[j] === '/';
  if (closing) j++;
  if (j >= s.length) return -1;
  const c0 = s[j];
  if (!((c0 >= 'a' && c0 <= 'z') || (c0 >= 'A' && c0 <= 'Z'))) return -1;
  while (j < s.length) {
    const d = s[j];
    if ((d >= 'a' && d <= 'z') || (d >= 'A' && d <= 'Z') || (d >= '0' && d <= '9') || d === '-') j++;
    else break;
  }
  for (;;) {
    let ws = 0;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) { j++; ws++; }
    if (j >= s.length) return -1;
    if (s[j] === '>') return j + 1;
    if (s[j] === '/' && s[j + 1] === '>') return j + 2;
    // A closing tag takes no attributes at all, and an attribute must
    // be preceded by whitespace (so `:` or a letter straight after the
    // tag name, or straight after a quoted value, is not an attribute).
    if (closing || ws === 0) return -1;
    // Attribute name.
    const a0 = s[j];
    if (!((a0 >= 'a' && a0 <= 'z') || (a0 >= 'A' && a0 <= 'Z') || a0 === '_' || a0 === ':')) return -1;
    j++;
    while (j < s.length) {
      const d = s[j];
      if ((d >= 'a' && d <= 'z') || (d >= 'A' && d <= 'Z') || (d >= '0' && d <= '9') || d === '_' || d === '.' || d === ':' || d === '-') j++;
      else break;
    }
    // Whitespace after the name belongs to the next attribute unless
    // an `=` follows it.
    const afterName = j;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
    if (s[j] === '=') {
      j++;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
      if (s[j] === '"' || s[j] === "'") {
        const q = s[j];
        j++;
        while (j < s.length && s[j] !== q && s[j] !== '\n') j++;
        if (j >= s.length || s[j] !== q) return -1;
        j++;
      } else {
        const v0 = j;
        while (j < s.length) {
          const d = s[j];
          if (d === ' ' || d === '\t' || d === '\n' || d === '"' || d === "'" || d === '=' || d === '<' || d === '>' || d === '`') break;
          j++;
        }
        if (j === v0) return -1;
      }
    } else {
      j = afterName;
    }
  }
}

// Collect an HTML block whose end is marked by `closer` appearing in a
// line (a comment close, `?>`, `]]>`, a declaration `>`, or a closing
// tag for a pre/script/style/textarea block). `from` is the index in
// lines[i] to start searching from, `isCloseTag` searches case
// insensitively for `</name`. The block also swallows following blank
// lines; its text is the raw text with trailing blanks trimmed the way
// marked's helper does.
function htmlUntil(lines, i, end, endsNL, closer, from, isCloseTag) {
  let k = i;
  let found = -1;
  for (; k < end; k++) {
    const line = lines[k];
    const start = k === i ? from : 0;
    if (isCloseTag) {
      const low = line.toLowerCase();
      const at = low.indexOf(closer, start);
      if (at !== -1) { found = k; break; }
    } else {
      const at = line.indexOf(closer, start);
      if (at !== -1) { found = k; break; }
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
  return { node: { k: 'html', x: trimTrailingBlanks(rawText(lines, i, k2, endsNL)) }, next: k2 };
}

// Collect a type-6/7 HTML block: lines up to (not including) the first
// blank line, swallowing the blank lines that follow.
function htmlUntilBlank(lines, i, end, endsNL) {
  let k = i;
  while (k < end && !isBlankLine(lines[k])) k++;
  let k2 = k;
  while (k2 < end && isBlankLine(lines[k2])) k2++;
  return { node: { k: 'html', x: trimTrailingBlanks(rawText(lines, i, k2, endsNL)) }, next: k2 };
}

// Try to read an HTML block starting at lines[i]. Returns
// {node, next} or null.
function tryHtmlBlock(lines, i, end, endsNL) {
  const line = lines[i];
  const { cols, idx } = lineIndent(line);
  if (cols > 3) return null;
  const s = line.slice(idx);
  if (s.charCodeAt(0) !== 60) return null; // '<'
  if (s.startsWith('<!--')) {
    // Short comments `<!-->` and `<!--->` end on this very line.
    if (s[4] === '>' || (s[4] === '-' && s[5] === '>')) {
      let k2 = i + 1;
      while (k2 < end && lines[k2] === '') k2++;
      return { node: { k: 'html', x: trimTrailingBlanks(rawText(lines, i, k2, endsNL)) }, next: k2 };
    }
    return htmlUntil(lines, i, end, endsNL, '-->', 4, false);
  }
  if (s.startsWith('<?')) return htmlUntil(lines, i, end, endsNL, '?>', 2, false);
  if (s.startsWith('<![CDATA[')) return htmlUntil(lines, i, end, endsNL, ']]>', 9, false);
  if (s.startsWith('<!') && s.length > 2) {
    const c = s[2];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) return htmlUntil(lines, i, end, endsNL, '>', 2, false);
  }
  const t = tagNameOf(s, 0);
  if (!t) return null;
  if (!t.closing && PRE_TAGS.has(t.name)) {
    const c = s[t.end];
    // A bare name at end of line only opens the block when a newline
    // follows it (the opening pattern needs whitespace or `>`).
    if ((c === undefined && (i + 1 < end || endsNL)) || c === ' ' || c === '\t' || c === '>') {
      return htmlUntil(lines, i, end, endsNL, '</' + t.name + '>', 0, true);
    }
  }
  if (BLOCK_TAGS.has(t.name)) {
    const c = s[t.end];
    if (c === ' ' || c === '\t' || c === undefined || c === '>') return htmlUntilBlank(lines, i, end, endsNL);
    if (c === '/' && s[t.end + 1] === '>') return htmlUntilBlank(lines, i, end, endsNL);
  }
  // Type 7: a complete tag, alone on its line, for a tag that is neither
  // a pre-family tag nor a block tag. Tag names may be upper-case.
  if (!PRE_TAGS.has(t.name)) {
    const first = s[t.closing ? 2 : 1];
    if ((first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z')) {
      const tagEnd = scanTagEnd(s, 0);
      if (tagEnd !== -1) {
        let j = tagEnd;
        while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
        if (j === s.length) return htmlUntilBlank(lines, i, end, endsNL);
      }
    }
  }
  return null;
}

// Try to read a link reference definition starting at lines[i]. When
// one matches, the first definition for its label wins; the definition
// is recorded in `links`. Returns {next} (index just past the
// definition) or null.
function tryDef(lines, i, end, links, dry) {
  const line0 = lines[i];
  const { cols, idx } = lineIndent(line0);
  if (cols > 3) return null;
  const maxLines = Math.min(end - i, 6);
  let src = '';
  for (let k = 0; k < maxLines; k++) src += (k ? '\n' : '') + lines[i + k];
  let p = idx;
  if (src[p] !== '[') return null;
  p++;
  let label = '';
  let labelOk = false;
  while (p < src.length) {
    const c = src[p];
    if (c === '\\') {
      if (p + 1 >= src.length) return null;
      label += src.slice(p, p + 2);
      p += 2;
      continue;
    }
    if (c === ']') { labelOk = true; break; }
    if (c === '[') return null;
    if (c === '\n') {
      let q = p + 1;
      while (q < src.length && (src[q] === ' ' || src[q] === '\t')) q++;
      if (q >= src.length || src[q] === '\n') return null;
      label += '\n';
      p++;
      continue;
    }
    label += c;
    p++;
  }
  if (!labelOk) return null;
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
    const st = p;
    while (p < src.length && src[p] !== ' ' && src[p] !== '\t' && src[p] !== '\n') p++;
    if (p === st) return null;
    href = src.slice(st, p);
    let depth = 0;
    let bad = false;
    for (let k = 0; k < href.length; k++) {
      const c = href[k];
      if (c === '\\') { k++; continue; }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth < 0) { bad = true; break; }
      }
    }
    if (bad || depth !== 0) return null;
  }
  // Optional title, on this line or the next. It must be preceded by
  // whitespace (spaces/tabs, or a newline); a title glued straight onto
  // the destination is not a title, and the definition is rejected.
  // When the title cannot be used (it never closes, or it is followed
  // by non-EOL text), the definition falls back to its no-title form.
  let title = null;
  const saveP = p;
  let q = p;
  while (src[q] === ' ' || src[q] === '\t') q++;
  if (src[q] === '\n') {
    q++;
    while (src[q] === ' ' || src[q] === '\t') q++;
  }
  if (q > p) {
    const tc = src[q];
    if (tc === '"' || tc === "'" || tc === '(') {
      const closeCh = tc === '(' ? ')' : tc;
      let r = q + 1;
      let ok = false;
      while (r < src.length) {
        const c = src[r];
        if (c === '\\') { r += 2; continue; }
        if (c === closeCh) { ok = true; break; }
        if (tc === "'" && c === '\n') {
          let s2 = r + 1;
          while (s2 < src.length && (src[s2] === ' ' || src[s2] === '\t')) s2++;
          if (s2 >= src.length || src[s2] === '\n') break;
        }
        if (tc === '(' && c === '(') break;
        r++;
      }
      if (ok) {
        title = src.slice(q + 1, r);
        p = r + 1;
      }
    }
  }
  // After the destination (and any title) only spaces/tabs may follow
  // on the line; otherwise the title is dropped and the no-title form
  // is re-tested.
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
  if (!dry && !Object.prototype.hasOwnProperty.call(links, key)) {
    links[key] = {
      href: unescapePunct(bracketed ? href : href.replace(/^<(.*)>$/, '$1')),
      title: title === null ? null : unescapePunct(title),
    };
  }
  return { next: i + consumed };
}

// Is `line` a block start that interrupts a text run inside a list
// item (any list marker, hr, ATX heading, fence, blockquote start, or
// HTML block start, with at most `maxIndent` spaces of indent)?
function isBlockStartLine(line, maxIndent) {
  const n = leadingSpaces(line);
  if (n > maxIndent) return false;
  const s = line.slice(n);
  if (listMarker(s)) return true;
  if (isHrText(s)) return true;
  if (atxDepth(s) > 0) return true;
  if (fenceStart(s)) return true;
  if (s[0] === '>') return true;
  if (isHtmlStartPara(s)) return true;
  return false;
}

// Would the lines `first` (one line) plus a setext underline `under`
// form a setext heading? The text line must not itself look like a
// table delimiter row.
function lheadingPairOk(first, under) {
  const u = under.slice(lineIndent(under).idx);
  if (setextDepth(u) === 0) return false;
  const { cols, idx } = lineIndent(first);
  if (cols >= 4) return false;
  const s = first.slice(idx);
  if (s.trim() === '') return false;
  if (listMarker(s)) return false;
  if (fenceStart(s)) return false;
  if (s[0] === '>') return false;
  if (atxDepth(s) > 0) return false;
  if (isHtmlStartPara(s)) return false;
  if (isTableDelimLine(s)) return false;
  return true;
}

// Collect a paragraph (top level, `mode` 'para') or a bare text run
// (inside a list item, `mode` 'text') starting at lines[i]. A setext
// underline after the run turns it into a heading instead. Returns
// {node, next}.
function collectRun(lines, i, end, mode, endsNL) {
  const start = i;
  let j = i;
  let setext = 0;
  while (j < end) {
    const line = lines[j];
    if (j > start) {
      // In text mode (a list item, lexed with state.top false) a
      // whitespace-only line always ends the run: marked's text token
      // is one line and the rest becomes a space token, even at the
      // end of the text where no newline follows. In paragraph mode
      // the paragraph regex keeps such a trailing line.
      if (isBlankAt(lines, j, end, endsNL) || (mode === 'text' && isBlankLine(line))) break;
      const { cols, idx } = lineIndent(line);
      const s = line.slice(idx);
      if (cols <= 3) {
        if (isHrText(s)) { setext = setextDepth(s); if (setext) break; break; }
        if (atxDepth(s) > 0) break;
        if (s[0] === '>') break;
        if (fenceStart(s)) break;
        if (isHtmlStartPara(s)) break;
        if (mode === 'para') {
          if (isListInterruptPara(line)) break;
          if (tableInfo(lines, j, end, endsNL)) break;
        } else {
          if (listMarker(s)) break;
          if (tableInfo(lines, j, end, endsNL)) break;
        }
        const sd = setextDepth(s);
        if (sd > 0) {
          // A setext underline ends the run only when the run so far can
          // be its text: no line of the run may look like a table
          // delimiter row, and the first line must be a plain line.
          let ok = lheadingPairOk(lines[start], line);
          if (ok) {
            for (let k = start + 1; k < j; k++) {
              const li = lineIndent(lines[k]);
              const ls = lines[k].slice(li.idx);
              if (li.cols >= 4 || listMarker(ls) || isTableDelimLine(ls)) { ok = false; break; }
            }
          }
          if (ok) { setext = sd; break; }
          // Otherwise the underline is just another text line.
        }
      } else if (mode === 'text') {
        // An indented line starts an indented code block in text mode.
        break;
      }
      // In paragraph mode an indented line is ordinary continuation text.
    }
    j++;
  }
  if (setext > 0) {
    const text = lines.slice(start, j).join('\n').trim();
    return { node: { k: 'head', d: setext, x: text }, next: j + 1 };
  }
  // Trailing blank lines collected into the run (from a list item or a
  // blockquote chunk) are not part of the paragraph: the paragraph
  // token's text drops them, the way a blank line ends a run.
  const text = lines.slice(start, j).join('\n').replace(/\n+$/, '');
  return { node: { k: mode, x: text }, next: j };
}

// The main block lexer. Appends nodes for lines[0..lines.length) to
// `nodes` and returns true when a blank line separated two blocks
// inside this call (the loose-list signal). `top` selects paragraph
// versus bare-text runs; `cont` allows a leading paragraph/text/code
// node to merge into a trailing paragraph/text node left by an earlier
// chunk (blockquote chunks). `endsNL` says whether the text ended with
// a newline.
function lexLines(lines, links, top, nodes, cont, endsNL) {
  const end = lines.length;
  let i = 0;
  let gapBlanks = 0; // blank lines skipped since the last node was added
  let blankGap = false;
  let pendingGap = false; // a blank line seen after a node, before the next node
  // The last thing added was a paragraph/text run, or a definition
  // merged into one (so a following definition merges too).
  let afterPara = false;
  const pushNode = (n) => {
    if (pendingGap) { blankGap = true; pendingGap = false; }
    nodes.push(n);
  };
  while (i < end) {
    const line = lines[i];
    // Outside the top level (a list item) a whitespace-only line is
    // blank even at the end of the text: it becomes a space token
    // there, never a text run of its own.
    if (isBlankAt(lines, i, end, endsNL) || (!top && isBlankLine(line))) {
      i++;
      gapBlanks++;
      if (nodes.length > 0) pendingGap = true;
      afterPara = false;
      continue;
    }
    const { cols, idx } = lineIndent(line);
    const s = line.slice(idx);
    // Indented code. A whitespace-only line is never code on its own.
    if (cols >= 4 && !isBlankLine(line)) {
      let k = i;
      let lastCode = -1;
      while (k < end) {
        const l2 = lines[k];
        if (isBlankLine(l2)) { k++; continue; }
        const ind2 = lineIndent(l2);
        if (ind2.cols >= 4) { lastCode = k; k++; continue; }
        break;
      }
      // Trailing blank lines belong to the code token's raw text.
      let k2 = lastCode + 1;
      while (k2 < end && isBlankLine(lines[k2])) k2++;
      const raw = rawText(lines, i, k2, endsNL);
      const trimmed = trimTrailingBlanks(raw);
      const text = trimmed.split('\n').map((l) => stripCols(l, 4)).join('\n');
      const prev = nodes.length > 0 ? nodes[nodes.length - 1] : null;
      if (prev && (prev.k === 'para' || prev.k === 'text') && gapBlanks === 0) {
        prev.x += '\n' + text;
        afterPara = true;
      } else {
        pushNode({ k: 'code', x: text, lang: '' });
        afterPara = false;
      }
      gapBlanks = 0;
      i = k2;
      continue;
    }
    // Fenced code.
    const fs = fenceStart(s);
    if (fs) {
      let k = i + 1;
      let closed = -1;
      while (k < end) {
        const l2 = lines[k];
        const ind2 = lineIndent(l2);
        if (ind2.cols <= 3 && isFenceClose(l2.slice(ind2.idx), fs.ch, fs.len)) { closed = k; break; }
        k++;
      }
      const contentEnd = closed === -1 ? end : closed;
      let text = lines.slice(i + 1, contentEnd).join('\n');
      if (fs.ch === '`') {
        // Indented fences dedent their content by the fence's indent.
        const m = /^(\s+)(?:```)/.exec(rawText(lines, i, i + 1, endsNL));
        if (m) {
          const n = m[1].length;
          text = text.split('\n').map((l) => {
            const mm = /^\s+/.exec(l);
            if (!mm) return l;
            return l.slice(Math.min(mm[0].length, n));
          }).join('\n');
        }
      }
      const lang = unescapePunct(fs.info.trim()).match(/^\S*/)[0];
      pushNode({ k: 'code', x: text, lang });
      afterPara = false;
      gapBlanks = 0;
      i = closed === -1 ? end : closed + 1;
      continue;
    }
    // ATX heading.
    const depth = atxDepth(s);
    if (depth > 0) {
      let text = s.slice(depth).trim();
      if (text.endsWith('#')) {
        const stripped = text.replace(/#+$/, '');
        if (stripped === '' || /[ \t]$/.test(stripped)) text = stripped.trim();
      }
      pushNode({ k: 'head', d: depth, x: text });
      afterPara = false;
      gapBlanks = 0;
      i++;
      continue;
    }
    // Thematic break.
    if (isHrText(s)) {
      pushNode({ k: 'hr' });
      afterPara = false;
      gapBlanks = 0;
      i++;
      continue;
    }
    // Blockquote.
    if (s[0] === '>') {
      const q = lexQuote(lines, i, end, links, endsNL);
      pushNode(q.node);
      afterPara = false;
      gapBlanks = 0;
      // A blank line swallowed at the end of the quote still separates
      // it from the next block (a nested list's raw text is trimmed,
      // so its trailing blank line belongs to the outer text).
      if (q.next > i + 1 && q.next <= end && isBlankLine(lines[q.next - 1]) && nodes.length > 0) pendingGap = true;
      i = q.next;
      continue;
    }
    // List.
    if (listMarker(s)) {
      const l = lexList(lines, i, end, links, endsNL);
      if (l) {
        pushNode(l.node);
        afterPara = false;
        gapBlanks = 0;
        if (l.next > i + 1 && l.next <= end && isBlankLine(lines[l.next - 1]) && nodes.length > 0) pendingGap = true;
        i = l.next;
        continue;
      }
    }
    // HTML block.
    const html = tryHtmlBlock(lines, i, end, endsNL);
    if (html) {
      pushNode(html.node);
      afterPara = false;
      gapBlanks = 0;
      i = html.next;
      continue;
    }
    // Link reference definition. A definition directly after paragraph
    // text is part of that paragraph (and defines nothing), so it is
    // parsed without registering when the previous node is a paragraph
    // or text run with no blank line between. Once one definition has
    // merged, the next one merges too.
    if (afterPara) {
      const prevDef = nodes[nodes.length - 1];
      const dry = tryDef(lines, i, end, links, true);
      if (dry) {
        prevDef.x += '\n' + lines.slice(i, dry.next).join('\n');
        gapBlanks = 0;
        i = dry.next;
        continue;
      }
    }
    const def = tryDef(lines, i, end, links, false);
    if (def) {
      // A definition is a token too: a blank line before it still
      // separates two blocks inside this call.
      if (pendingGap) { blankGap = true; pendingGap = false; }
      afterPara = false;
      gapBlanks = 0;
      i = def.next;
      continue;
    }
    // Table.
    const ti = tableInfo(lines, i, end, endsNL);
    if (ti) {
      const rows = [];
      for (let r = i + 2; r < ti.rowsEnd; r++) {
        rows.push(splitTableCells(lines[r], ti.header.length));
      }
      pushNode({ k: 'table', h: ti.header, a: ti.align, r: rows });
      afterPara = false;
      gapBlanks = 0;
      i = ti.rowsEnd;
      continue;
    }
    // Paragraph, bare text, or setext heading.
    const run = collectRun(lines, i, end, top ? 'para' : 'text', endsNL);
    const prev = nodes.length > 0 ? nodes[nodes.length - 1] : null;
    if (cont && prev && (prev.k === 'para' || prev.k === 'text') && (run.node.k === 'para' || run.node.k === 'text') && gapBlanks === 0) {
      prev.x += '\n' + run.node.x;
      afterPara = true;
    } else if (!top && prev && prev.k === 'text' && run.node.k === 'text' && gapBlanks === 0) {
      prev.x += '\n' + run.node.x;
      afterPara = true;
    } else {
      pushNode(run.node);
      afterPara = run.node.k === 'para' || run.node.k === 'text';
    }
    gapBlanks = 0;
    i = run.next;
  }
  return blankGap;
}

// Does `line` start a block when the content indent is `maxIndent`
// (used inside list items: a block start at an indent below the item's
// content indent ends the item)? `maxIndent` is the content indent
// minus one, matching the way marked parameterises these tests.
function isBlockStartMax(line, maxIndent) {
  const n = leadingSpaces(line);
  if (n > maxIndent) return false;
  const s = line.slice(n);
  if (fenceStart(s)) return true;
  if (atxDepth(s) > 0) return true;
  if (isHtmlStartPara(s)) return true;
  if (s[0] === '>') return true;
  if (listMarker(s)) return true;
  if (isHrText(s)) return true;
  return false;
}

// Lex a list starting at lines[i]. Returns {node, next} or null when
// the line is not really a list start.
function lexList(lines, i, end, links, endsNL) {
  const first = lines[i];
  const fi = lineIndent(first);
  if (fi.cols > 3) return null;
  const m0 = listMarker(first.slice(fi.idx));
  if (!m0) return null;
  const ordered = m0.ordered;
  const delim = m0.delim;
  const start = ordered ? m0.num : 1;
  const items = [];
  let j = i;
  while (j < end) {
    const line = lines[j];
    const li = lineIndent(line);
    if (li.cols > 3) break;
    const s = line.slice(li.idx);
    const mk = listMarker(s);
    if (!mk || mk.ordered !== ordered || mk.delim !== delim) break;
    if (isHrText(s)) break;
    // One item, starting at line j.
    const itemStart = j;
    const b = li.idx + mk.markerLen; // column where the content begins
    let rest = s.slice(mk.markerLen);
    // Expand tabs in the leading whitespace of the content, from column b.
    let restExp = '';
    {
      let col = b;
      let k = 0;
      while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) {
        if (rest[k] === ' ') { restExp += ' '; col++; k++; }
        else { const w = 4 - (col % 4); restExp += ' '.repeat(w); col += w; k++; }
      }
      restExp += rest.slice(k);
    }
    const m = restExp;
    const y = m.trim() === '';
    let R;
    let dFirst = '';
    if (y) {
      R = b + 1;
    } else {
      let sp = 0;
      while (sp < m.length && m[sp] === ' ') sp++;
      R = sp > 4 ? 1 : sp;
      dFirst = m.slice(R);
      R += b;
    }
    const itemLines = y ? [] : [dFirst];
    let prevM = m;
    let prevBlank = y;
    let k = j + 1;
    let u = false;
    if (y && k < end && isBlankLine(lines[k])) {
      k++;
      u = true;
    }
    // Block-start tests inside an item use the content indent minus
    // one, clamped to 0..3.
    const br = Math.max(0, Math.min(3, R - 1));
    if (!u) {
      while (k < end) {
        const U = lines[k];
        const Z = expandLeadingTabs(U);
        const fns = firstNonSpaceIdx(Z);
        const blank = fns === -1;
        if (!blank && isBlockStartMax(U, br)) break;
        if (blank || fns >= R) {
          itemLines.push(Z.slice(R));
          prevBlank = blank;
          prevM = Z.slice(R);
          k++;
          continue;
        }
        // A less-indented, non-blank line: a lazy continuation, unless
        // the previous line was blank, indented code, or a block start.
        const pmExpanded = prevM.replace(/\t/g, '    ');
        const pmFirst = firstNonSpaceIdx(pmExpanded);
        const pmIndent = leadingSpaces(prevM);
        let pmIsBlock = false;
        if (pmIndent <= br) {
          const ps = prevM.slice(pmIndent);
          pmIsBlock = !!fenceStart(ps) || atxDepth(ps) > 0 || isHtmlStartPara(ps) || isHrText(ps);
        }
        if (prevBlank || pmFirst >= 4 || pmIsBlock) break;
        let qe;
        if (/^ {0,3}(?:=+|-+) *$/.test(U) && lheadingPairOk(prevM, U)) {
          qe = '    ' + Z.replace(/^ {0,3}/, '');
        } else {
          qe = U;
        }
        itemLines.push(qe);
        prevBlank = false;
        prevM = Z.slice(R);
        k++;
      }
    }
    // The item's text: the collected lines, with the last item's text
    // trimmed at the end (marked trims only the last item).
    const itemEnd = k;
    let isLast = true;
    if (itemEnd < end) {
      const li2 = lineIndent(lines[itemEnd]);
      if (li2.cols <= 3) {
        const s2 = lines[itemEnd].slice(li2.idx);
        const mk2 = listMarker(s2);
        if (mk2 && mk2.ordered === ordered && mk2.delim === delim && !isHrText(s2)) isLast = false;
      }
    }
    let textLines = itemLines.slice();
    if (isLast) {
      const joined = textLines.join('\n').replace(/[ \t\n]+$/, '');
      textLines = joined === '' ? [] : joined.split('\n');
    }
    // An item whose raw text ends with a blank line makes the list
    // loose (unless it is the last item); the raw text is the source
    // slice from this item to the next one.
    const rawEnd = lines.slice(itemStart, itemEnd).join('\n') + ((itemEnd < end || endsNL) ? '\n' : '');
    const pBlank = /\n[ \t]*\n[ \t]*$/.test(rawEnd);
    const nodes = [];
    const blankGap = lexLines(textLines, links, false, nodes, false, false);
    // Task list item: strip the checkbox marker from the first text.
    let checked = null;
    if (textLines.length > 0) {
      const firstText = textLines.join('\n');
      const tm = /^\[([ xX])\][ \t]+\S/.exec(firstText);
      if (tm && nodes.length > 0 && (nodes[0].k === 'text' || nodes[0].k === 'para')) {
        checked = tm[1] !== ' ';
        nodes[0].x = nodes[0].x.replace(/^\[[ xX]\][ \t]+/, '');
      }
    }
    items.push({ t: checked, c: nodes, blankGap, pBlank });
    j = itemEnd;
  }
  if (items.length === 0) return null;
  const loose = items.some((it) => it.blankGap)
    || items.slice(0, -1).some((it) => it.pBlank);
  for (const it of items) {
    if (loose) {
      for (const n of it.c) if (n.k === 'text') n.k = 'para';
    }
    delete it.blankGap;
    delete it.pBlank;
  }
  return {
    node: { k: 'list', o: ordered, s: start, l: loose, i: items, src: lines.slice(i, j) },
    next: j,
  };
}

// Lex a blockquote starting at lines[i]. Returns {node, next}.
function lexQuote(lines, i, end, links, endsNL) {
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
    // A whitespace-only line is blank only when a newline follows it;
    // at the very end of the text it is continuation text.
    if (isBlankLine(stripped) && (idx0 + 1 < end || endsNL)) {
      paraOpen = false;
      inTable = false;
      prevKind = 'blank';
      return;
    }
    if (inFence) {
      const { cols, idx } = lineIndent(stripped);
      if (cols <= 3 && isFenceClose(stripped.slice(idx), inFence.ch, inFence.len)) inFence = null;
      paraOpen = false;
      prevKind = 'block';
      return;
    }
    const { cols, idx } = lineIndent(stripped);
    const s = stripped.slice(idx);
    // An indented line merges into open paragraph or list-item text;
    // otherwise it is a code block, which closes the paragraph.
    if (cols >= 4) {
      if (prevKind === 'plain' || prevKind === 'list') { paraOpen = true; inTable = false; return; }
      paraOpen = false;
      inTable = false;
      prevKind = 'block';
      return;
    }
    if (cols <= 3) {
      const fs = fenceStart(s);
      if (fs) { inFence = fs; paraOpen = false; inTable = false; prevKind = 'block'; return; }
      if (atxDepth(s) > 0 || isHrText(s) || isHtmlStartPara(s) || setextDepth(s) > 0) {
        paraOpen = false; inTable = false; prevKind = 'block'; return;
      }
      if (inTable) { paraOpen = false; prevKind = 'plain'; return; }
      if (isTableDelimLine(s) && prevKind === 'plain') {
        inTable = true; paraOpen = false; prevKind = 'plain'; return;
      }
      if (listMarker(s)) { paraOpen = true; inTable = false; prevKind = 'list'; return; }
    }
    paraOpen = true;
    inTable = false;
    prevKind = 'plain';
  };
  while (j < end) {
    const line = lines[j];
    const qm = quoteMarker(line);
    if (qm !== null) {
      rawLines.push(line);
      update(qm, j);
      j++;
      continue;
    }
    if (isBlankAt(lines, j, end, endsNL)) break;
    if (!paraOpen) break;
    if (isBlockStartLine(line, 3)) break;
    rawLines.push(line);
    update(line, j);
    j++;
  }
  // Split the extent into chunks: a chunk is the lazy lines before the
  // first marker, plus the marker lines that follow them. Each chunk is
  // lexed separately, with paragraph/code/definition merges across
  // chunk boundaries, the way marked's blockquote loop does it.
  let rest = rawLines.slice();
  const nodes = [];
  while (rest.length > 0) {
    const chunk = [];
    let seen = false;
    while (rest.length > 0) {
      const qm = quoteMarker(rest[0]);
      if (qm !== null) { chunk.push(qm); seen = true; rest.shift(); }
      else if (!seen) {
        // A lazy line that looks like a setext underline is not one:
        // it is indented (four spaces) so the re-lex keeps it as
        // paragraph text.
        let l = rest[0];
        if (chunk.length > 0) {
          const m = /^ {0,3}((?:=+|-+)[ \t]*)$/.exec(l);
          if (m) l = '    ' + m[1];
        }
        chunk.push(l);
        rest.shift();
      }
      else break;
    }
    lexLines(chunk, links, true, nodes, true, false);
    const last = nodes.length > 0 ? nodes[nodes.length - 1] : null;
    if ((last && (last.k === 'list' || last.k === 'quote')) && rest.length > 0) {
      // A list or a nested quote absorbs following lazy lines: re-lex
      // it with the remaining lines appended. Lists see the remaining
      // lines raw; nested quotes see them with one marker level
      // stripped.
      const srcLines = last.src;
      let combined;
      if (last.k === 'list') {
        combined = srcLines.concat(rest);
      } else {
        combined = srcLines.concat(rest.map((l) => {
          const q = quoteMarker(l);
          return q === null ? l : q;
        }));
      }
      const res = last.k === 'list'
        ? lexList(combined, 0, combined.length, links, false)
        : lexQuote(combined, 0, combined.length, links, false);
      if (res) {
        const extra = res.next - srcLines.length;
        nodes[nodes.length - 1] = res.node;
        if (extra > 0) rest.splice(0, extra);
      }
    }
  }
  return { node: { k: 'quote', c: nodes, src: lines.slice(i, j) }, next: j };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTableCell(text, align, header, st) {
  const tag = header ? 'th' : 'td';
  return '<' + tag + (align ? ' align="' + align + '"' : '') + '>' + inlineHtml(text, st) + '</' + tag + '>\n';
}

function renderNode(n, st) {
  switch (n.k) {
    case 'para': return '<p>' + inlineHtml(n.x, st) + '</p>\n';
    case 'text': return inlineHtml(n.x, st);
    case 'head': return '<h' + n.d + '>' + inlineHtml(n.x, st) + '</h' + n.d + '>\n';
    case 'hr': return '<hr>\n';
    case 'code': {
      let out = '<pre><code';
      // The language is escaped without encoding entities, and the
      // code text keeps exactly one trailing newline (or none when
      // it is empty).
      if (n.lang) out += ' class="language-' + escText(n.lang, false) + '"';
      const r = n.x ? n.x.replace(/\n$/, '') + '\n' : '';
      return out + '>' + escText(r, true) + '</code></pre>\n';
    }
    case 'html': return n.x;
    case 'quote': return '<blockquote>\n' + renderNodes(n.c, st) + '</blockquote>\n';
    case 'list': {
      let out = n.o ? '<ol' + (n.s !== 1 ? ' start="' + n.s + '"' : '') + '>\n' : '<ul>\n';
      for (const it of n.i) {
        const cb = it.t === null ? '' : '<input ' + (it.t ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        out += '<li>';
        const ch = it.c;
        if (ch.length > 0 && (ch[0].k === 'para' || ch[0].k === 'text')) {
          const first = ch[0];
          if (first.k === 'para') out += '<p>' + cb + inlineHtml(first.x, st) + '</p>\n';
          else out += cb + inlineHtml(first.x, st);
          for (let q = 1; q < ch.length; q++) out += renderNode(ch[q], st);
        } else {
          out += cb;
          out += renderNodes(ch, st);
        }
        out += '</li>\n';
      }
      return out + (n.o ? '</ol>\n' : '</ul>\n');
    }
    case 'table': {
      let h = '';
      for (let i = 0; i < n.h.length; i++) h += renderTableCell(n.h[i], n.a[i], true, st);
      let body = '';
      for (const row of n.r) {
        let rc = '';
        for (let i = 0; i < row.length; i++) rc += renderTableCell(row[i], n.a[i], false, st);
        body += '<tr>\n' + rc + '</tr>\n';
      }
      return '<table>\n<thead>\n<tr>\n' + h + '</tr>\n</thead>\n' +
        (body ? '<tbody>' + body + '</tbody>' : '') + '</table>\n';
    }
    default: return '';
  }
}

function renderNodes(nodes, st) {
  let out = '';
  for (const n of nodes) out += renderNode(n, st);
  return out;
}

// The entry point: the HTML marked 18.1.3 renders for `markdown` with
// its defaults (GFM on, breaks off). Stateless per call.
export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const links = Object.create(null);
  const st = { links, inLink: false, linkEmitted: false, inRawBlock: false };
  let lines = src.split('\n');
  const endsNL = src.endsWith('\n');
  if (endsNL) lines.pop();
  const nodes = [];
  lexLines(lines, links, true, nodes, false, endsNL);
  return renderNodes(nodes, st);
}
