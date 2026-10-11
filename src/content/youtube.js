// YouTube (isolated world): Spanish interface/region, a feed that only shows videos in
// your language (strict: if we can't tell, it's hidden), no Shorts, empty shelves
// collapsed, and a small notice about the audio/captions the player script chose.

import { getSettings, onSettingsChanged, isSiteDisabled } from "../shared/settings.js";
import { langInfo } from "../shared/langs.js";
import { guessLang } from "../shared/detect.js";

const api = globalThis.chrome ?? globalThis.browser;

// Outer containers first so hiding a home-grid item removes the whole cell.
// (Playlist pages aren't filtered: those are lists you made or chose.)
const OUTER = "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer, ytm-shorts-lockup-view-model-v2, ytm-video-with-context-renderer, ytm-compact-video-renderer";
const INNER = "yt-lockup-view-model, ytm-shorts-lockup-view-model";
const TITLE = [
  "h3[title]",
  "a#video-title",
  "#video-title",
  ".ytLockupMetadataViewModelTitle",
  ".yt-lockup-metadata-view-model__title",
  ".shortsLockupViewModelHostMetadataTitle",
  ".shortsLockupViewModelHostOutsideMetadataTitle",
  ".media-item-headline",
  ".YtmCompactMediaItemHeadline",
].join(", ");
const CHANNEL = 'a[href^="/@"], a[href^="/channel/"], ytd-channel-name';

const CSS = `
[data-esx-yt="hide"], html.esx-strict [data-esx-yt="pending"] { display: none !important; }
[data-esx-yt="pending"] { visibility: hidden !important; }
[data-esx-yt="dim"] { opacity: .28; filter: grayscale(1); transition: opacity .2s; }
[data-esx-yt="dim"]:hover { opacity: 1; filter: none; }

/* Strict: shelves, sections and rows left without a single visible video disappear. */
html.esx-strict ytd-rich-section-renderer:not(:has([data-esx-yt="show"])),
html.esx-strict ytd-rich-shelf-renderer:not(:has([data-esx-yt="show"])),
html.esx-strict ytd-shelf-renderer:not(:has([data-esx-yt="show"])),
html.esx-strict ytd-rich-grid-row:not(:has([data-esx-yt="show"])),
html.esx-strict ytd-horizontal-card-list-renderer { display: none !important; }

/* No Shorts: shelves, tiles, sidebar entries, channel tab, mobile tab bar. */
html.esx-noshorts ytd-rich-shelf-renderer[is-shorts],
html.esx-noshorts ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts]),
html.esx-noshorts ytd-reel-shelf-renderer,
html.esx-noshorts ytd-reel-item-renderer,
html.esx-noshorts grid-shelf-view-model:has(ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2),
html.esx-noshorts ytm-shorts-lockup-view-model-v2,
html.esx-noshorts ytm-shorts-lockup-view-model,
html.esx-noshorts ytd-rich-item-renderer:has(a[href^="/shorts/"]),
html.esx-noshorts ytd-video-renderer:has(a[href^="/shorts/"]),
html.esx-noshorts yt-lockup-view-model:has(a[href^="/shorts/"]),
html.esx-noshorts ytd-guide-entry-renderer:has(a[title="Shorts"]),
html.esx-noshorts ytd-mini-guide-entry-renderer[aria-label="Shorts"],
html.esx-noshorts ytd-mini-guide-entry-renderer:has(a[title="Shorts"]),
html.esx-noshorts yt-tab-shape[tab-title="Shorts"],
html.esx-noshorts [data-esx-shorts],
html.esx-noshorts ytm-reel-shelf-renderer,
html.esx-noshorts ytm-pivot-bar-item-renderer:has(.pivot-shorts) { display: none !important; }

#esx-yt-toast { position: fixed; z-index: 2147483647; top: 72px; right: 24px; max-width: 380px; padding: 10px 14px; border-radius: 10px;
  background: rgba(20,20,20,.92); color: #fff; font: 500 13px/1.4 "YouTube Sans", Roboto, system-ui, sans-serif;
  box-shadow: 0 6px 24px rgba(0,0,0,.35); opacity: 0; transform: translateY(-6px); transition: opacity .2s, transform .2s; pointer-events: none; }
#esx-yt-toast.on { opacity: 1; transform: none; }`;

let S = null;
let L = null;
let mo = null;
const detectQueue = new Map(); // title → [tiles]
let detectTimer = null;
const verdicts = new Map(); // title → "keep" | "drop" | "unknown"

// ---------- interface language & region (PREF cookie) ----------

