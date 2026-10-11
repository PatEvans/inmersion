// Serves bench/fixtures/*.html locally and prints what the extension did to them.
import "./env.mjs";
import { chromium } from "playwright";
import http from "node:http"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { DEFAULTS } from "../src/shared/settings.js";
const [file, selector = "body"] = process.argv.slice(2);
const server = http.createServer((q, r) => {
  const f = path.join("bench/fixtures", path.basename(q.url.split("?")[0]) || file);
  if (!fs.existsSync(f)) return r.writeHead(404).end();
  r.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  r.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const EXT = path.resolve("dist");
const CHROMIUM = path.join(os.homedir(), "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "esx-fx-"));
const ctx = await chromium.launchPersistentContext(profile, { executablePath: CHROMIUM, headless: true, viewport: { width: 1000, height: 700 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new"] });
let [sw] = ctx.serviceWorkers(); sw ??= await ctx.waitForEvent("serviceworker");
await sw.evaluate(async (s) => chrome.storage.local.set({ settings: s }), { ...DEFAULTS, apiKey: process.env.ANTHROPIC_API_KEY, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID });
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/${file}`);
await page.waitForTimeout(5000);
console.log(await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((e) => e.innerText.replace(/\n+/g, " | ")).join("\n"), selector));
await page.screenshot({ path: `bench/out/shots/fixture-${file.replace(".html", "")}.png` });
await ctx.close(); server.close(); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
