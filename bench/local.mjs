// Benchmark 3: Chrome's free on-device Translator API, in your installed Chrome with a
// throwaway profile. Translates the same units as the Haiku benchmark and measures speed,
// whether it keeps our <N> tags, and saves output for the quality comparison.
//   node bench/local.mjs [--headed] [page ids...]
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tagIds } from "../src/shared/markup.js";

const OUT = new URL("./out/", import.meta.url).pathname;
const args = process.argv.slice(2);
const headed = args.includes("--headed");
const mode = args.includes("--pieces") ? "pieces" : "markup";
const only = args.filter((a) => !a.startsWith("--"));
const SCREEN = 900;
const onPage = (u) => u.visible && u.rect.top >= 0 && u.rect.w > 1 && u.rect.h > 1;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><button id="go">download</button><pre id="log"></pre>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "esx-chrome-"));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--no-first-run",
  "--no-default-browser-check", "--disable-sync", ...(headed ? ["--window-size=900,600"] : ["--headless=new"]),
  "about:blank",
], { stdio: "ignore" });
let browser;
for (let i = 0; i < 50 && !browser; i++) {
  await new Promise((r) => setTimeout(r, 200));
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
}
const page = await browser.contexts()[0].newPage();
await page.goto(origin);

try {
  const avail = await page.evaluate(() =>
    typeof Translator === "undefined" ? "no Translator API" : Translator.availability({ sourceLanguage: "en", targetLanguage: "es" }));
  console.log("availability:", avail);
  if (avail === "no Translator API" || avail === "unavailable") throw new Error(avail);

  // create() needs a user gesture when the language pack has to download.
  await page.evaluate(() => {
    window.__progress = [];
    document.getElementById("go").onclick = () => {
      const t0 = performance.now();
      window.__ready = Translator.create({
        sourceLanguage: "en", targetLanguage: "es",
        monitor: (m) => m.addEventListener("downloadprogress", (e) => window.__progress.push(e.loaded)),
      }).then((t) => { window.__t = t; return performance.now() - t0; });
    };
  });
  await page.click("#go");
  const createMs = await page.evaluate(() => window.__ready);
  console.log(`translator ready in ${Math.round(createMs)} ms (download progress events: ${await page.evaluate(() => window.__progress.length)})`);

  // Warm-up + tag test on a few markup strings.
  const tagTests = [
    "This is <1>very</1> important.",
    "Posted by <1>u/throwaway_42</1> 5 hours ago",
    "<1>Learn more</1> about how we use cookies.",
    "Use the <1/> command to install it.",
    "<1>95 points</1> by <2>pizzaiolo</2> <3><4>6 hours ago</4></3> <5/> | <6>hide</6> | <7>28 comments</7>",
  ];
  const tagResults = await page.evaluate(async (xs) => Promise.all(xs.map((x) => window.__t.translate(x))), tagTests);
  let kept = 0;
  tagTests.forEach((src, i) => {
    const same = [...tagIds(src)].every((id) => tagIds(tagResults[i]).has(id)) && tagIds(tagResults[i]).size === tagIds(src).size;
    if (same) kept++;
    console.log(`  tag test ${same ? "kept" : "BROKE"}: ${tagResults[i]}`);
  });

  const pages = fs.readdirSync(OUT).filter((f) => /^volume-(?!summary).*\.json$/.test(f))
    .map((f) => JSON.parse(fs.readFileSync(OUT + f, "utf8")))
    .filter((p) => !only.length || only.includes(p.id)).sort((a, b) => a.id.localeCompare(b.id));
  const report = { avail, createMs, tagTests: { total: tagTests.length, kept, outputs: tagResults }, pages: [] };
  for (const p of pages) {
    const seen = new Set();
    const units = p.units.filter(onPage).filter((u) => u.rect.top < 3 * SCREEN).sort((a, b) => a.rect.top - b.rect.top)
      .filter((u) => !seen.has(u.source) && seen.add(u.source));
    // Mode "markup": send the whole unit (tags included) and keep it if the tags survive,
    // else fall back to translating its text pieces one by one ("pieces" mode for all).
    const r = await page.evaluate(async ({ units, markup }) => {
      const TAG = /<(\/?)(\d{1,3})(\/?)>|<br>/g;
      const ids = (s) => [...s.matchAll(TAG)].map((m) => m[0]).sort().join("");
      const split = (s) => s.split(TAG).filter((x, i) => i % 4 === 0);
      const t0 = performance.now();
      const out = {};
      let fallbacks = 0;
      let screen1Ms = 0;
      for (const u of units) {
        let tr = null;
        if (markup || u.plain) {
          tr = await window.__t.translate(u.source);
          if (!u.plain && ids(tr) !== ids(u.source)) { tr = null; fallbacks++; }
        }
        if (tr === null) {
          // rebuild: translate each text piece between tags
          const parts = u.source.split(/(<\/?\d{1,3}\/?>|<br>)/);
          for (let i = 0; i < parts.length; i += 2) {
            if (/\p{L}/u.test(parts[i])) {
              const lead = parts[i].match(/^\s*/)[0], trail = parts[i].match(/\s*$/)[0];
              parts[i] = lead + (await window.__t.translate(parts[i].trim())) + trail;
            }
          }
          tr = parts.join("");
        }
        out[u.source] = tr;
        if (u.screen1) screen1Ms = performance.now() - t0;
      }
      return { out, fallbacks, ms: performance.now() - t0, screen1Ms };
    }, { units: units.map((u) => ({ source: u.source, plain: u.plain, screen1: u.rect.top < SCREEN })), markup: mode === "markup" });
    const translations = r.out;
    const chars = units.reduce((s, u) => s + u.source.length, 0);
    const row = { id: p.id, mode, units: units.length, tagged: units.filter((u) => !u.plain).length, fallbacks: r.fallbacks, chars, ms: Math.round(r.ms), screen1Ms: Math.round(r.screen1Ms), charsPerSec: Math.round(chars / (r.ms / 1000)) };
    report.pages.push({ ...row, translations });
    console.log(JSON.stringify(row));
  }

  // Does a second translator instance run in parallel, or is it one queue?
  const par = await page.evaluate(async (pieces) => {
    const t2 = await Translator.create({ sourceLanguage: "en", targetLanguage: "es" });
    const half = Math.ceil(pieces.length / 2);
    const seq0 = performance.now();
    for (const x of pieces) await window.__t.translate(x);
    const seqMs = performance.now() - seq0;
    const par0 = performance.now();
    await Promise.all([
      (async () => { for (const x of pieces.slice(0, half)) await window.__t.translate(x); })(),
      (async () => { for (const x of pieces.slice(half)) await t2.translate(x); })(),
    ]);
    return { seqMs: Math.round(seqMs), twoInstancesMs: Math.round(performance.now() - par0) };
  }, report.pages[0]?.translations ? Object.keys(report.pages[0].translations).slice(0, 40) : []);
  console.log("parallelism:", JSON.stringify(par));
  report.parallel = par;
  fs.writeFileSync(OUT + `local-${mode}.json`, JSON.stringify(report, null, 1));
} catch (e) {
  console.log("local benchmark failed:", e.message);
} finally {
  await browser.close().catch(() => {});
  chrome.kill();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
