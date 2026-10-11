// Splits the DOM into translation units: runs of inline text inside one block.
// A unit's source is plain text, or markup (see shared/markup.js) when the run spans
// inline elements, so the translation can be written back into the same text nodes.

import { parseMarkup } from "../shared/markup.js";

const TEXT = 3;
const ELEMENT = 1;
const LETTER = /\p{L}/u;

// Inline elements whose text is part of the surrounding sentence.
const INLINE = new Set([
  "a", "abbr", "b", "bdi", "bdo", "big", "cite", "data", "del", "dfn", "em", "font", "i",
  "ins", "label", "mark", "nobr", "q", "rp", "rt", "ruby", "s", "small", "span", "strike",
  "strong", "sub", "sup", "time", "tt", "u",
]);
// Never looked into. Inline ones become <N/> separators; "pre" ends the run.
const OPAQUE = new Set([
  "code", "kbd", "samp", "var", "svg", "math", "img", "picture", "br", "wbr", "input",
  "select", "textarea", "canvas", "video", "audio", "iframe", "object", "embed", "pre",
]);
// Invisible: skipped without affecting runs.
const IGNORE = new Set(["script", "style", "noscript", "template", "link", "meta", "head", "title"]);

/** Nearest ancestor (inclusive) that starts its own runs: a block, shadow root or document. */
export function blockOf(node) {
  let n = node?.nodeType === TEXT ? node.parentNode : node;
  while (n && n.nodeType === ELEMENT && INLINE.has(n.localName) && !n.shadowRoot) n = n.parentNode;
  return n;
}

export const isInlineTag = (tag) => INLINE.has(tag);

/** node → { orig, tr }: what we replaced, so re-scans read the original text. */
export const records = new WeakMap();
/** Text nodes currently holding a translation (for show-original / disable). */
export const translatedNodes = new Set();

let nextId = 1;

export function sourceOf(node) {
  const r = records.get(node);
  const v = node.nodeValue;
  if (r && (v === r.tr || v === r.orig)) return r.orig;
  return v;
}

function shadowOf(el) {
  if (el.shadowRoot) return el.shadowRoot;
  try {
    return globalThis.chrome?.dom?.openOrClosedShadowRoot?.(el) ?? null;
  } catch {
    return null;
  }
}

export function isExcluded(el) {
  return (
    el.getAttribute("translate") === "no" ||
    el.classList.contains("notranslate") ||
    el.hasAttribute("data-esx") ||
    el.isContentEditable ||
    isIcon(el)
  );
}

// Icon fonts draw a word as a symbol ("home" → 🏠 in Material Symbols). Translating the
// word breaks the icon into garbled letters, so icon text is never touched.
const ICON_TAGS = new Set(["mat-icon", "md-icon", "iron-icon"]);
const ICON_CLASS = /\b(material-icons|material-symbols|google-symbols|google-material-icons|mat-icon|glyphicon)/i;
const iconFont = new WeakMap();
function isIcon(el) {
  if (ICON_TAGS.has(el.localName)) return true;
  const cls = el.getAttribute("class");
  if (cls && ICON_CLASS.test(cls)) return true;
  // Any other ligature icon font: one short lowercase word ("arrow_forward") in a font
  // whose name says icons/symbols.
  const t = el.firstChild;
  if (!t || t.nodeType !== TEXT || t !== el.lastChild || !/^[a-z0-9_]{2,40}$/.test(sourceOf(t).trim())) return false;
  let v = iconFont.get(el);
  if (v === undefined) {
    v = /icons|symbols|material/i.test(getComputedStyle(el).fontFamily);
    iconFont.set(el, v);
  }
  return v;
}

/**
 * Scan a container (Element, ShadowRoot or Document) and call onUnit(unit) for each run
 * that has letters in it. onShadowRoot(root) is called for every shadow root found, so the
 * caller can observe mutations inside it.
 */
