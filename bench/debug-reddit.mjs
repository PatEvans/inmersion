// old.reddit with the extension: are post titles translated? Logs SW warnings.
import "./env.mjs";
import { chromium } from "playwright";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { DEFAULTS } from "../src/shared/settings.js";
const url = process.argv[2] ?? "https://old.reddit.com/r/gaming/";
const EXT = path.resolve("dist");
const CHROMIUM = path.join(os.homedir(), "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "esx-rd-"));
const ctx = await chromium.launchPersistentContext(profile, { executablePath: CHROMIUM, headless: true, viewport: { width: 1440, height: 900 }, locale: "en-GB",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new"] });
let [sw] = ctx.serviceWorkers(); sw ??= await ctx.waitForEvent("serviceworker");
sw.on("console", (m) => console.log("SW:", m.type(), m.text().slice(0, 300)));
await sw.evaluate(async (s) => chrome.storage.local.set({ settings: s }), { ...DEFAULTS, apiKey: process.env.ANTHROPIC_API_KEY, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(9000);
const titles = await page.evaluate(() => [...document.querySelectorAll("p.title")].slice(0, 12).map((p) => p.innerText.trim().slice(0, 110)));
console.log(titles.length ? titles.join("\n") : "no titles (blocked?): " + (await page.title()));
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
