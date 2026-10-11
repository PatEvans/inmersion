// Background service worker: owns the translation queue, both engines, the cache,
// spend tracking, and the "ask sites for Spanish first" network settings.

import Anthropic from "@anthropic-ai/sdk";
import { translateWithClaude, chunkTexts } from "../shared/claude.js";
import { langInfo, LANGS } from "../shared/langs.js";
import { DEFAULTS, getSettings, saveSettings, onSettingsChanged, siteKey } from "../shared/settings.js";
import * as cache from "./cache.js";
import * as usage from "./usage.js";
import { localAvailable, localStatus, localTranslate, prepareLocal } from "./local.js";
import { splitForPlainEngine, tagStructure } from "../shared/markup.js";
import { googleAvailable, googleTranslate } from "./google.js";

const api = globalThis.chrome ?? globalThis.browser;
// On screen now → tiny batches, many in parallel (first screen ~1.5 s instead of ~2.4 s,
// bench/haiku.mjs --chunk). Prefetch → normal batches with more page context.
const CONCURRENCY = 24;
const URGENT = { maxChars: 250, maxUnits: 8 };

// Service workers can't use top-level await: start with defaults, swap in stored settings.
let settings = DEFAULTS;
const ready = getSettings().then((s) => (settings = s));
onSettingsChanged((s) => {
  const langChanged = s.lang !== settings.lang || s.nativeFirst !== settings.nativeFirst || s.enabled !== settings.enabled;
  settings = s;
  if (langChanged) applyNetworkSettings();
  updateBadge();
});

// ---------- Spanish first: Accept-Language + navigator.language ----------

async function applyNetworkSettings() {
  await ready;
  const on = settings.enabled && settings.nativeFirst;
  const L = langInfo(settings.lang);
  if (api.declarativeNetRequest) {
    await api.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1],
      addRules: on
        ? [{
            id: 1,
            priority: 1,
            action: { type: "modifyHeaders", requestHeaders: [{ header: "accept-language", operation: "set", value: L.accept }] },
            condition: { resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest"], excludedRequestDomains: ["api.anthropic.com"] },
          }]
        : [],
    }).catch((e) => console.warn("DNR", e));
  }
  if (api.scripting?.registerContentScripts) {
    await api.scripting.unregisterContentScripts({ ids: ["navlang"] }).catch(() => {});
    if (on && LANGS[settings.lang]) {
      await api.scripting.registerContentScripts([{
        id: "navlang",
        js: [`navlang/${settings.lang}.js`],
        matches: ["<all_urls>"],
        runAt: "document_start",
        world: "MAIN",
        allFrames: true,
        persistAcrossSessions: true,
      }]).catch((e) => console.warn("navlang", e));
    }
  }
}

async function updateBadge() {
  if (!api.action) return;
  await ready;
  const spent = await usage.spentToday();
  const over = settings.engine === "claude" && spent >= settings.dailyBudget;
  await api.action.setBadgeText({ text: settings.enabled ? langInfo(settings.lang).base.toUpperCase() : "" });
  await api.action.setBadgeBackgroundColor({ color: over ? "#b45309" : "#c2410c" });
}

api.runtime.onInstalled.addListener(async ({ reason }) => {
  await applyNetworkSettings();
  updateBadge();
  if (reason === "install") api.tabs.create({ url: api.runtime.getURL("options.html?welcome=1") });
});
api.runtime.onStartup?.addListener(() => {
  applyNetworkSettings();
  updateBadge();
});

// ---------- Claude client ----------

let client = null;
let clientFor = "";
function claudeClient() {
  const id = `${settings.apiKey}|${settings.workspaceId}`;
  if (!client || clientFor !== id) {
    client = new Anthropic({
      apiKey: settings.apiKey,
      dangerouslyAllowBrowser: true, // personal extension: the key stays in this browser's storage
      maxRetries: 2,
      timeout: 60_000,
      defaultHeaders: settings.workspaceId ? { "anthropic-workspace-id": settings.workspaceId } : undefined,
    });
    clientFor = id;
  }
  return client;
}

