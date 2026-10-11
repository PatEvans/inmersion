// Benchmark 1b: exact Haiku 5.5 token counts for each page at three reading depths,
// plus how much text repeats between two pages of the same site (free on revisit: cached).
import fs from "node:fs";
import { client } from "./client.mjs";
import { systemPrompt, userMessage } from "../src/shared/prompt.js";

const OUT = new URL("./out/", import.meta.url).pathname;
const MODEL = "claude-haiku-5-5";
const SCREEN = 900;
const onPage = (u) => u.visible && u.rect.top >= 0 && u.rect.w > 1 && u.rect.h > 1;

const pages = fs
  .readdirSync(OUT)
  .filter((f) => /^volume-(?!summary).*\.json$/.test(f))
  .map((f) => JSON.parse(fs.readFileSync(OUT + f, "utf8")));

const dedupe = (units) => [...new Map(units.map((u) => [u.source, u])).values()];
const scopes = {
  screen1: (u) => u.rect.top < SCREEN,
  screens3: (u) => u.rect.top < 3 * SCREEN,
  all: () => true,
};

async function count(text) {
  const r = await client.messages.countTokens({ model: MODEL, messages: [{ role: "user", content: text }] });
  return r.input_tokens;
}

const empty = await count("x");
const sys = (await client.messages.countTokens({ model: MODEL, system: systemPrompt("es-ES"), messages: [{ role: "user", content: "x" }] })).input_tokens - empty;
console.log(`system prompt (es-ES): ${sys} tokens; empty-message overhead: ${empty}`);

const rows = [];
for (const p of pages.sort((a, b) => a.id.localeCompare(b.id))) {
  const vis = p.units.filter(onPage).sort((a, b) => a.rect.top - b.rect.top);
  const bottom = Math.max(SCREEN, ...vis.map((u) => u.rect.bottom));
  const row = { id: p.id, screens: Math.ceil(bottom / SCREEN), lang: p.lang, hreflangEs: p.hreflangEs.length > 0 };
  for (const [name, test] of Object.entries(scopes)) {
    const us = dedupe(vis.filter(test));
    const chars = us.reduce((s, u) => s + u.source.length, 0);
    const tokens = us.length ? (await count(userMessage(us.map((u) => u.source), { url: p.url, title: p.title }))) - empty : 0;
    row[name] = { units: us.length, chars, tokens };
  }
  rows.push(row);
  console.log(
    `${p.id.padEnd(20)} screen1 ${String(row.screen1.tokens).padStart(6)} tok | 3 screens ${String(row.screens3.tokens).padStart(6)} tok | whole page ${String(row.all.tokens).padStart(7)} tok (${row.screens} screens) | chars/token ${(row.all.chars / Math.max(1, row.all.tokens)).toFixed(2)}`
  );
}

// Same-site repetition: share of page B's first 3 screens (chars) already seen on page A.
const byId = Object.fromEntries(pages.map((p) => [p.id, p]));
const pairs = [
  ["bbc-news-home", "bbc-news-article"],
  ["guardian-home", "guardian-article"],
  ["hn-front", "hn-comments"],
  ["reddit-sub", "reddit-thread"],
  ["youtube-search", "youtube-watch"],
  ["wikipedia-espresso", "wikipedia-madrid"],
];
const overlap = [];
for (const [a, b] of pairs) {
  if (!byId[a] || !byId[b]) continue;
  const seen = new Set(byId[a].units.map((u) => u.source));
  const us = dedupe(byId[b].units.filter(onPage).filter(scopes.screens3));
  const total = us.reduce((s, u) => s + u.source.length, 0);
  const rep = us.filter((u) => seen.has(u.source)).reduce((s, u) => s + u.source.length, 0);
  overlap.push({ a, b, repeatedPct: Math.round((100 * rep) / Math.max(1, total)) });
  console.log(`repeat ${a} → ${b}: ${Math.round((100 * rep) / Math.max(1, total))}% of chars already cached`);
}
fs.writeFileSync(OUT + "tokens.json", JSON.stringify({ model: MODEL, systemTokens: sys, rows, overlap }, null, 1));
