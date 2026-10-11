// Builds src/shared/ngram-data.json: character-trigram profiles per language, trained on
// the web text collected by the benchmarks (English sources, Haiku's Spanish) plus small
// fr/it/pt/de corpora made by translating a slice of the English text with Haiku.
import fs from "node:fs";
import { client } from "./client.mjs";
import { translateWithClaude, chunkTexts } from "../src/shared/claude.js";
import { stripMarkup } from "../src/shared/markup.js";

const OUT = new URL("./out/", import.meta.url).pathname;
const haiku = JSON.parse(fs.readFileSync(OUT + "haiku-prod.json", "utf8"));
const en = [], es = [];
for (const p of haiku.pages) for (const [s, t] of Object.entries(p.translations)) { en.push(stripMarkup(s)); es.push(stripMarkup(t)); }

// Parallel corpus: the same lines in every language, so profiles differ only by language.
const esOf = new Map(en.map((t, i) => [t, es[i]]));
const corpora = {};
const CORP = OUT + "ngram-corpora.json";
if (fs.existsSync(CORP)) {
  const saved = JSON.parse(fs.readFileSync(CORP, "utf8"));
  for (const k of ["fr", "it", "pt", "de"]) if (saved[k]) corpora[k] = saved[k];
}
// A diverse slice: every 4th unit with real words.
const slice = en.filter((t, i) => i % 4 === 0 && /\p{L}{3}/u.test(t)).slice(0, 380);
corpora.en = slice;
corpora.es = slice.map((t) => esOf.get(t)).filter(Boolean);
for (const lang of ["fr-FR", "it-IT", "pt-BR", "de-DE"]) {
  const base = lang.slice(0, 2);
  if (corpora[base]?.length) continue;
  const outTexts = new Array(slice.length);
  let cost = 0;
  for (const chunk of chunkTexts(slice.map((t, i) => ({ t, i })), { size: (x) => x.t.length, maxChars: 3000, maxUnits: 50 })) {
    const r = await translateWithClaude(client, { texts: chunk.map((x) => x.t), ctx: { title: "Mixed web text" }, lang, onResult: (k, text) => (outTexts[chunk[k].i] = text) });
    cost += r.cost;
  }
  corpora[base] = outTexts.filter(Boolean);
  console.log(`${base}: ${corpora[base].length} lines, $${cost.toFixed(4)}`);
}
fs.writeFileSync(CORP, JSON.stringify(corpora));

export function trigrams(text) {
  const words = text.toLowerCase().replace(/[^\p{L}' ]+/gu, " ").split(/\s+/).filter((w) => w.length > 0);
  const grams = [];
  for (const w of words) {
    const s = ` ${w} `;
    for (let i = 0; i + 3 <= s.length; i++) grams.push(s.slice(i, i + 3));
  }
  return grams;
}

const TOP = Number(process.argv[2] ?? 800);
const data = {};
const stats = {};
for (const [lang, texts] of Object.entries(corpora)) {
  const counts = new Map();
  let total = 0;
  for (const t of texts) for (const g of trigrams(t)) { counts.set(g, (counts.get(g) ?? 0) + 1); total++; }
  stats[lang] = { counts, total };
}
// One shared floor for unseen trigrams, so no language is favoured by corpus size.
const floor = +Math.log(0.5 / Math.max(...Object.values(stats).map((x) => x.total))).toFixed(2);
for (const [lang, { counts, total }] of Object.entries(stats)) {
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, TOP);
  data[lang] = { floor, g: Object.fromEntries(top.map(([g, c]) => [g, +Math.log(c / total).toFixed(2)])) };
}
console.log("corpus trigrams:", Object.entries(stats).map(([k, v]) => `${k} ${v.total}`).join(", "));
fs.writeFileSync("src/shared/ngram-data.json", JSON.stringify(data));
console.log("profiles:", Object.keys(data).join(","), "size", fs.statSync("src/shared/ngram-data.json").size, "bytes");