async function useClaude() {
  if (settings.engine !== "claude" || !settings.apiKey) return false;
  return (await usage.spentToday()) < settings.dailyBudget;
}

// Haiku when it can be used; else Google's free endpoint (unless you chose Chrome only, or
// Google is backing us off); else Chrome's on-device translator.
async function pickEngine() {
  if (await useClaude()) return "c";
  return settings.engine !== "local" && googleAvailable() ? "g" : "l";
}

// Same order when an engine fails mid-request.
function runFallback(jobs) {
  if (!jobs.length) return;
  if (settings.engine !== "local" && googleAvailable()) runGoogle(jobs);
  else runLocal(jobs);
}

// ---------- Translation scheduling ----------

// cacheKey → { source, from, lang, engine, ctx, waiters: [{port, k}] }
const inflight = new Map();
let claudeQueue = [];
let claudeTimer = null;
let running = 0;
const chunkQueue = [];
let localChain = Promise.resolve();
let googleQueue = [];
let googleTimer = null;

function deliver(job, text) {
  for (const w of job.waiters) {
    try {
      w.port.postMessage({ t: "res", k: w.k, r: text, lang: job.lang });
    } catch {}
  }
}

function fail(job, reason) {
  for (const w of job.waiters) {
    try {
      w.port.postMessage({ t: "fail", k: w.k, reason, lang: job.lang });
    } catch {}
  }
}

async function handleTranslate(port, items, ctx) {
  await ready;
  const lang = settings.lang;
  const engine = await pickEngine();
  // A Claude translation is always good to reuse, even when we're on the local engine.
  const usable = { c: ["c"], g: ["c", "g"], l: ["c", "g", "l"] }[engine];
  const keysFor = (s) => usable.map((e) => cache.cacheKey(lang, e, s));
  const hits = await cache.getMany(items.flatMap((it) => keysFor(it.s)));
  let cachedChars = 0;
  for (const it of items) {
    const hit = keysFor(it.s).map((k) => hits.get(k)).find((v) => v !== undefined);
    if (hit !== undefined) {
      cachedChars += it.s.length;
      port.postMessage({ t: "res", k: it.k, r: hit, lang });
      continue;
    }
    const key = cache.cacheKey(lang, engine, it.s);
    const existing = inflight.get(key);
    if (existing) {
      existing.waiters.push({ port, k: it.k });
      continue;
    }
    const job = { key, source: it.s, from: it.src || "en", lang, engine, ctx, pre: it.b ?? "", post: it.a ?? "", urgent: !!it.v, waiters: [{ port, k: it.k }] };
    inflight.set(key, job);
    if (engine === "c") claudeQueue.push(job);
    else if (engine === "g") googleQueue.push(job);
    else runLocal([job]);
  }
  if (cachedChars) usage.record({ cached: cachedChars });
  if (claudeQueue.length) claudeTimer ??= setTimeout(flushClaude, 15);
  if (googleQueue.length) googleTimer ??= setTimeout(flushGoogle, 15);
}

function flushClaude() {
  claudeTimer = null;
  const jobs = claudeQueue;
  claudeQueue = [];
  // Keep each request to one page so the model gets that page as context.
  const byPage = new Map();
  for (const j of jobs) {
    const p = j.ctx?.url ?? "";
    if (!byPage.has(p)) byPage.set(p, []);
    byPage.get(p).push(j);
  }
  for (const pageJobs of byPage.values()) {
    const size = (j) => j.source.length;
    const urgent = chunkTexts(pageJobs.filter((j) => j.urgent), { size, ...URGENT });
    chunkQueue.unshift(...urgent); // what you're looking at goes first
    for (const chunk of chunkTexts(pageJobs.filter((j) => !j.urgent), { size })) chunkQueue.push(chunk);
  }
  pump();
}

function pump() {
  while (running < CONCURRENCY && chunkQueue.length) {
    const chunk = chunkQueue.shift();
    running++;
    runClaude(chunk).finally(() => {
      running--;
      pump();
    });
  }
}

