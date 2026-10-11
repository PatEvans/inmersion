// Collect original-language YouTube titles (interface forced to English/US so YouTube
// doesn't swap in translated titles), then label each title's language with Haiku 5.5.
import { chromium } from "playwright";
import fs from "node:fs";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { client } from "./client.mjs";

const QUERIES = [
  "receta pasta fresca", "noticias españa hoy", "resumen liga española", "cómo aprender inglés rápido", "historia de españa documental",
  "humor español", "viajar por méxico", "tutorial maquillaje", "reseña iphone 17 español", "entrevista podcast españa",
  "fresh pasta recipe", "news today", "premier league highlights", "how to learn spanish", "iphone 17 review", "travel vlog japan",
  "comedy sketch", "recette pâtes fraîches", "notícias brasil hoje", "ricetta pasta fresca",
];
const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 1000 } });
await ctx.addCookies([{ name: "PREF", value: "hl=en&gl=US", domain: ".youtube.com", path: "/" }, { name: "SOCS", value: "CAI", domain: ".youtube.com", path: "/" }]);
const page = await ctx.newPage();
const titles = new Map();
for (const q of QUERIES) {
  await page.goto("https://www.youtube.com/results?search_query=" + encodeURIComponent(q), { waitUntil: "domcontentloaded" });
  if (/consent\./.test(page.url())) { await page.getByRole("button", { name: /reject all/i }).first().click().catch(() => {}); await page.waitForLoadState("domcontentloaded"); }
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 2500); await page.waitForTimeout(900); }
  const ts = await page.evaluate(() => [...document.querySelectorAll("a#video-title, h3[title], .shortsLockupViewModelHostMetadataTitle, .shortsLockupViewModelHostOutsideMetadataTitle")]
    .map((e) => (e.getAttribute("title") || e.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean));
  for (const t of ts) if (!titles.has(t)) titles.set(t, q);
  console.log(q, "→", ts.length, "titles, total", titles.size);
}
await browser.close();

const list = [...titles.keys()];
const Labels = z.object({ labels: z.array(z.object({ i: z.number().int(), lang: z.string() })) });
const out = [];
for (let s = 0; s < list.length; s += 60) {
  const batch = list.slice(s, s + 60);
  const r = await client.messages.parse({
    model: "claude-haiku-5-5", max_tokens: 4000, thinking: { type: "disabled" }, output_config: { effort: "low", format: zodOutputFormat(Labels) },
    system: "Label the language of each YouTube video title with an ISO 639-1 code (es, en, pt, fr, it, de, ...). Judge the language a viewer would hear/read: a title mostly in Spanish with an English brand name is 'es'. Titles with no real words (only names, emoji, hashtags) get 'und'. Mixed bilingual titles get the language of the majority of words.",
    messages: [{ role: "user", content: batch.map((t, i) => `${s + i}: ${t}`).join("\n") }],
  });
  for (const l of r.parsed_output.labels) if (list[l.i]) out.push({ title: list[l.i], lang: l.lang, query: titles.get(list[l.i]) });
}
fs.writeFileSync("bench/out/yt-titles.json", JSON.stringify(out, null, 1));
const counts = {};
for (const o of out) counts[o.lang] = (counts[o.lang] ?? 0) + 1;
console.log("labeled", out.length, JSON.stringify(counts));
