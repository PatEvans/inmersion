// Content script, every frame, document_start. Finds the text you can see (plus about a
// screen ahead), gets it translated, writes it back in place, and keeps up with pages
// that change. Hold ⌥/Alt to peek at the original.

import { scan, applyTranslation, sourceOf, records, restoreAll, reapplyAll, blockOf, isInlineTag, isExcluded } from "./segment.js";
import { stripMarkup } from "../shared/markup.js";
import { getSettings, onSettingsChanged, isSiteDisabled } from "../shared/settings.js";
import { langInfo } from "../shared/langs.js";
import { guessLang } from "../shared/detect.js";

const api = globalThis.chrome ?? globalThis.browser;
const TOP = window === window.top;
const PREFETCH = "100% 0px 150% 0px"; // a screen above, a screen and a half below
const LETTER = /\p{L}/u;
// While a translation is on its way the original text is invisible: a soft shimmer marks
// where it will appear, and a small spinner shows in the corner if you're waiting on it.
const STYLE = `html.esx-wait body{opacity:0!important}
.esx-pending,.esx-pending *{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}
.esx-pending{background-image:linear-gradient(90deg,rgba(128,128,128,.08) 30%,rgba(128,128,128,.2) 50%,rgba(128,128,128,.08) 70%)!important;
  background-size:300% 100%!important;animation:esx-shimmer 1.4s ease-in-out infinite!important;border-radius:4px}
@keyframes esx-shimmer{from{background-position:100% 0}to{background-position:0 0}}
#esx-spinner{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:18px;height:18px;border-radius:50%;
  border:2px solid rgba(240,116,58,.25);border-top-color:#f0743a;animation:esx-spin .75s linear infinite;
  opacity:0;transition:opacity .2s;pointer-events:none}
#esx-spinner.on{opacity:1}
@keyframes esx-spin{to{transform:rotate(360deg)}}`;

let S = null;
let L = null;
let running = false;
let pageLang = "und";
let langReady = Promise.resolve();
let initialPhase = true;
const pendingUnits = new Set();
let port = null;
let io = null;
let mo = null;

const results = new Map(); // source → translation
const waiting = new Map(); // source → Set(unit)
const inflight = new Map(); // message id → { source, src }
const failed = new Set(); // sources the engines couldn't translate (don't retry endlessly)
const queue = new Set();
const deferred = new Set(); // units waiting for the YouTube filter's verdict
const anchorUnits = new WeakMap(); // element → Set(unit)
const containerUnits = new WeakMap(); // container → unit[]
const attrUnits = new WeakMap(); // element → { name: unit }
const attrRecords = new WeakMap(); // element → { name: {orig, tr} }
const attrEls = new Set();
const observedEls = new WeakSet();
const observedRoots = new WeakSet();
const intersecting = new WeakSet();
const carousels = new WeakSet(); // horizontally scrolling lists whose cards we prefetch
let titleRec = null;
let nextId = 1;
let flushTimer = null;

// ---------- startup ----------

let styleEl = null;
function earlyHide() {
  styleEl = document.createElement("style");
  styleEl.setAttribute("data-esx", "");
  styleEl.textContent = STYLE;
  (document.head || document.documentElement).appendChild(styleEl);
  if (TOP) {
    document.documentElement.classList.add("esx-wait");
    setTimeout(reveal, 1200); // never keep a page hidden for long
  }
}
const reveal = () => document.documentElement.classList.remove("esx-wait");

const domReady = () =>
  document.readyState === "loading" ? new Promise((r) => addEventListener("DOMContentLoaded", r, { once: true })) : Promise.resolve();

async function start() {
  earlyHide();
  try {
    S = await getSettings();
  } catch {
    return reveal();
  }
  if (!S.enabled || isSiteDisabled(S, location.hostname)) return reveal();
  if (!S.antiFlash) reveal();
  L = langInfo(S.lang);
  await domReady();
  try {
    if (TOP && S.nativeFirst && nativeRedirect()) return;
    begin();
  } catch (e) {
    reveal();
    console.warn("[Inmersión] could not start on this page:", e);
  }
}

function begin() {
  running = true;
  initialPhase = true;
  setTimeout(() => (initialPhase = false), 2500);
  io = new IntersectionObserver(onIntersect, { rootMargin: PREFETCH });
  mo = new MutationObserver(onMutations);
  observeRoot(document);
  const root = document.body ?? document.documentElement;
  let resolveLang;
  langReady = new Promise((r) => (resolveLang = r));
  const initial = rescan(root);
  detectPageLang(initial).then((l) => {
    pageLang = l;
    if (l === L.base) reveal(); // already in the target language: nothing to hide
    resolveLang();
  });
  if (TOP) translateTitle();
}

