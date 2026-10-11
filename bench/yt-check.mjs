// What is actually visible on YouTube with the extension: titles of visible videos,
// any visible Shorts, and the /shorts/ redirect.
import "./env.mjs";
import { chromium } from "playwright";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { DEFAULTS } from "../src/shared/settings.js";
const EXT = path.resolve("dist");
const CHROMIUM = path.join(os.homedir(), "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "esx-ytc-"));
const ctx = await chromium.launchPersistentContext(profile, { executablePath: CHROMIUM, headless: true, viewport: { width: 1440, height: 900 }, locale: "en-GB",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new"] });
let [sw] = ctx.serviceWorkers(); sw ??= await ctx.waitForEvent("serviceworker");
await sw.evaluate(async (s) => chrome.storage.local.set({ settings: s }), { ...DEFAULTS, apiKey: process.env.ANTHROPIC_API_KEY, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID });
const page = await ctx.newPage();
async function go(url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  if (/consent\./.test(page.url())) { await page.getByRole("button", { name: /reject all|rechazar todo/i }).first().click().catch(() => {}); await page.waitForLoadState("domcontentloaded"); }
  await page.waitForTimeout(5000);
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 1800); await page.waitForTimeout(800); }
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(800);
}
const visible = () => page.evaluate(() => {
  const vis = (el) => el.checkVisibility() && el.getBoundingClientRect().height > 2;
  const tiles = [...document.querySelectorAll("ytd-rich-item-renderer, ytd-video-renderer, yt-lockup-view-model, ytd-compact-video-renderer")].filter((t) => !t.parentElement.closest("ytd-rich-item-renderer, ytd-video-renderer, yt-lockup-view-model"));
  const shown = tiles.filter(vis).map((t) => t.dataset.esxYtTitle ?? "(unclassified) " + (t.querySelector("h3, #video-title")?.textContent.trim().slice(0, 60) ?? ""));
  const shorts = [...document.querySelectorAll("ytd-reel-shelf-renderer, ytd-rich-shelf-renderer[is-shorts], ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, grid-shelf-view-model, a[href^='/shorts/']")].filter(vis).length;
  const shortsNav = [...document.querySelectorAll("ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer, yt-tab-shape, yt-chip-cloud-chip-renderer, chip-view-model")].filter((e) => vis(e) && /^\s*Shorts\s*$/.test(e.textContent)).length;
  return { total: tiles.length, shown, shortsVisible: shorts, shortsNavVisible: shortsNav };
});
for (const [name, url] of [
  ["search EN", "https://www.youtube.com/results?search_query=fresh+pasta+recipe"],
  ["search ES", "https://www.youtube.com/results?search_query=receta+pasta+fresca"],
  ["home", "https://www.youtube.com/"],
  ["channel", "https://www.youtube.com/@MrBeast/videos"],
]) {
  await go(url);
  const v = await visible();
  console.log(`\n== ${name}: ${v.shown.length} of ${v.total} tiles visible · Shorts visible: ${v.shortsVisible} · Shorts nav/chips/tabs visible: ${v.shortsNavVisible}`);
  for (const t of v.shown.slice(0, 14)) console.log("   ", t.slice(0, 90));
  await page.screenshot({ path: `bench/out/shots/yt-${name.replace(" ", "-").toLowerCase()}.png` });
}
// Watch page sidebar, from a Spanish search result.
await go("https://www.youtube.com/results?search_query=receta+pasta+fresca");
const watch = await page.$eval("a#video-title[href^='/watch']", (a) => a.href).catch(() => null);
if (watch) {
  await go(watch);
  const v = await visible();
  console.log(`\n== watch sidebar: ${v.shown.length} of ${v.total} visible · Shorts visible: ${v.shortsVisible}`);
  for (const t of v.shown.slice(0, 10)) console.log("   ", t.slice(0, 90));
}
await page.goto("https://www.youtube.com/shorts/dQw4w9WgXcQ", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
console.log("\n/shorts/ link ends up at:", page.url());
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
