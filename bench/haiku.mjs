// Benchmark 2: translate every unit in the first 3 screens of each page with Haiku 5.5,
// using the extension's own engine code. Measures real output tokens, cost, latency,
// line/tag fidelity, and (variant "adaptive") what thinking would add.
//   node bench/haiku.mjs [variant] [page ids...]     variant: prod | adaptive
import fs from "node:fs";
import { client } from "./client.mjs";
import { translateWithClaude, chunkTexts } from "../src/shared/claude.js";
import { tagIds } from "../src/shared/markup.js";

const OUT = new URL("./out/", import.meta.url).pathname;
const SCREEN = 900;
const CONCURRENCY = 8;
const [variant = "prod", ...only] = process.argv.slice(2);
const cfg = variant === "adaptive" ? { thinking: "adaptive", effort: "low" } : { thinking: "disabled", effort: "low" };

const onPage = (u) => u.visible && u.rect.top >= 0 && u.rect.w > 1 && u.rect.h > 1;
const pages = fs
  .readdirSync(OUT)
  .filter((f) => /^volume-(?!summary).*\.json$/.test(f))
  .map((f) => JSON.parse(fs.readFileSync(OUT + f, "utf8")))
  .filter((p) => !only.length || only.includes(p.id))
  .sort((a, b) => a.id.localeCompare(b.id));

const sameTags = (a, b) => {
  const x = tagIds(a), y = tagIds(b);
  return x.size === y.size && [...x].every((id) => y.has(id));
};

async function pool(tasks, n) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }));
  return results;
}

const report = { variant, cfg, pages: [] };
let printedLimits = false;
for (const p of pages) {
  const seen = new Set();
  const units = p.units
    .filter(onPage)
    .filter((u) => u.rect.top < 3 * SCREEN)
    .sort((a, b) => a.rect.top - b.rect.top)
    .filter((u) => !seen.has(u.source) && seen.add(u.source));
  const chunks = chunkTexts(units, { size: (u) => u.source.length });
  const translations = {};
  const t0 = performance.now();
  let firstVisibleDone = null;
  const screen1 = new Set(units.filter((u) => u.rect.top < SCREEN).map((u) => u.source));
  let screen1Left = screen1.size;
  const stats = await pool(
    chunks.map((chunk) => async () => {
      const r = await translateWithClaude(client, {
        texts: chunk.map((u) => u.source),
        ctx: { url: p.url, title: p.title },
        lang: "es-ES",
        ...cfg,
        onResult: (i, text) => {
          translations[chunk[i].source] = text;
          if (screen1.has(chunk[i].source) && --screen1Left === 0) firstVisibleDone = performance.now() - t0;
        },
      });
      if (!printedLimits && r.headers) {
        printedLimits = true;
        const h = (k) => r.headers.get(k);
        report.rateLimits = {
          requests: h("anthropic-ratelimit-requests-limit"),
          inputTokens: h("anthropic-ratelimit-input-tokens-limit"),
          outputTokens: h("anthropic-ratelimit-output-tokens-limit"),
        };
        console.log("rate limits:", JSON.stringify(report.rateLimits));
      }
      return { n: chunk.length, chars: chunk.reduce((s, u) => s + u.source.length, 0), ...r, headers: undefined };
    }),
    CONCURRENCY,
  );
  const wall = performance.now() - t0;
  const sum = (k) => stats.reduce((s, x) => s + (x.usage?.[k] ?? 0), 0);
  const tagged = units.filter((u) => !u.plain);
  const row = {
    id: p.id,
    units: units.length,
    chunks: chunks.length,
    chars: units.reduce((s, u) => s + u.source.length, 0),
    in: sum("input_tokens"),
    cacheRead: sum("cache_read_input_tokens"),
    cacheWrite: sum("cache_creation_input_tokens"),
    out: sum("output_tokens"),
    cost: stats.reduce((s, x) => s + x.cost, 0),
    wallMs: Math.round(wall),
    screen1Ms: firstVisibleDone && Math.round(firstVisibleDone),
    firstLineMs: Math.round(Math.min(...stats.map((s) => s.firstLine ?? Infinity))),
    missing: stats.reduce((s, x) => s + x.missing.length, 0),
    stops: [...new Set(stats.map((s) => s.stop))].join(","),
    tagged: tagged.length,
    tagMismatch: tagged.filter((u) => translations[u.source] !== undefined && !sameTags(u.source, translations[u.source])).length,
    unchanged: units.filter((u) => translations[u.source] === u.source).length,
    outPerSec: Math.round(stats.reduce((s, x) => s + x.usage.output_tokens / Math.max(0.001, (x.ms - (x.firstToken ?? 0)) / 1000), 0) / stats.length),
  };
  report.pages.push({ ...row, translations });
  console.log(JSON.stringify(row));
}
const tot = (k) => report.pages.reduce((s, r) => s + r[k], 0);
report.totals = { in: tot("in"), cacheRead: tot("cacheRead"), cacheWrite: tot("cacheWrite"), out: tot("out"), cost: tot("cost"), chars: tot("chars"), units: tot("units"), missing: tot("missing"), tagged: tot("tagged"), tagMismatch: tot("tagMismatch") };
console.log("TOTALS", JSON.stringify(report.totals));
fs.writeFileSync(`${OUT}haiku-${variant}${only.length ? "-" + only.join("+") : ""}.json`, JSON.stringify(report, null, 1));