function stop() {
  running = false;
  io?.disconnect();
  mo?.disconnect();
  restoreAll();
  for (const el of attrEls) {
    const recs = attrRecords.get(el) ?? {};
    for (const [name, r] of Object.entries(recs)) if (el.getAttribute(name) === r.tr) el.setAttribute(name, r.orig);
  }
  if (titleRec && document.title === titleRec.tr) document.title = titleRec.orig;
  for (const el of document.querySelectorAll(".esx-pending")) el.classList.remove("esx-pending");
  pendingUnits.clear();
  spinnerEl?.classList.remove("on");
  results.clear();
  waiting.clear();
  inflight.clear();
  failed.clear();
  queue.clear();
  deferred.clear();
  attrEls.clear();
  titleRec = null;
  reveal();
}

// ---------- "native first": jump to the site's own Spanish version ----------

function nativeRedirect() {
  if ((document.documentElement.lang || "").toLowerCase().startsWith(L.base)) return false;
  const want = (h) => h.toLowerCase();
  const alts = [...document.querySelectorAll('link[rel~="alternate"][hreflang]')];
  const pick =
    alts.find((a) => want(a.hreflang) === L.code.toLowerCase()) ??
    alts.find((a) => want(a.hreflang) === L.base) ??
    alts.find((a) => want(a.hreflang).startsWith(L.base + "-"));
  let href = pick?.href ?? null;
  if (!href && /\.wikipedia\.org$/.test(location.hostname) && !location.hostname.startsWith(L.base + ".")) {
    href = document.querySelector(`a.interlanguage-link-target[hreflang="${L.base}"], li.interwiki-${L.base} a`)?.href ?? null;
  }
  if (!href || !/^https?:/.test(href) || href.split("#")[0] === location.href.split("#")[0]) return false;
  try {
    const key = "esx-native:" + location.href;
    if (sessionStorage.getItem(key)) return false; // you came back on purpose
    sessionStorage.setItem(key, "1");
  } catch {
    return false;
  }
  location.replace(href);
  return true;
}

// ---------- page language ----------

async function detectPageLang(units) {
  const htmlLang = (document.documentElement.lang || "").toLowerCase().split(/[-_]/)[0];
  const samples = [];
  for (const u of units) {
    const t = stripMarkup(u.source);
    if (t.length > 80) samples.push(t);
  }
  samples.sort((a, b) => b.length - a.length);
  const top = samples.slice(0, 6);
  const votes = {};
  if (top.length && api.i18n?.detectLanguage) {
    await Promise.all(top.map(async (t) => {
      try {
        const r = await api.i18n.detectLanguage(t.slice(0, 500));
        if (r?.isReliable && r.languages?.[0]) {
          const l = r.languages[0].language.split("-")[0];
          votes[l] = (votes[l] ?? 0) + t.length;
        }
      } catch {}
    }));
  }
  if (!Object.keys(votes).length && top.length) {
    const g = guessLang(top.join(" ").slice(0, 2000));
    if (g.lang) votes[g.lang] = 1;
  }
  const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0];
  return best ?? (htmlLang || "und");
}

/** false = already in the target language; otherwise the source language to send. */
async function sourceLang(u) {
  const text = (u.plainText ??= stripMarkup(u.source));
  if (text.length >= 60 && api.i18n?.detectLanguage) {
    try {
      const r = await api.i18n.detectLanguage(text.slice(0, 500));
      if (r?.isReliable && r.languages?.length) {
        const l = r.languages[0].language.split("-")[0];
        return l === L.base ? false : l;
      }
    } catch {}
  }
  const g = guessLang(text);
  if (g.confident) return g.lang === L.base ? false : g.lang;
  if (pageLang === L.base) return false;
  return pageLang !== "und" ? pageLang : "en";
}

// ---------- scanning ----------

function observeRoot(root) {
  if (observedRoots.has(root)) return;
  observedRoots.add(root);
  mo.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["placeholder", "title", "value"] });
}

function rescan(root) {
  if (!root) return [];
  const fresh = new Map();
  scan(root, (u) => {
    if (!fresh.has(u.container)) fresh.set(u.container, []);
    fresh.get(u.container).push(u);
  }, observeRoot);
  if (!fresh.has(root)) fresh.set(root, []);
  for (const [c, us] of fresh) {
    for (const old of containerUnits.get(c) ?? []) kill(old);
    containerUnits.set(c, us);
    for (const u of us) register(u);
  }
  scanAttrs(root);
  return [...fresh.values()].flat();
}

