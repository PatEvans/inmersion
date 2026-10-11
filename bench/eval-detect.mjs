// Benchmark 5: YouTube title language detection for the "only Spanish videos" filter.
// For target es: Spanish titles should be kept, everything else hidden; "unsure" = dimmed.
import fs from "node:fs";
import { guessLang, lexicon, setMargin } from "../src/shared/detect.js";
const data = JSON.parse(fs.readFileSync("bench/out/yt-titles.json", "utf8")).filter((d) => d.lang !== "und");
function evaluate(name, classify) {
  const r = { es: { keep: 0, dim: 0, hide: 0 }, other: { keep: 0, dim: 0, hide: 0 } };
  const mistakes = [];
  for (const d of data) {
    const g = classify(d.title);
    const v = !g.confident || !g.lang ? "dim" : g.lang === "es" ? "keep" : "hide";
    const bucket = d.lang === "es" ? "es" : "other";
    r[bucket][v]++;
    if ((bucket === "es" && v === "hide") || (bucket === "other" && v === "keep")) mistakes.push(`${d.lang}→${g.lang} ${d.title.slice(0, 70)}`);
  }
  const pct = (a, b) => ((100 * a) / b).toFixed(1) + "%";
  const nEs = data.filter((d) => d.lang === "es").length, nOt = data.length - nEs;
  console.log(`${name.padEnd(26)} Spanish: shown ${pct(r.es.keep, nEs)} dimmed ${pct(r.es.dim, nEs)} HIDDEN ${pct(r.es.hide, nEs)} | other: hidden ${pct(r.other.hide, nOt)} dimmed ${pct(r.other.dim, nOt)} SHOWN ${pct(r.other.keep, nOt)}`);
  return { r, mistakes };
}
console.log(`${data.length} titles (${data.filter((d) => d.lang === "es").length} Spanish)`);
evaluate("word list only (v1)", lexicon);
let best;
for (const m of [3, 4, 5, 6, 8, 10]) {
  setMargin(m);
  const res = evaluate(`trigrams+words, margin ${m}`, guessLang);
  if (m === 6) best = res;
}
console.log("\nmistakes at margin 6:\n" + best.mistakes.slice(0, 14).join("\n"));