export function scan(container, onUnit, onShadowRoot) {
  let run = { container, tokens: [], letters: false };
  const flush = () => {
    if (run.letters) {
      const unit = finishRun(run);
      if (unit) onUnit(unit);
    }
    run = { container, tokens: [], letters: false };
  };
  const walk = (parent) => {
    for (let n = parent.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === TEXT) {
        const src = sourceOf(n);
        const last = run.tokens[run.tokens.length - 1];
        if (last?.t === "text") {
          last.nodes.push(n);
          last.srcs.push(src);
        } else run.tokens.push({ t: "text", nodes: [n], srcs: [src] });
        if (!run.letters && LETTER.test(src)) run.letters = true;
        continue;
      }
      if (n.nodeType !== ELEMENT) continue;
      const tag = n.localName;
      if (IGNORE.has(tag)) continue;
      if (OPAQUE.has(tag) || isExcluded(n)) {
        if (tag === "pre" || !(OPAQUE.has(tag) || INLINE.has(tag))) flush();
        else run.tokens.push({ t: "void", el: n });
        continue;
      }
      const shadow = shadowOf(n);
      if (shadow || !INLINE.has(tag)) {
        flush();
        if (shadow) {
          onShadowRoot?.(shadow);
          scan(shadow, onUnit, onShadowRoot);
        }
        scan(n, onUnit, onShadowRoot);
        continue;
      }
      run.tokens.push({ t: "open", el: n });
      walk(n);
      run.tokens.push({ t: "close", el: n });
    }
  };
  walk(container);
  flush();
}

const isBlankText = (tok) => tok.t === "text" && !tok.srcs.join("").trim();

function finishRun(run) {
  let tokens = balance(run.tokens);
  tokens = collapseEmptyElements(tokens);

  // Drop separators/whitespace at the edges and wrappers around the whole run.
  for (let changed = true; changed; ) {
    changed = false;
    while (tokens.length && (tokens[0].t === "void" || isBlankText(tokens[0]))) { tokens.shift(); changed = true; }
    while (tokens.length && (tokens.at(-1).t === "void" || isBlankText(tokens.at(-1)))) { tokens.pop(); changed = true; }
    if (tokens.length >= 2 && tokens[0].t === "open" && tokens.at(-1).t === "close" && tokens[0].el === tokens.at(-1).el && matchIndex(tokens, 0) === tokens.length - 1) {
      tokens = tokens.slice(1, -1);
      changed = true;
    }
  }
  if (!tokens.length) return null;

  // Merge consecutive separators.
  tokens = tokens.filter((tok, i) => !(tok.t === "void" && tokens[i - 1]?.t === "void"));

  const preWrap = tokens.some((tok) => tok.t === "text" && tok.srcs.some((s) => /\S\n+\s*\S/.test(s))) && keepsNewlines(run.container);

  const ids = new Map();
  const slots = [];
  const stack = [0];
  const pos = new Map([[0, 0]]);
  let src = "";
  for (const tok of tokens) {
    const ctx = stack[stack.length - 1];
    if (tok.t === "text") {
      let text = tok.srcs.join("");
      text = preWrap
        ? text.replace(/[ \t\r\f]+/g, " ").replace(/ ?\n ?/g, "<br>")
        : text.replace(/\s+/g, " ");
      slots.push({ nodes: tok.nodes, srcs: tok.srcs, key: `${ctx}:${pos.get(ctx)}` });
      src += text;
    } else if (tok.t === "close") {
      src += `</${ids.get(tok.el)}>`;
      stack.pop();
    } else {
      const id = ids.size + 1;
      ids.set(tok.el, id);
      pos.set(ctx, pos.get(ctx) + 1);
      if (tok.t === "open") {
        src += `<${id}>`;
        stack.push(id);
        pos.set(id, 0);
      } else src += `<${id}/>`;
    }
  }

  // Leading/trailing whitespace stays in the DOM; the translator gets trimmed text.
  const firstText = tokens[0].t === "text" ? slots[0] : null;
  const lastText = tokens.at(-1).t === "text" ? slots.at(-1) : null;
  if (firstText) firstText.lead = firstText.srcs.join("").match(/^\s*/)[0];
  if (lastText) lastText.trail = lastText.srcs.join("").match(/\s*$/)[0];
  src = src.replace(/^(?: |<br>)+|(?: |<br>)+$/g, "");
  if (!LETTER.test(src)) return null;

  // Visibility is tracked on the smallest element holding all of the unit's text: the
  // first node's parent can be a 1px screen-reader copy next to the visible headline.
  const anchor = commonAncestor(slots.flatMap((s) => s.nodes), run.container);
  return {
    id: nextId++,
    source: src,
    plain: ids.size === 0 && !src.includes("<br>"),
    ids: new Set(ids.values()),
    slots,
    anchor,
    container: run.container,
  };
}

