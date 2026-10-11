// Dump YouTube tiles with the filter's verdict and the original title.
import "./env.mjs";
import { chromium } from "playwright";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { DEFAULTS } from "../src/shared/settings.js";
const queries = process.argv.slice(2);
const EXT = path.resolve("dist");
const CHROMIUM = path.join(os.homedir(), "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "esx-yt-"));
const ctx = await chromium.launchPersistentContext(profile, { executablePath: CHROMIUM, headless: true, viewport: { width: 1440, height: 900 }, locale: "en-GB",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new"] });
let [sw] = ctx.serviceWorkers(); sw ??= await ctx.waitForEvent("serviceworker");
await sw.evaluate(async (s) => chrome.storage.local.set({ settings: s }), { ...DEFAULTS, apiKey: process.env.ANTHROPIC_API_KEY, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID });
const page = await ctx.newPage();
const all = [];
for (const q of queries) {
  await page.goto("https://www.youtube.com/results?search_query=" + encodeURIComponent(q), { waitUntil: "domcontentloaded" });
  if (/consent\./.test(page.url())) { await page.getByRole("button", { name: /reject all|rechazar todo/i }).first().click().catch(() => {}); await page.waitForLoadState("domcontentloaded"); }
  await page.waitForTimeout(5000);
  const tiles = await page.evaluate(() => [...document.querySelectorAll("[data-esx-yt]")].map((t) => ({ state: t.getAttribute("data-esx-yt"), title: t.dataset.esxYtTitle })));
  for (const t of tiles) all.push({ q, ...t });
  console.log(`\n== ${q} ==`);
  for (const t of tiles) console.log(t.state.padEnd(5), t.title?.slice(0, 90));
}
fs.writeFileSync("bench/out/yt-tiles.json", JSON.stringify(all, null, 1));
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true });