function enforcePref() {
  const { hl, gl } = L.yt;
  const m = document.cookie.match(/(?:^|;\s*)PREF=([^;]*)/);
  const pairs = new URLSearchParams(m ? m[1] : "");
  if (pairs.get("hl") === hl && pairs.get("gl") === gl) return false;
  pairs.set("hl", hl);
  pairs.set("gl", gl);
  const value = [...pairs].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  document.cookie = `PREF=${value}; domain=.youtube.com; path=/; max-age=63072000; secure; samesite=lax`;
  try {
    // Reload once so YouTube renders in the new language; never loop.
    if (sessionStorage.getItem("esx-yt-pref") === `${hl}|${gl}`) return false;
    sessionStorage.setItem("esx-yt-pref", `${hl}|${gl}`);
  } catch {
    return false;
  }
  location.reload();
  return true;
}

// ---------- no Shorts ----------

function shortsToWatch() {
  const m = location.pathname.match(/^\/shorts\/([\w-]{6,})/);
  if (!m || !S.youtube.noShorts) return false;
  location.replace(`/watch?v=${m[1]}`);
  return true;
}

addEventListener("click", (e) => {
  if (!S?.youtube.noShorts) return;
  const a = e.target.closest?.('a[href^="/shorts/"]');
  const id = a?.getAttribute("href").match(/^\/shorts\/([\w-]{6,})/)?.[1];
  if (!id) return;
  e.preventDefault();
  e.stopPropagation();
  location.href = `/watch?v=${id}`;
}, true);
document.addEventListener("yt-navigate-finish", () => S && shortsToWatch());

// The "Shorts" filter chip on search/home has no attribute to select it by.
function markShortsChips(root) {
  for (const chip of root.querySelectorAll?.("yt-chip-cloud-chip-renderer, chip-view-model, ytm-chip-cloud-chip-renderer") ?? []) {
    if (chip.textContent.trim() === "Shorts") chip.setAttribute("data-esx-shorts", "");
  }
}

// ---------- feed filter ----------

function tileOf(el) {
  return el.closest(OUTER) ?? el.closest(INNER);
}

function textOf(el) {
  const src = globalThis.__esx?.sourceOf;
  let text = "";
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) text += src ? src(n) : n.nodeValue;
  return text.replace(/\s+/g, " ").trim();
}

function titleOf(tile) {
  const el = tile.querySelector(TITLE);
  if (!el) return "";
  // The title attribute is never translated by us, so it's the text YouTube sent.
  return el.getAttribute("title")?.trim() || textOf(el);
}

function setState(tile, state) {
  if (tile.getAttribute("data-esx-yt") === state) return;
  tile.setAttribute("data-esx-yt", state);
  if (state !== "pending") globalThis.__esx?.recheck(tile);
}

function decide(verdict) {
  const mode = S.youtube.filter;
  if (mode === "off" || verdict === "keep") return "show";
  return mode === "hide" ? "hide" : "dim"; // strict: "can't tell" is hidden too
}

function check(tile) {
  const title = titleOf(tile);
  if (!title) return;
  if (tile.dataset.esxYtTitle === title && tile.getAttribute("data-esx-yt") !== "pending") return;
  tile.dataset.esxYtTitle = title;
  if (S.youtube.filter === "off") return setState(tile, "show");
  const known = verdicts.get(title);
  if (known) return setState(tile, decide(known));
  let g = guessLang(title);
  if (!g.confident) {
    // The channel name often settles it ("Cocina con Ana").
    const channel = tile.querySelector(CHANNEL);
    if (channel) g = guessLang(`${title} ${textOf(channel)}`);
  }
  if (g.confident) {
    const v = g.lang === L.base ? "keep" : "drop";
    verdicts.set(title, v);
    return setState(tile, decide(v));
  }
  // Still unsure: ask Chrome's language detector in the background (a few ms).
  setState(tile, "pending");
  if (!detectQueue.has(title)) detectQueue.set(title, []);
  detectQueue.get(title).push(tile);
  detectTimer ??= setTimeout(runDetect, 30);
}

async function runDetect() {
  detectTimer = null;
  const batch = [...detectQueue];
  detectQueue.clear();
  let res = [];
  try {
    res = await api.runtime.sendMessage({ t: "detect", texts: batch.map(([t]) => t) });
  } catch {}
  batch.forEach(([title, tiles], i) => {
    const top = res?.[i]?.[0];
    let v = "unknown";
    if (top && top[0] !== "und") {
      const lang = top[0].split("-")[0];
      // Thresholds from bench/eval-langdetector.mjs.
      if (lang === L.base && top[1] >= 0.3) v = "keep";
      else if (lang !== L.base && top[1] >= 0.97) v = "drop";
    }
    verdicts.set(title, v);
    for (const tile of tiles) if (tile.dataset.esxYtTitle === title) setState(tile, decide(v));
  });
  homeHint();
}