function commonAncestor(nodes, container) {
  const chain = [];
  for (let p = nodes[0].parentNode; p; p = p.parentNode) {
    chain.push(p);
    if (p === container) break;
  }
  let top = 0;
  for (let i = 1; i < nodes.length; i++) {
    for (let p = nodes[i].parentNode; p; p = p.parentNode) {
      const at = chain.indexOf(p);
      if (at !== -1) {
        top = Math.max(top, at);
        break;
      }
    }
  }
  for (let i = top; i < chain.length; i++) if (chain[i].nodeType === ELEMENT) return chain[i];
  return container.host ?? nodes[0].parentElement ?? null;
}

function keepsNewlines(container) {
  const el = container.nodeType === ELEMENT ? container : container.host;
  if (!el) return false;
  const ws = getComputedStyle(el).whiteSpace;
  return ws === "pre-wrap" || ws === "pre-line" || ws === "break-spaces" || ws === "pre";
}

// Drop open/close tokens that don't pair up (a run can start or end inside an element).
function balance(tokens) {
  const keep = new Array(tokens.length).fill(true);
  const stack = [];
  tokens.forEach((tok, i) => {
    if (tok.t === "open") stack.push(i);
    else if (tok.t === "close") {
      const j = stack.findLastIndex((k) => tokens[k].el === tok.el);
      if (j === -1) keep[i] = false;
      else {
        for (const k of stack.splice(j)) if (tokens[k].el !== tok.el) keep[k] = false;
      }
    }
  });
  for (const k of stack) keep[k] = false;
  return tokens.filter((_, i) => keep[i]);
}

// An element pair with no letters inside ("<span>3</span> comments") is just a
// separator: its text (numbers, icons) stays untouched.
function collapseEmptyElements(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t === "open") {
      const end = matchIndex(tokens, i);
      const inner = tokens.slice(i + 1, end);
      if (!inner.some((t) => t.t === "text" && t.srcs.some((s) => LETTER.test(s)))) {
        out.push({ t: "void", el: tok.el });
        i = end;
        continue;
      }
    }
    out.push(tok);
  }
  return out;
}

function matchIndex(tokens, i) {
  let depth = 0;
  for (let j = i; j < tokens.length; j++) {
    if (tokens[j].t === "open") depth++;
    else if (tokens[j].t === "close" && --depth === 0) return j;
  }
  return tokens.length - 1;
}

function setText(node, value, orig) {
  records.set(node, { orig, tr: value });
  translatedNodes.add(node);
  if (node.nodeValue !== value) node.nodeValue = value;
}

/** Write a translation into the unit's text nodes. Returns false if tags went missing. */
export function applyTranslation(unit, translated) {
  if (unit.plain) {
    const s = unit.slots[0];
    writeSlot(s, (s.lead ?? "") + translated.trim() + (s.trail ?? ""));
    return true;
  }
  const { slots, seen } = parseMarkup(translated, unit.ids);
  let complete = seen.size === unit.ids.size;
  for (const s of unit.slots) {
    let text = slots.get(s.key);
    if (text === undefined) {
      // The model dropped this piece: keep the original rather than blanking a link.
      if (!unit.ids.size || seen.size < unit.ids.size) {
        complete = false;
        continue;
      }
      text = "";
    }
    if (s.lead !== undefined) text = s.lead + text.trimStart();
    if (s.trail !== undefined) text = text.trimEnd() + s.trail;
    writeSlot(s, text);
  }
  return complete;
}

function writeSlot(slot, text) {
  slot.nodes.forEach((n, i) => {
    if (!n.isConnected) return;
    setText(n, i === 0 ? text : "", slot.srcs[i]);
  });
}

/** Put the original text back (show-original mode or disabling on a page). */
export function restoreAll() {
  for (const n of translatedNodes) {
    const r = records.get(n);
    if (r && n.nodeValue === r.tr) n.nodeValue = r.orig;
  }
}

export function reapplyAll() {
  for (const n of translatedNodes) {
    if (!n.isConnected) {
      translatedNodes.delete(n);
      continue;
    }
    const r = records.get(n);
    if (r && n.nodeValue === r.orig) n.nodeValue = r.tr;
  }
}