function register(u) {
  const el = u.anchor;
  if (!el) return;
  let set = anchorUnits.get(el);
  if (!set) anchorUnits.set(el, (set = new Set()));
  set.add(u);
  if (!observedEls.has(el)) {
    observedEls.add(el);
    io.observe(el);
  } else if (intersecting.has(el)) enqueue(u);
  // A card added to a carousel that's already on screen: translate it before it slides in.
  const list = el.closest?.('ul, ol, [role="list"]');
  if (list && carousels.has(list)) enqueue(u);
}

// Carousel cards scrolled out sideways are clipped, so they never count as visible until
// you swipe to them. When one card is visible, prefetch the whole row.
const checkedLists = new WeakSet();
function prefetchCarousel(el) {
  const list = el.closest?.('ul, ol, [role="list"]');
  if (!list || checkedLists.has(list)) return;
  checkedLists.add(list);
  let scrolls = false;
  for (let p = list, i = 0; p && i < 4 && !scrolls; p = p.parentElement, i++) scrolls = p.scrollWidth > p.clientWidth + 40;
  if (!scrolls) return;
  carousels.add(list);
  for (const child of list.querySelectorAll("*")) {
    for (const u of anchorUnits.get(child) ?? []) {
      u.top ??= innerHeight;
      enqueue(u);
    }
  }
}

function kill(u) {
  u.dead = true;
  anchorUnits.get(u.anchor)?.delete(u);
  unmarkPending(u);
}

function scanAttrs(root) {
  if (!root.querySelectorAll) return;
  const els = root.querySelectorAll("[placeholder],[title],input[type=submit],input[type=button],input[type=reset]");
  for (const el of root.nodeType === 1 ? [root, ...els] : els) {
    if (isExcluded(el)) continue;
    for (const name of ["placeholder", "title", "value"]) {
      if (!el.hasAttribute(name)) continue;
      if (name === "value" && !(el.localName === "input" && /^(submit|button|reset)$/.test(el.type))) continue;
      // Tooltips only where they're the only label (icon buttons); link titles are noise.
      if (name === "title" && el.textContent.trim()) continue;
      const v = el.getAttribute(name);
      const r = attrRecords.get(el)?.[name];
      const src = (r && (v === r.tr || v === r.orig) ? r.orig : v).trim();
      if (!src || !LETTER.test(src) || src.length > 300) continue;
      const units = attrUnits.get(el) ?? {};
      if (units[name] && !units[name].dead && units[name].source === src) continue;
      if (units[name]) kill(units[name]);
      units[name] = { attr: name, el, anchor: el, source: src, plain: true };
      attrUnits.set(el, units);
      register(units[name]);
    }
  }
}

// ---------- visibility ----------

function onIntersect(entries) {
  for (const e of entries) {
    const el = e.target;
    if (!e.isIntersecting) {
      intersecting.delete(el);
      continue;
    }
    intersecting.add(el);
    const r = e.boundingClientRect;
    // Hidden 1px "screen reader only" text intersects too; skip it.
    if (r.width <= 1 && r.height <= 1) continue;
    const inView = r.bottom > 0 && r.top < innerHeight;
    for (const u of anchorUnits.get(el) ?? []) {
      u.inView = inView;
      u.top = r.top;
      u.height = r.height;
      enqueue(u);
    }
    prefetchCarousel(el);
  }
}

function enqueue(u) {
  if (!running || u.dead || u.queued || failed.has(u.source)) return;
  const done = results.get(u.source);
  if (done !== undefined) {
    if (!u.applied) apply(u, done);
    return;
  }
  if (waiting.get(u.source)?.has(u)) return;
  u.queued = true;
  queue.add(u);
  flushTimer ??= setTimeout(flush, 16);
}

function ytGate(u) {
  const tile = u.anchor?.closest?.("[data-esx-yt]");
  if (!tile) return "go";
  const v = tile.getAttribute("data-esx-yt");
  return v === "pending" ? "wait" : v === "hide" ? "skip" : "go";
}

