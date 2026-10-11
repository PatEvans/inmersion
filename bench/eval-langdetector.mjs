// Second stage: Chrome's LanguageDetector on the titles our instant guess is unsure about
// (runs in your installed Chrome with a throwaway profile).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import http from "node:http";
import { guessLang } from "../src/shared/detect.js";
const data = JSON.parse(fs.readFileSync("bench/out/yt-titles.json", "utf8")).filter((d) => d.lang !== "und");
const unsure = data.filter((d) => !guessLang(d.title).confident);
const server = http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end("<!doctype html><button id=go>go</button>"); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "esx-ld-"));
const port = 9800 + Math.floor(Math.random() * 100);
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--no-first-run", "--headless=new", "about:blank"], { stdio: "ignore" });
let browser; for (let i = 0; i < 50 && !browser; i++) { await new Promise((r) => setTimeout(r, 200)); browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null); }
const page = await browser.contexts()[0].newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.evaluate(() => { document.getElementById("go").onclick = () => (window.__ld = LanguageDetector.create()); });
await page.click("#go");
const res = await page.evaluate(async (titles) => { const d = await window.__ld; return Promise.all(titles.map(async (t) => (await d.detect(t)).slice(0, 2).map((x) => [x.detectedLanguage, x.confidence]))); }, unsure.map((d) => d.title));
const allEs = data.filter((d) => d.lang === "es").length, allOt = data.length - allEs;
const s1 = { esKeep: 0, esHide: 0, otHide: 0, otKeep: 0 };
for (const d of data) { const g = guessLang(d.title); if (!g.confident) continue; if (d.lang === "es") g.lang === "es" ? s1.esKeep++ : s1.esHide++; else g.lang === "es" ? s1.otKeep++ : s1.otHide++; }
const pct = (a, b) => ((100 * a) / b).toFixed(1) + "%";
console.log(`unsure after stage 1: ${unsure.length}`);
for (const [keepAt, dropAt] of [[0.4, 0.75], [0.4, 0.9], [0.5, 0.95], [0.3, 0.97]]) {
  const r = { es: { keep: 0, dim: 0, hide: 0 }, other: { keep: 0, dim: 0, hide: 0 } };
  unsure.forEach((d, i) => {
    const top = res[i][0];
    let v = "dim";
    if (top && top[0] !== "und") { const l = top[0].split("-")[0]; if (l === "es" && top[1] >= keepAt) v = "keep"; else if (l !== "es" && top[1] >= dropAt) v = "hide"; }
    r[d.lang === "es" ? "es" : "other"][v]++;
  });
  console.log(`keep≥${keepAt} hide≥${dropAt}: Spanish shown ${pct(s1.esKeep + r.es.keep, allEs)}, dimmed ${pct(r.es.dim, allEs)}, wrongly hidden ${pct(s1.esHide + r.es.hide, allEs)} | other hidden ${pct(s1.otHide + r.other.hide, allOt)}, dimmed ${pct(r.other.dim, allOt)}, wrongly shown ${pct(s1.otKeep + r.other.keep, allOt)}`);
}
await browser.close(); chrome.kill(); server.close(); await new Promise((r) => setTimeout(r, 1000)); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