// The markers (<1>…</1>) must come back with the same nesting, or links and formatting
// would get the wrong text. Haiku very occasionally drops, merges or moves one.
const tagsMatch = (a, b) => tagStructure(a) === tagStructure(b);

// Cached under the engine that actually produced it, so a fallback translation is never
// later served as a Haiku one.
function finish(job, text, engine = "c") {
  cache.put(cache.cacheKey(job.lang, engine, job.source), text);
  inflight.delete(job.key);
  deliver(job, text);
}

function recordClaude(r, chars) {
  usage.record({
    cost: r.cost,
    in: r.usage.input_tokens ?? 0,
    out: r.usage.output_tokens ?? 0,
    cacheRead: r.usage.cache_read_input_tokens ?? 0,
    cacheWrite: r.usage.cache_creation_input_tokens ?? 0,
    requests: 1,
    chars,
  });
}

// attempt 0: normal; attempt 1: lines that came back missing or with broken markers.
async function runClaude(chunk, attempt = 0) {
  const lang = chunk[0].lang;
  const broken = [];
  try {
    const r = await translateWithClaude(claudeClient(), {
      texts: chunk.map((j) => j.source),
      ctx: { ...chunk[0].ctx, before: chunk[0].pre, after: chunk.at(-1).post },
      lang,
      model: settings.model,
      onResult: (i, text) => {
        const job = chunk[i];
        if (tagsMatch(job.source, text)) finish(job, text);
        else broken.push(job);
      },
    });
    recordClaude(r, chunk.reduce((s, j) => s + j.source.length, 0));
    if (settings.keyError) saveSettings({ keyError: "" });
    const redo = [...r.missing.map((i) => chunk[i]), ...broken];
    if (redo.length) {
      if (r.stop === "refusal") runFallback(redo);
      else if (attempt === 0) runClaude(redo, 1); // a fresh attempt almost always fixes it
      else runClaudePieces(redo);
    }
    updateBadge();
  } catch (e) {
    const status = e?.status;
    if (status === 401 || status === 403 || status === 400) {
      saveSettings({ keyError: `${status}: ${e?.error?.error?.message ?? e.message}`.slice(0, 200) });
    }
    console.warn("Claude engine failed, falling back", status, e?.message);
    runFallback(chunk.filter((j) => inflight.has(j.key)));
  }
}

// Last resort: translate only the text between the markers, one piece per line, and put
// it back around the original markers, so the structure can't break.
async function runClaudePieces(jobs) {
  const splits = jobs.map((j) => splitForPlainEngine(j.source));
  const texts = splits.flatMap((x) => x.pieces);
  const out = new Array(texts.length);
  try {
    const r = await translateWithClaude(claudeClient(), {
      texts,
      ctx: { ...jobs[0].ctx, before: jobs[0].pre, after: jobs.at(-1).post },
      lang: jobs[0].lang,
      model: settings.model,
      onResult: (i, text) => (out[i] = text.replace(/<\/?\d{1,3}\/?>|<br>/g, "")),
    });
    recordClaude(r, texts.reduce((s, t) => s + t.length, 0));
  } catch {
    return runFallback(jobs);
  }
  let k = 0;
  jobs.forEach((job, n) => {
    const x = splits[n];
    finish(job, x.join(x.pieces.map((_, i) => out[k + i])));
    k += x.pieces.length;
  });
}

function flushGoogle() {
  googleTimer = null;
  const jobs = googleQueue;
  googleQueue = [];
  runGoogle(jobs);
}

