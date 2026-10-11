// Screenshots while a page is being translated (fresh cache) and after.
import "./env.mjs";
import { chromium } from "playwright";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { DEFAULTS } from "../src/shared/settings.js";
const [url, name = "loading"] = process.argv.slice(2);
const EXT = path.resolve("dist");
const CHROMIUM = path.join(os.homedir(), "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "esx-ld-"));
const ctx = await chromium.launchPersistentContext(profile, { executablePath: CHROMIUM, headless: true, viewport: { width: 1280, height: 800 }, locale: "en-GB",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new"] });
let [sw] = ctx.serviceWorkers(); sw ??= await ctx.waitForEvent("serviceworker");
await sw.evaluate(async (s) => chrome.storage.local.set({ settings: s }), { ...DEFAULTS, apiKey: process.env.ANTHROPIC_API_KEY, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID });
const page = await ctx.newPage();
const t0 = Date.now();
await page.goto(url, { waitUntil: "commit" });
const log = [];
for (const at of [700, 1200, 1800, 2600, 4000]) {
  await page.waitForTimeout(Math.max(0, at - (Date.now() - t0)));
  const st = await page.evaluate(() => ({
    pending: document.querySelectorAll(".esx-pending").length,
    spinner: document.querySelector("#esx-spinner.on") ? "on" : "off",
    englishVisible: [...document.querySelectorAll("h1, h2, h3, p, a, li")].filter((e) => e.checkVisibility() && !e.closest(".esx-pending") && e.getBoundingClientRect().top < innerHeight && /\b(the|and|with|from|this|that|have)\b/i.test(e.textContent)).length,
  })).catch(() => ({}));
  log.push({ ms: at, ...st });
  await page.screenshot({ path: `bench/out/shots/${name}-${at}.png` });
}
console.log(JSON.stringify(log));
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
