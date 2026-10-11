// Load one page with the extension and dump what the content script did + console errors.
import "./env.mjs";
import { chromium } from "playwright";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { DEFAULTS } from "../src/shared/settings.js";
const [url, pick] = process.argv.slice(2);
const EXT = path.resolve("dist");
const CHROMIUM = path.join(os.homedir(), "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "esx-dbg-"));
const ctx = await chromium.launchPersistentContext(profile, { executablePath: CHROMIUM, headless: true, viewport: { width: 1440, height: 900 }, locale: "en-GB",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new"] });
let [sw] = ctx.serviceWorkers(); sw ??= await ctx.waitForEvent("serviceworker");
await sw.evaluate(async (s) => chrome.storage.local.set({ settings: s }), { ...DEFAULTS, apiKey: process.env.ANTHROPIC_API_KEY, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID });
const page = await ctx.newPage();
page.on("console", (m) => { if (/error|warn/i.test(m.type()) || /esx/i.test(m.text())) console.log("console", m.type(), m.text().slice(0, 300)); });
page.on("pageerror", (e) => console.log("pageerror", e.message.slice(0, 300)));
sw.on("console", (m) => console.log("sw", m.type(), m.text().slice(0, 300)));
let target = url;
if (pick) { await page.goto(url, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(2500); target = await page.$eval(pick, (a) => a.href); }
await page.goto(target, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
console.log(JSON.stringify(await page.evaluate(() => ({
  url: location.href,
  htmlClass: document.documentElement.className,
  styleInjected: !!document.querySelector("style[data-esx]"),
  pending: document.querySelectorAll(".esx-pending").length,
  lang: document.documentElement.lang,
  h1: document.querySelector("h1")?.textContent?.slice(0, 100),
  firstP: [...document.querySelectorAll("p")].map((p) => p.textContent.trim()).filter((t) => t.length > 60)[0]?.slice(0, 160),
  iframes: [...document.querySelectorAll("iframe")].map((f) => f.src.slice(0, 80)).slice(0, 5),
}))), null, 1);
await page.screenshot({ path: "bench/out/shots/debug.png" });
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true });
