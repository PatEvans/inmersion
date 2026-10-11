// Benchmark 6b: blind three-way quality comparison (Haiku 5.5 vs Google's free endpoint vs
// Chrome on-device) on the same 64 sentences, judged by Claude Opus 5.5 for es-ES.
import fs from "node:fs";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { client } from "./client.mjs";

const OUT = new URL("./out/", import.meta.url).pathname;
const { items } = JSON.parse(fs.readFileSync(OUT + "google.json", "utf8"));
const ENGINES = ["haiku", "google", "local"];
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const rows = items.filter((it) => it.google).map((it, id) => {
  const order = [...ENGINES].sort(() => rand() - 0.5);
  return { id, ...it, order };
});

const Score = z.object({ accuracy: z.number().int().min(1).max(5), naturalness: z.number().int().min(1).max(5), errors: z.string() });
const Verdicts = z.object({ items: z.array(z.object({ id: z.number().int(), A: Score, B: Score, C: Score, best: z.enum(["A", "B", "C", "tie"]) })) });
const SYSTEM = `You are an expert translator and copy editor for Spanish as written in Spain (es-ES). Compare three machine translations of the same English web-page text (headlines, UI labels, comments, article paragraphs). Rate each 1-5:
- accuracy: meaning, nuance and facts preserved (5 = perfect, 3 = noticeable meaning error, 1 = wrong).
- naturalness: reads like native Spain Spanish written for that kind of web text (5 = indistinguishable from native, 3 = understandable but clearly translated, 1 = broken).
Note the main errors briefly (max 15 words). Pick the best one, or "tie" if the top ones are equally good. Judge the language only; names, usernames and URLs left in English are correct. Identical translations get identical scores.`;

let cost = 0;
const results = [];
for (let i = 0; i < rows.length; i += 8) {
  const batch = rows.slice(i, i + 8);
  const body = batch.map((r) => `### Item ${r.id}\nEnglish: ${r.source}\nA: ${r[r.order[0]]}\nB: ${r[r.order[1]]}\nC: ${r[r.order[2]]}`).join("\n\n");
  const res = await client.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    output_config: { effort: "low", format: zodOutputFormat(Verdicts) },
    system: SYSTEM,
    messages: [{ role: "user", content: body }],
  });
  cost += (res.usage.input_tokens * 4 + res.usage.output_tokens * 20) / 1e6;
  for (const v of res.parsed_output?.items ?? []) {
    const r = rows.find((x) => x.id === v.id);
    if (!r) continue;
    const by = Object.fromEntries(["A", "B", "C"].map((k, j) => [r.order[j], v[k]]));
    results.push({ ...r, scores: by, best: v.best === "tie" ? "tie" : r.order["ABC".indexOf(v.best)] });
  }
  process.stdout.write(".");
}
console.log();
const mean = (eng, k, kind) => {
  const xs = results.filter((r) => !kind || r.kind === kind).map((r) => r.scores[eng][k]);
  return +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2);
};
const summary = {
  judged: results.length,
  best: Object.fromEntries([...ENGINES, "tie"].map((e) => [e, results.filter((r) => r.best === e).length])),
  identicalHaikuGoogle: results.filter((r) => r.haiku === r.google).length,
  scores: Object.fromEntries(ENGINES.map((e) => [e, { accuracy: mean(e, "accuracy"), naturalness: mean(e, "naturalness") }])),
  byKind: Object.fromEntries(["short", "medium", "long"].map((k) => [k, Object.fromEntries(ENGINES.map((e) => [e, mean(e, "naturalness", k)]))])),
  haikuVsGoogle: {
    haikuBetter: results.filter((r) => r.scores.haiku.accuracy + r.scores.haiku.naturalness > r.scores.google.accuracy + r.scores.google.naturalness).length,
    googleBetter: results.filter((r) => r.scores.google.accuracy + r.scores.google.naturalness > r.scores.haiku.accuracy + r.scores.haiku.naturalness).length,
    same: results.filter((r) => r.scores.google.accuracy + r.scores.google.naturalness === r.scores.haiku.accuracy + r.scores.haiku.naturalness).length,
  },
  judgeCostUSD: +cost.toFixed(4),
};
console.log(JSON.stringify(summary, null, 1));
fs.writeFileSync(OUT + "judge3.json", JSON.stringify({ summary, results }, null, 1));