async function flush() {
  flushTimer = null;
  await langReady;
  const units = [...queue].sort((a, b) => (b.inView ?? 0) - (a.inView ?? 0) || (a.top ?? 0) - (b.top ?? 0));
  queue.clear();
  const live = [];
  for (const u of units) {
    u.queued = false;
    if (u.dead || (u.anchor && !u.anchor.isConnected)) continue;
    const gate = ytGate(u);
    if (gate === "wait") deferred.add(u);
    else if (gate === "go") live.push(u);
  }
  const langs = await Promise.all(live.map((u) => (results.has(u.source) ? null : sourceLang(u))));
  const items = [];
  live.forEach((u, i) => {
    const done = results.get(u.source);
    if (done !== undefined) return apply(u, done);
    const from = langs[i];
    if (!from) return void (u.native = true);
    const set = waiting.get(u.source);
    if (set) {
      set.add(u); // same text already on its way (e.g. a repeated "Sign in")
      if (S.antiFlash) markPending(u);
      return;
    }
    waiting.set(u.source, new Set([u]));
    const id = nextId++;
    inflight.set(id, { source: u.source, src: from });
    items.push({ k: id, s: u.source, src: from });
    if (S.antiFlash) markPending(u);
  });
  if (items.length) send(items);
  // First batch is marked pending (invisible) — now the page itself can show.
  if (initialPhase) reveal();
}

// ---------- background connection ----------

function send(items) {
  try {
    ensurePort().postMessage({ t: "tr", items, ctx: { url: location.href, title: titleRec?.orig ?? document.title } });
  } catch {
    stop(); // the extension was reloaded; this old content script is orphaned
  }
}

function ensurePort() {
  if (port) return port;
  port = api.runtime.connect({ name: "esx" });
  port.onMessage.addListener(onResult);
  port.onDisconnect.addListener(() => {
    port = null;
    if (!running || !api.runtime?.id) return;
    // The service worker restarted mid-request: ask again.
    const again = [...inflight].map(([k, v]) => ({ k, s: v.source, src: v.src }));
    if (again.length) setTimeout(() => send(again), 200);
  });
  return port;
}

function onResult(msg) {
  const entry = inflight.get(msg.k);
  if (!entry) return;
  inflight.delete(msg.k);
  if (msg.lang !== S.lang) return;
  const set = waiting.get(entry.source);
  waiting.delete(entry.source);
  if (msg.t === "res") {
    results.set(entry.source, msg.r);
    for (const u of set ?? []) apply(u, msg.r);
  } else {
    failed.add(entry.source);
    for (const u of set ?? []) unmarkPending(u);
  }
}

// ---------- writing translations ----------

function apply(u, text) {
  if (u.dead) return;
  if (u.attr) {
    const recs = attrRecords.get(u.el) ?? {};
    recs[u.attr] = { orig: u.source, tr: text };
    attrRecords.set(u.el, recs);
    attrEls.add(u.el);
    u.el.setAttribute(u.attr, text);
  } else if (u.kind === "title") {
    titleRec = { orig: u.source, tr: text };
    document.title = text;
  } else {
    applyTranslation(u, text);
  }
  u.applied = true;
  unmarkPending(u);
}

function markPending(u) {
  const el = u.anchor;
  if (u.attr || !el?.classList || u.pending) return;
  // Never blank out a whole page section for one stray piece of text.
  if (el === document.body || el === document.documentElement || (u.height ?? 0) > innerHeight * 0.6) return;
  u.pending = true;
  pendingUnits.add(u);
  el.classList.add("esx-pending");
  setTimeout(() => unmarkPending(u), 6000); // something's wrong: show the original after all
  spinnerSoon();
}

function unmarkPending(u) {
  if (!u.pending) return;
  u.pending = false;
  pendingUnits.delete(u);
  const others = [...(anchorUnits.get(u.anchor) ?? [])].some((x) => x !== u && x.pending);
  if (!others) u.anchor.classList.remove("esx-pending");
}

// The spinner only shows when something you can actually see is still loading, and not
// for cache hits that resolve within a couple of frames.
let spinnerEl = null;
let spinnerTimer = null;
function spinnerSoon() {
  if (!TOP) return;
  spinnerTimer ??= setTimeout(updateSpinner, 150);
}
function updateSpinner() {
  spinnerTimer = null;
  let waiting = false;
  for (const u of pendingUnits) {
    if (!u.anchor?.isConnected) continue;
    const r = u.anchor.getBoundingClientRect();
    if (r.bottom > 0 && r.top < innerHeight && r.width > 1) {
      waiting = true;
      break;
    }
  }
  if (waiting && !spinnerEl) {
    spinnerEl = document.createElement("div");
    spinnerEl.id = "esx-spinner";
    spinnerEl.setAttribute("data-esx", "");
    spinnerEl.setAttribute("aria-hidden", "true");
    document.documentElement.appendChild(spinnerEl);
  }
  spinnerEl?.classList.toggle("on", waiting);
  if (pendingUnits.size) spinnerTimer = setTimeout(updateSpinner, 250);
}

