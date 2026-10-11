// Markup used to send a run of inline DOM text to a translator and map the result
// back onto the same text nodes (we never restructure the DOM: that breaks React/Vue).
//
//   <N>…</N>  an inline element (link, bold…) that contains text
//   <N/>      an element that only separates text (image, code span, <br> between nodes)
//   <br>      a hard line break inside pre-wrap text
//
// Text "positions" are counted per context (0 = root, N = inside tag N): every child
// marker in a context starts a new position. Source and translation are both read with
// this rule, so "<1>John</1> and <2>Mary</2>" → "<2>María</2> y <1>Juan</1>" still maps
// each name to its own link and " y " to the text between them.

const TOKEN_RE = /<(\/?)(\d{1,3})(\/?)>|<br>/g;

/** Parse markup into Map("ctx:pos" → text). Unknown tags are ignored (lenient). */
export function parseMarkup(str, knownIds) {
  const slots = new Map();
  const seen = new Set();
  const stack = [0];
  const pos = new Map([[0, 0]]);
  const add = (text) => {
    if (!text) return;
    const ctx = stack[stack.length - 1];
    const key = `${ctx}:${pos.get(ctx)}`;
    slots.set(key, (slots.get(key) ?? "") + text);
  };
  let last = 0;
  for (const m of str.matchAll(TOKEN_RE)) {
    add(str.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[0] === "<br>") { add("\n"); continue; }
    const id = Number(m[2]);
    if (knownIds && !knownIds.has(id)) continue;
    const ctx = stack[stack.length - 1];
    if (m[1]) { // closing tag: pop back to it if it's open
      const i = stack.lastIndexOf(id);
      if (i > 0) stack.length = i;
      continue;
    }
    seen.add(id);
    pos.set(ctx, pos.get(ctx) + 1);
    if (!m[3]) { stack.push(id); pos.set(id, 0); }
  }
  add(str.slice(last));
  return { slots, seen };
}

/** Strip markup to plain text (for language detection, judging, logs). */
export function stripMarkup(str) {
  return str.replace(TOKEN_RE, (t) => (t === "<br>" ? "\n" : "")).replace(/[ \t]+/g, " ").trim();
}

/** Ids of all tags in a markup string. */
export function tagIds(str) {
  const ids = new Set();
  for (const m of str.matchAll(TOKEN_RE)) if (m[2]) ids.add(Number(m[2]));
  return ids;
}

/** Split markup into its text pieces + the skeleton, so a plain-text engine can
 *  translate pieces one by one and we re-assemble the same tags around them. */
export function splitForPlainEngine(str) {
  const pieces = [];
  const skeleton = [];
  let last = 0;
  const pushText = (t) => {
    if (/\p{L}/u.test(t)) {
      const lead = t.match(/^\s*/)[0];
      const trail = t.slice(lead.length).match(/\s*$/)[0];
      skeleton.push({ piece: pieces.length, lead, trail });
      pieces.push(t.trim());
    } else if (t) skeleton.push({ raw: t });
  };
  for (const m of str.matchAll(TOKEN_RE)) {
    pushText(str.slice(last, m.index));
    skeleton.push({ raw: m[0] });
    last = m.index + m[0].length;
  }
  pushText(str.slice(last));
  return {
    pieces,
    join: (translated) =>
      skeleton.map((s) => (s.raw !== undefined ? s.raw : s.lead + (translated[s.piece] ?? pieces[s.piece]) + s.trail)).join(""),
  };
}

/**
 * Shape of the markup: every tag with the tag it sits inside (and <br>s likewise).
 * Word order may change in translation, nesting may not: a tag that moves out of its
 * parent would put text into the wrong element.
 */
export function tagStructure(str) {
  const stack = [0];
  const parts = [];
  for (const m of str.matchAll(TOKEN_RE)) {
    if (m[0] === "<br>") {
      parts.push(`br@${stack.at(-1)}`);
      continue;
    }
    const id = Number(m[2]);
    if (m[1]) {
      const i = stack.lastIndexOf(id);
      if (i > 0) stack.length = i;
      else parts.push(`stray${id}`);
      continue;
    }
    parts.push(`${id}@${stack.at(-1)}${m[3] ? "/" : ""}`);
    if (!m[3]) stack.push(id);
  }
  if (stack.length > 1) parts.push("unclosed");
  return parts.sort().join(",");
}
