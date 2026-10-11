// Background service worker: owns the translation queue, both engines, the cache,
// spend tracking, and the "ask sites for Spanish first" network settings.

import Anthropic from "@anthropic-ai/sdk";
import { translateWithClaude, chunkTexts } from "../shared/claude.js";
import { langInfo, LANGS } from "../shared/langs.js";
import { DEFAULTS, getSettings, saveSettings, onSettingsChanged, siteKey } from "../shared/settings.js";
import * as cache from "./cache.js";
import * as usage from "./usage.js";
import { localAvailable, localStatus, localTranslate, prepareLocal } from "./local.js";

const api = globalThis.chrome ?? globalThis.browser;
const CONCURRENCY = 8;

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

// ---------- Translation scheduling ----------

// cacheKey → { source, from, lang, engine, ctx, waiters: [{port, k}] }
const inflight = new Map();
let claudeQueue = [];
let claudeTimer = null;
let running = 0;
const chunkQueue = [];
let localChain = Promise.resolve();

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
  const engine = (await useClaude()) ? "c" : "l";
  // A Claude translation is always good to reuse, even when we're on the local engine.
  const keysFor = (s) => (engine === "c" ? [cache.cacheKey(lang, "c", s)] : [cache.cacheKey(lang, "c", s), cache.cacheKey(lang, "l", s)]);
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
    const job = { key, source: it.s, from: it.src || "en", lang, engine, ctx, waiters: [{ port, k: it.k }] };
    inflight.set(key, job);
    if (engine === "c") claudeQueue.push(job);
    else runLocal([job]);
  }
  if (cachedChars) usage.record({ cached: cachedChars });
  if (claudeQueue.length) claudeTimer ??= setTimeout(flushClaude, 15);
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
    for (const chunk of chunkTexts(pageJobs, { size: (j) => j.source.length })) chunkQueue.push(chunk);
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

async function runClaude(chunk, retry = false) {
  const lang = chunk[0].lang;
  try {
    const r = await translateWithClaude(claudeClient(), {
      texts: chunk.map((j) => j.source),
      ctx: chunk[0].ctx,
      lang,
      model: settings.model,
      onResult: (i, text) => {
        const job = chunk[i];
        cache.put(job.key, text);
        inflight.delete(job.key);
        deliver(job, text);
      },
    });
    usage.record({
      cost: r.cost,
      in: r.usage.input_tokens ?? 0,
      out: r.usage.output_tokens ?? 0,
      cacheRead: r.usage.cache_read_input_tokens ?? 0,
      cacheWrite: r.usage.cache_creation_input_tokens ?? 0,
      requests: 1,
      chars: chunk.reduce((s, j) => s + j.source.length, 0),
    });
    if (settings.keyError) saveSettings({ keyError: "" });
    const missing = r.missing.map((i) => chunk[i]);
    if (missing.length) {
      if (r.stop === "refusal" || retry) runLocal(missing);
      else runClaude(missing, true);
    }
    updateBadge();
  } catch (e) {
    const status = e?.status;
    if (status === 401 || status === 403 || status === 400) {
      saveSettings({ keyError: `${status}: ${e?.error?.error?.message ?? e.message}`.slice(0, 200) });
    }
    console.warn("Claude engine failed, falling back to local", status, e?.message);
    runLocal(chunk.filter((j) => inflight.has(j.key)));
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
        const key = cache.cacheKey(job.lang, "l", job.source);
        cache.put(key, out);
        inflight.delete(job.key);
        deliver(job, out);
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