// ---------- page changes ----------

const dirty = new Set();
let dirtyTimer = null;

function onMutations(recs) {
  if (!running) return;
  for (const r of recs) {
    if (r.type === "characterData") {
      const n = r.target;
      const rec = records.get(n);
      if (rec && (n.nodeValue === rec.tr || n.nodeValue === rec.orig)) continue; // our own write
      if (n.parentNode?.localName === "title") titleChanged();
      else markDirty(blockOf(n));
    } else if (r.type === "childList") {
      if (r.target.localName === "title") {
        titleChanged();
        continue;
      }
      for (const n of r.addedNodes) {
        if (n.nodeType === 3) markDirty(blockOf(r.target));
        else if (n.nodeType === 1 && !n.hasAttribute("data-esx")) markDirty(isInlineTag(n.localName) ? blockOf(r.target) : n);
      }
    } else if (r.type === "attributes") {
      const rec = attrRecords.get(r.target)?.[r.attributeName];
      if (rec && r.target.getAttribute(r.attributeName) === rec.tr) continue;
      markDirty(r.target);
    }
  }
}

function markDirty(root) {
  if (!root || root === document) root = document.body;
  if (!root) return;
  dirty.add(root);
  dirtyTimer ??= setTimeout(processDirty, 40);
}

function processDirty() {
  dirtyTimer = null;
  const roots = [...dirty];
  dirty.clear();
  const set = new Set(roots);
  for (const r of roots) {
    if (!r.isConnected) continue;
    let covered = false;
    for (let p = r.parentNode; p && !covered; p = p.parentNode ?? p.host) covered = set.has(p);
    if (!covered) rescan(r);
  }
}

function titleChanged() {
  if (!TOP || (titleRec && document.title === titleRec.tr)) return;
  translateTitle();
}

function translateTitle() {
  const src = titleRec && document.title === titleRec.tr ? titleRec.orig : document.title;
  if (!src || !LETTER.test(src)) return;
  enqueue({ kind: "title", source: src.trim(), plain: true, inView: true, top: -1 });
}

// ---------- peek at the original: hold ⌥ / Alt ----------

let altTimer = null;
let peeking = false;
addEventListener("keydown", (e) => {
  if (e.key === "Alt" && !e.repeat) {
    altTimer = setTimeout(() => {
      if (!running) return;
      peeking = true;
      mo?.disconnect();
      restoreAll();
      for (const el of attrEls) for (const [n, r] of Object.entries(attrRecords.get(el) ?? {})) el.setAttribute(n, r.orig);
      if (titleRec) document.title = titleRec.orig;
    }, 150);
  } else clearTimeout(altTimer);
}, true);
const unpeek = () => {
  clearTimeout(altTimer);
  if (!peeking) return;
  peeking = false;
  reapplyAll();
  for (const el of attrEls) for (const [n, r] of Object.entries(attrRecords.get(el) ?? {})) el.setAttribute(n, r.tr);
  if (titleRec) document.title = titleRec.tr;
  if (running) observeAgain();
};
addEventListener("keyup", (e) => e.key === "Alt" && unpeek(), true);
addEventListener("blur", unpeek);

function observeAgain() {
  const roots = [document];
  for (const el of document.querySelectorAll("*")) if (el.shadowRoot) roots.push(el.shadowRoot);
  for (const r of roots) mo.observe(r, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["placeholder", "title", "value"] });
}

// ---------- settings changes & hooks for the YouTube filter ----------

onSettingsChanged((s) => {
  const prevLang = S?.lang;
  S = s;
  const off = !s.enabled || isSiteDisabled(s, location.hostname);
  if (off) {
    if (running) stop();
    return;
  }
  L = langInfo(s.lang);
  if (!running) begin();
  else if (s.lang !== prevLang) {
    stop();
    begin();
  }
});

globalThis.__esx = {
  sourceOf,
  lang: () => L,
  running: () => running,
  recheck(tile) {
    for (const u of deferred) {
      if (u.dead || !u.anchor || !tile.contains(u.anchor)) continue;
      deferred.delete(u);
      enqueue(u);
    }
  },
};

if (api?.runtime?.id) start();