function scanTiles(root) {
  if (root.nodeType !== 1) return;
  if (root.matches(TITLE) || root.matches(OUTER) || root.matches(INNER)) {
    const t = tileOf(root) ?? root;
    if (t.matches(OUTER) || t.matches(INNER)) check(t);
  }
  for (const el of root.querySelectorAll(TITLE)) {
    const t = tileOf(el);
    if (t) check(t);
  }
  markShortsChips(root);
}

// If your home feed has nothing in your language yet, say why instead of a blank page.
let hinted = false;
function homeHint() {
  if (hinted || location.pathname !== "/" || S.youtube.filter !== "hide") return;
  const tiles = document.querySelectorAll("ytd-rich-item-renderer[data-esx-yt]");
  const shown = document.querySelectorAll('ytd-rich-item-renderer[data-esx-yt="show"]').length;
  if (tiles.length < 20 || shown > 3) return;
  hinted = true;
  toast(`Tu inicio casi no tiene vídeos en ${L.label.split(" (")[0].toLowerCase()} todavía. Busca y mira algunos, y YouTube te recomendará más.`, 9000);
}

function startFilter() {
  document.documentElement.classList.toggle("esx-strict", S.youtube.filter === "hide");
  document.documentElement.classList.toggle("esx-noshorts", S.youtube.noShorts);
  scanTiles(document.documentElement);
  mo = new MutationObserver((recs) => {
    for (const r of recs) {
      const target = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      if (!target) continue;
      // YouTube recycles tiles: a changed title inside an existing tile counts too.
      const t = tileOf(target);
      if (t) check(t);
      for (const n of r.addedNodes) if (n.nodeType === 1) scanTiles(n);
    }
    homeHint();
  });
  mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["title"] });
}

function stopFilter() {
  mo?.disconnect();
  mo = null;
  document.documentElement.classList.remove("esx-strict", "esx-noshorts");
  for (const t of document.querySelectorAll("[data-esx-yt]")) t.removeAttribute("data-esx-yt");
}

// ---------- notice from the player script ----------

const NAMES = { es: "español", en: "inglés", fr: "francés", de: "alemán", it: "italiano", pt: "portugués", ja: "japonés", ko: "coreano", zh: "chino", ru: "ruso", hi: "hindi", ar: "árabe" };
const name = (l) => NAMES[l?.split("-")[0]] ?? l ?? "desconocido";

addEventListener("esx-yt-info", (e) => {
  let d = {};
  try {
    d = JSON.parse(e.detail);
  } catch {}
  let msg;
  if (d.audio === L?.base) msg = `🔊 Audio en ${name(d.audio)}${d.dubbed ? " (doblado)" : ""}`;
  else msg = `🔊 Audio original en ${name(d.orig)}`;
  if (d.captions) msg += ` · CC ${name(d.captions)}${d.autoTranslated ? " (traducción automática)" : ""}`;
  toast(msg);
});

let toastEl = null;
let toastTimer = null;
function toast(text, ms = 4000) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.id = "esx-yt-toast";
    toastEl.setAttribute("data-esx", "");
    document.documentElement.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("on"), ms);
}

// ---------- wiring ----------

function publishConfig() {
  const on = S.enabled && !isSiteDisabled(S, location.hostname);
  if (on) document.documentElement.setAttribute("data-esx-yt-cfg", JSON.stringify({ base: L.base, code: L.code, audio: S.youtube.audio, captions: S.youtube.captions }));
  else document.documentElement.removeAttribute("data-esx-yt-cfg");
  return on;
}

async function main() {
  S = await getSettings();
  L = langInfo(S.lang);
  if (!publishConfig()) return;
  if (shortsToWatch()) return;
  if (S.nativeFirst && enforcePref()) return;
  const style = document.createElement("style");
  style.setAttribute("data-esx", "");
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);
  // Classes go on before the page renders, so Shorts and pending tiles never flash.
  document.documentElement.classList.toggle("esx-strict", S.youtube.filter === "hide");
  document.documentElement.classList.toggle("esx-noshorts", S.youtube.noShorts);
  if (document.readyState === "loading") await new Promise((r) => addEventListener("DOMContentLoaded", r, { once: true }));
  startFilter();
}

onSettingsChanged((s) => {
  S = s;
  L = langInfo(s.lang);
  const on = publishConfig();
  verdicts.clear();
  stopFilter();
  if (on) startFilter();
});

main();
