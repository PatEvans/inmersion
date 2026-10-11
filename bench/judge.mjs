// Benchmark 4: blind quality comparison of Haiku 5.5 vs Chrome on-device translations,
// judged by Claude Opus 5.5 (A/B order randomised per item, tags stripped).
import fs from "node:fs";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { client } from "./client.mjs";
import { stripMarkup } from "../src/shared/markup.js";

const OUT = new URL("./out/", import.meta.url).pathname;
const haiku = JSON.parse(fs.readFileSync(OUT + "haiku-prod.json", "utf8"));
const local = JSON.parse(fs.readFileSync(OUT + "local-markup.json", "utf8"));

// Deterministic shuffle so the sample is reproducible.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const items = [];
let identical = 0;
for (const hp of haiku.pages) {
  const lp = local.pages.find((p) => p.id === hp.id);
  if (!lp) continue;
  const pool = Object.keys(hp.translations).filter((s) => lp.translations[s] !== undefined && /\p{L}{3}/u.test(stripMarkup(s)));
  const buckets = { short: [], medium: [], long: [] };
  for (const s of pool) {
    const n = stripMarkup(s).length;
    buckets[n <= 25 ? "short" : n <= 200 ? "medium" : "long"].push(s);
  }
  for (const [kind, want] of [["short", 1], ["medium", 2], ["long", 1]]) {
    const b = buckets[kind].sort(() => rand() - 0.5).slice(0, want);
    for (const s of b) {
      const h = stripMarkup(hp.translations[s]);
      const l = stripMarkup(lp.translations[s]);
      if (h === l) { identical++; continue; }
      const swap = rand() < 0.5;
      items.push({ page: hp.id, kind, source: stripMarkup(s), a: swap ? l : h, b: swap ? h : l, aIs: swap ? "local" : "haiku" });
    }
  }
}
console.log(`judging ${items.length} items (${identical} sampled pairs were identical and skipped)`);

const Score = z.object({ accuracy: z.number().int().min(1).max(5), naturalness: z.number().int().min(1).max(5), errors: z.string() });
const Verdicts = z.object({ items: z.array(z.object({ id: z.number().int(), a: Score, b: Score, better: z.enum(["a", "b", "tie"]) })) });

const SYSTEM = `You are an expert translator and copy editor for Spanish as written in Spain (es-ES). You will compare two machine translations of the same English web-page text (headlines, UI labels, comments, article paragraphs). For each item, rate each translation 1-5:
- accuracy: meaning, nuance and facts preserved (5 = perfect, 3 = noticeable meaning error, 1 = wrong).
- naturalness: reads like native Spain Spanish written for that kind of web text (5 = indistinguishable from native, 3 = understandable but clearly translated, 1 = broken).
Briefly note the main errors (max 15 words, Spanish or English). Then pick the better one, or "tie" if they are equally good. Judge the language only; names, usernames and URLs left in English are correct.`;

const results = [];
let cost = 0;
for (let i = 0; i < items.length; i += 10) {
  const batch = items.slice(i, i + 10);
  const body = batch.map((it, k) => `### Item ${i + k}\nEnglish: ${it.source}\nA: ${it.a}\nB: ${it.b}`).join("\n\n");
  const r = await client.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    output_config: { effort: "low", format: zodOutputFormat(Verdicts) },
    system: SYSTEM,
    messages: [{ role: "user", content: body }],
  });
  cost += (r.usage.input_tokens * 4 + r.usage.output_tokens * 20) / 1e6;
  for (const v of r.parsed_output?.items ?? []) {
    const it = items[v.id];
    if (!it) continue;
    const hs = it.aIs === "haiku" ? v.a : v.b;
    const ls = it.aIs === "haiku" ? v.b : v.a;
    const better = v.better === "tie" ? "tie" : (v.better === "a") === (it.aIs === "haiku") ? "haiku" : "local";
    results.push({ ...it, haiku: hs, local: ls, better });
  }
  process.stdout.write(".");
}
console.log();
const mean = (eng, k, kind) => {
  const xs = results.filter((r) => !kind || r.kind === kind).map((r) => r[eng][k]);
  return (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2);
};
const summary = {
  judged: results.length,
  identicalSkipped: identical,
  wins: { haiku: results.filter((r) => r.better === "haiku").length, local: results.filter((r) => r.better === "local").length, tie: results.filter((r) => r.better === "tie").length },
  haiku: { accuracy: mean("haiku", "accuracy"), naturalness: mean("haiku", "naturalness") },
  local: { accuracy: mean("local", "accuracy"), naturalness: mean("local", "naturalness") },
  byKind: Object.fromEntries(["short", "medium", "long"].map((k) => [k, { haikuNat: mean("haiku", "naturalness", k), localNat: mean("local", "naturalness", k), haikuAcc: mean("haiku", "accuracy", k), localAcc: mean("local", "accuracy", k) }])),
  judgeCostUSD: +cost.toFixed(4),
};
console.log(JSON.stringify(summary, null, 1));
fs.writeFileSync(OUT + "judge.json", JSON.stringify({ summary, results }, null, 1));
