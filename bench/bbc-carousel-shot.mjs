import "./env.mjs";
import { chromium } from "playwright";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { DEFAULTS } from "../src/shared/settings.js";
const EXT = path.resolve("dist");
const CHROMIUM = path.join(os.homedir(), "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "esx-bbcs-"));
const ctx = await chromium.launchPersistentContext(profile, { executablePath: CHROMIUM, headless: true, viewport: { width: 1440, height: 900 }, locale: "en-GB",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new"] });
let [sw] = ctx.serviceWorkers(); sw ??= await ctx.waitForEvent("serviceworker");
await sw.evaluate(async (s) => chrome.storage.local.set({ settings: s }), { ...DEFAULTS, apiKey: process.env.ANTHROPIC_API_KEY, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID });
const page = await ctx.newPage();
await page.goto("https://www.bbc.co.uk/news", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
const carousel = page.locator('[data-testid="carousel-item"]').first();
await carousel.scrollIntoViewIfNeeded();
await page.waitForTimeout(3500);
const box = await page.locator('ul[role="list"]:has([data-testid="carousel-item"])').first().boundingBox();
await page.screenshot({ path: "bench/out/shots/bbc-carousel.png", clip: { x: 0, y: Math.max(0, box.y - 20), width: 1440, height: Math.min(560, box.height + 40) } });
// Swipe the carousel to the right and check the next cards are already Spanish.
await page.locator('[data-testid="carousel-item"]').nth(8).scrollIntoViewIfNeeded().catch(() => {});
await page.waitForTimeout(300);
console.log(await page.evaluate(() => [...document.querySelectorAll('[data-testid="carousel-item"] [aria-hidden="true"]')].map((e) => e.textContent.trim()).filter(Boolean).slice(0, 12).join(" | ")));
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
