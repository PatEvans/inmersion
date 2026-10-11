// Benchmark 6: Google Translate's free, unofficial endpoint (client=gtx, no key) on the
// same sentences as the Haiku vs Chrome-local judge, plus speed and tag handling.
// Volume is kept modest (~150 requests, paced) so we don't get the IP throttled.
import fs from "node:fs";
import { tagIds } from "../src/shared/markup.js";

const OUT = new URL("./out/", import.meta.url).pathname;
const judge = JSON.parse(fs.readFileSync(OUT + "judge.json", "utf8"));
const haiku = JSON.parse(fs.readFileSync(OUT + "haiku-prod.json", "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let requests = 0;
async function gtx(text) {
  requests++;
  const t0 = performance.now();
  const r = await fetch("https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=es&dt=t", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: "q=" + encodeURIComponent(text),
  });
  const ms = performance.now() - t0;
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status, ms });
  const body = await r.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw Object.assign(new Error("non-JSON response (blocked / captcha?)"), { ms });
  }
  return { text: (data[0] ?? []).map((seg) => seg[0] ?? "").join(""), ms };
}

// 1) Quality set: the 64 sentences the earlier blind test used.
const items = judge.results.map((r) => ({
  source: r.source, kind: r.kind, page: r.page,
  haiku: r.aIs === "haiku" ? r.a : r.b,
  local: r.aIs === "local" ? r.a : r.b,
}));
const times = [];
let stopped = null;
for (const it of items) {
  try {
    const g = await gtx(it.source);
    it.google = g.text;
    times.push(g.ms);
  } catch (e) {
    stopped = e.message;
    break;
  }
  await sleep(150);
}
console.log(`quality set: ${items.filter((i) => i.google).length}/${items.length} translated${stopped ? ` (stopped: ${stopped})` : ""}`);

// 2) Tags: our units with links/formatting, sent as-is.
const tagged = haiku.pages.flatMap((p) => Object.keys(p.translations).filter((s) => tagIds(s).size)).slice(0, 50);
let kept = 0, broke = 0;
const brokenExamples = [];
for (const src of tagged) {
  if (stopped) break;
  try {
    const g = await gtx(src);
    times.push(g.ms);
    const a = tagIds(src), b = tagIds(g.text);
    const same = a.size === b.size && [...a].every((x) => b.has(x)) && (src.match(/<\/?\d+\/?>/g) ?? []).length === (g.text.match(/<\/?\d+\/?>/g) ?? []).length;
    if (same) kept++;
    else {
      broke++;
      if (brokenExamples.length < 3) brokenExamples.push({ src: src.slice(0, 90), out: g.text.slice(0, 90) });
    }
  } catch (e) {
    stopped = e.message;
  }
  await sleep(150);
}
console.log(`tags kept: ${kept}/${kept + broke}`);
for (const b of brokenExamples) console.log("   EN:", b.src, "\n   GT:", b.out);

// 3) A short burst like a page load (20 requests at once) to see if it throttles.
let burstOk = 0, burstFail = 0;
const burstT0 = performance.now();
if (!stopped) {
  await Promise.all(items.slice(0, 20).map(async (it) => {
    try {
      await gtx(it.source);
      burstOk++;
    } catch {
      burstFail++;
    }
  }));
}
const burstMs = performance.now() - burstT0;
times.sort((a, b) => a - b);
const pct = (p) => Math.round(times[Math.min(times.length - 1, Math.floor(times.length * p))]);
const summary = {
  requests,
  latencyMs: { p50: pct(0.5), p90: pct(0.9), max: Math.round(times.at(-1)) },
  tags: { kept, total: kept + broke },
  burst20: { ok: burstOk, failed: burstFail, ms: Math.round(burstMs) },
  stopped,
};
console.log(JSON.stringify(summary));
fs.writeFileSync(OUT + "google.json", JSON.stringify({ summary, items, brokenExamples }, null, 1));
