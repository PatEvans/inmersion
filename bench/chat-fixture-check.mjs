// Chat fixture through the real extension; records every request body sent to the API to
// check secrets never leave the browser and that context is attached.
import "./env.mjs";
import { chromium } from "playwright";
import http from "node:http"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { DEFAULTS } from "../src/shared/settings.js";
const server = http.createServer((q, r) => { if (q.url !== "/") return r.writeHead(404).end(); r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(fs.readFileSync("bench/fixtures/chat.html")); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const EXT = path.resolve("dist");
const CHROMIUM = path.join(os.homedir(), "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "esx-chat-"));
const ctx = await chromium.launchPersistentContext(profile, { executablePath: CHROMIUM, headless: true, viewport: { width: 1000, height: 700 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new"] });
let [sw] = ctx.serviceWorkers(); sw ??= await ctx.waitForEvent("serviceworker");
await sw.evaluate(() => {
  const real = globalThis.fetch;
  globalThis.__bodies = [];
  globalThis.fetch = async (url, opts) => { if (/anthropic|googleapis/.test(String(url))) globalThis.__bodies.push(String(opts?.body ?? "")); return real(url, opts); };
});
await sw.evaluate(async (s) => chrome.storage.local.set({ settings: s }), { ...DEFAULTS, apiKey: process.env.ANTHROPIC_API_KEY, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID });
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForTimeout(6000);
console.log(await page.evaluate(() => [...document.querySelectorAll(".when, .day, .msg")].map((e) => e.innerText.replace(/\n/g, " ")).join("\n")));
const bodies = await sw.evaluate(() => globalThis.__bodies);
const all = bodies.join("\n");
console.log(`\n${bodies.length} API requests | fake key sent: ${all.includes("FAKEKEYFORTESTINGONLY") ? "YES ✗" : "no ✓"} | context lines sent: ${(all.match(/Before: /g) ?? []).length}`);
const sample = bodies.map((b) => { try { return JSON.parse(b).messages[0].content; } catch { return ""; } }).find((m) => m.includes("dont use it"));
console.log("\nrequest containing 'dont use it lol':\n" + sample);
await ctx.close(); server.close(); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
