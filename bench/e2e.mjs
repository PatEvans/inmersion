// End-to-end: load dist/ into a fresh Chromium profile, browse real pages, and measure how
// long until the visible text is Spanish. Screenshots go to bench/out/shots/.
//   node bench/e2e.mjs [--engine=local|claude] [--headed] [ids...]
import "./env.mjs";
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { guessLang } from "../src/shared/detect.js";
import { DEFAULTS } from "../src/shared/settings.js";

const args = process.argv.slice(2);
const engine = args.find((a) => a.startsWith("--engine="))?.split("=")[1] ?? "claude";
const headed = args.includes("--headed");
const only = args.filter((a) => !a.startsWith("--"));
const OUT = new URL("./out/shots/", import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const EXT = path.resolve("dist");
const CHROMIUM = path.join(os.homedir(), "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");

const PAGES = [
  ["hn-front", "https://news.ycombinator.com/"],
  ["bbc-article", { from: "https://www.bbc.co.uk/news", pick: 'a[href*="/news/articles/"]' }],
  ["wikipedia", "https://en.wikipedia.org/wiki/Espresso"],
  ["reddit", "https://www.reddit.com/r/AskReddit/top/?t=day"],
  ["github", "https://github.com/facebook/react"],
  ["guardian", { from: "https://www.theguardian.com/uk", pick: 'a[href*="/2026/"]' }],
  ["youtube-en-search", "https://www.youtube.com/results?search_query=fresh+pasta+recipe"],
  ["youtube-es-search", "https://www.youtube.com/results?search_query=receta+pasta+fresca"],
];

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "esx-e2e-"));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROMIUM,
  headless: !headed,
  viewport: { width: 1440, height: 900 },
  locale: "en-GB",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, ...(headed ? [] : ["--headless=new"])],
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent("serviceworker", { timeout: 15000 });
const extId = sw.url().split("/")[2];
console.log("extension loaded:", extId, "engine:", engine);

await sw.evaluate(async ({ settings }) => chrome.storage.local.set({ settings }), {
  settings: { ...DEFAULTS, engine, apiKey: process.env.ANTHROPIC_API_KEY, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID ?? "" },
});
for (const p of ctx.pages()) if (p.url().includes(extId)) await p.close();

// How Spanish is the text currently on screen? (share of words in recognisably-Spanish lines)
async function viewportLang(page) {
  const lines = await page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.nodeValue.trim();
      if (t.length < 12 || !/\p{L}{3}/u.test(t)) continue;
      const el = n.parentElement;
      if (!el || ["SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE"].includes(el.tagName)) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.width < 2 || !el.checkVisibility()) continue;
      out.push(t);
    }
    return out;
  });
  let es = 0, other = 0;
  for (const t of lines) {
    const g = guessLang(t);
    if (!g.confident) continue;
    if (g.lang === "es") es += t.length;
    else other += t.length;
  }
  const english = lines.filter((t) => { const g = guessLang(t); return g.confident && g.lang !== "es"; });
  return { es, other, share: es + other ? es / (es + other) : 0, sample: lines.slice(0, 3), english: english.slice(0, 8) };
}

async function dismissConsent(page) {
  if (/consent\.(youtube|google)\.com/.test(page.url())) {
    await page.getByRole("button", { name: /reject all|rechazar todo/i }).first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
  }
}

const results = [];
for (const [id, target] of PAGES) {
  if (only.length && !only.includes(id)) continue;
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__esxInfo = [];
    addEventListener("esx-yt-info", (e) => window.__esxInfo.push(e.detail));
  });
  try {
    let url = target;
    if (typeof target === "object") {
      await page.goto(target.from, { waitUntil: "domcontentloaded", timeout: 45000 });
      await dismissConsent(page);
      await page.waitForTimeout(2500);
      url = await page.$eval(target.pick, (a) => a.href);
    }
    const t0 = Date.now();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await dismissConsent(page);
    let firstMs = null;
    let mostlyMs = null;
    let last;
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(250);
      last = await viewportLang(page).catch(() => null);
      if (!last) continue;
      if (firstMs === null && last.es > 0) firstMs = Date.now() - t0;
      if (last.share >= 0.85) {
        mostlyMs = Date.now() - t0;
        break;
      }
    }
    await page.waitForTimeout(1500);
    last = await viewportLang(page);
    await page.screenshot({ path: `${OUT}${id}.png` });
    const row = {
      id,
      finalUrl: page.url().slice(0, 90),
      firstSpanishMs: firstMs,
      viewport85pctMs: mostlyMs,
      spanishShare: +last.share.toFixed(2),
      sample: last.sample.map((s) => s.slice(0, 70)),
      leftEnglish: last.english.map((s) => s.slice(0, 60)),
    };
    if (id.startsWith("youtube")) {
      row.tiles = await page.evaluate(() => {
        const c = {};
        for (const el of document.querySelectorAll("[data-esx-yt]")) c[el.getAttribute("data-esx-yt")] = (c[el.getAttribute("data-esx-yt")] ?? 0) + 1;
        return c;
      });
      row.cookiePref = (await ctx.cookies("https://www.youtube.com")).find((c) => c.name === "PREF")?.value;
    }
    results.push(row);
    console.log(JSON.stringify(row));
  } catch (e) {
    console.log(JSON.stringify({ id, error: e.message.slice(0, 200) }));
  } finally {
    await page.close();
  }
}

const usage = await sw.evaluate(async () => (await chrome.storage.local.get("usage")).usage);
console.log("usage recorded by the extension:", JSON.stringify(usage));
fs.writeFileSync(new URL("./out/e2e-" + engine + ".json", import.meta.url), JSON.stringify({ results, usage }, null, 1));
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