async function runGoogle(jobs) {
  const target = jobs[0]?.lang;
  if (!target) return;
  const mine = jobs.filter((j) => j.lang === target);
  if (mine.length < jobs.length) runGoogle(jobs.filter((j) => j.lang !== target));
  const broken = [];
  try {
    await googleTranslate(mine.map((j) => j.source), target, (i, text) => {
      if (tagsMatch(mine[i].source, text)) finish(mine[i], text, "g");
      else broken.push(mine[i]);
    });
    if (broken.length) {
      // Same repair as for Haiku: translate the text between markers, keep the markers.
      const splits = broken.map((j) => splitForPlainEngine(j.source));
      const pieces = splits.flatMap((x) => x.pieces);
      const out = new Array(pieces.length);
      await googleTranslate(pieces, target, (i, t) => (out[i] = t));
      let k = 0;
      broken.forEach((job, n) => {
        const x = splits[n];
        finish(job, x.join(x.pieces.map((_, i) => out[k + i])), "g");
        k += x.pieces.length;
      });
    }
    const chars = mine.reduce((s, j) => s + j.source.length, 0);
    usage.record({ google: chars, chars });
  } catch {
    // Blocked or offline: Chrome's on-device translator takes over.
    runLocal(mine.filter((j) => inflight.has(j.key)));
  }
}

function runLocal(jobs) {
  for (const job of jobs) {
    localChain = localChain.then(async () => {
      if (!localAvailable() || job.from === job.lang.split("-")[0]) {
        inflight.delete(job.key);
        return fail(job, "local-unavailable");
      }
      try {
        const out = await localTranslate(job.source, job.from, langInfo(job.lang).chrome);
        finish(job, out, "l");
        usage.record({ local: job.source.length, chars: job.source.length });
      } catch (e) {
        inflight.delete(job.key);
        fail(job, String(e?.message ?? e));
      }
    });
  }
}

// ---------- Messaging ----------

api.runtime.onConnect.addListener((port) => {
  if (port.name !== "esx") return;
  port.onMessage.addListener((msg) => {
    if (msg.t === "tr") handleTranslate(port, msg.items, msg.ctx);
  });
  port.onDisconnect.addListener(() => {
    for (const job of inflight.values()) job.waiters = job.waiters.filter((w) => w.port !== port);
  });
});

api.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    await ready;
    switch (msg.t) {
      case "status": {
        const sum = await usage.summary(settings.credit);
        const L = langInfo(settings.lang);
        reply({
          usage: sum,
          cache: await cache.stats(),
          local: await localStatus("en", L.chrome),
          claudeOn: await useClaude(),
          engine: await pickEngine(),
        });
        break;
      }
      case "prepareLocal":
        try {
          await prepareLocal("en", langInfo(settings.lang).chrome);
          reply({ ok: true, status: await localStatus("en", langInfo(settings.lang).chrome) });
        } catch (e) {
          reply({ ok: false, error: String(e?.message ?? e) });
        }
        break;
      case "clearCache":
        await cache.clear();
        reply({ ok: true });
        break;
      case "testKey":
        try {
          const r = await claudeClient().messages.countTokens({ model: settings.model, messages: [{ role: "user", content: "hola" }] });
          await saveSettings({ keyError: "" });
          reply({ ok: true, tokens: r.input_tokens });
        } catch (e) {
          reply({ ok: false, error: `${e?.status ?? ""} ${e?.error?.error?.message ?? e.message}` });
        }
        break;
      case "detect": {
        // Short-text language check for YouTube titles etc. (LanguageDetector when present).
        reply(await detectMany(msg.texts));
        break;
      }
      default:
        reply(null);
    }
  })();
  return true;
});

api.commands?.onCommand.addListener(async (command, tab) => {
  if (command !== "toggle-site" || !tab?.url) return;
  const host = siteKey(new URL(tab.url).hostname);
  const s = await getSettings();
  const disabled = s.disabledSites.includes(host);
  await saveSettings({ disabledSites: disabled ? s.disabledSites.filter((d) => d !== host) : [...s.disabledSites, host] });
});

let detectorPromise = null;
async function detectMany(texts) {
  if (typeof globalThis.LanguageDetector === "undefined") return texts.map(() => null);
  try {
    detectorPromise ??= LanguageDetector.create();
    const d = await detectorPromise;
    return Promise.all(texts.map(async (t) => {
      const r = await d.detect(t);
      return r.slice(0, 3).map((x) => [x.detectedLanguage, +x.confidence.toFixed(3)]);
    }));
  } catch {
    detectorPromise = null;
    return texts.map(() => null);
  }
}

applyNetworkSettings();
updateBadge();
