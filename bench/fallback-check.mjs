// The fallback chain inside the real extension. Google is simulated in the service worker
// (fake "ES:" translations) unless --real; Haiku can be forced to fail with --bad-key.
//   node bench/fallback-check.mjs <engine> [--bad-key] [--real]
import "./env.mjs";
import { chromium } from "playwright";
import http from "node:http"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { DEFAULTS } from "../src/shared/settings.js";
const args = process.argv.slice(2);
const engine = args.find((a) => !a.startsWith("--")) ?? "google";
const server = http.createServer((q, r) => { const f = "bench/fixtures/tricky.html"; r.writeHead(q.url === "/" ? 200 : 404, { "content-type": "text/html; charset=utf-8" }); r.end(q.url === "/" ? fs.readFileSync(f) : ""); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const EXT = path.resolve("dist");
const CHROMIUM = path.join(os.homedir(), "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "esx-fb-"));
const ctx = await chromium.launchPersistentContext(profile, { executablePath: CHROMIUM, headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new"] });
let [sw] = ctx.serviceWorkers(); sw ??= await ctx.waitForEvent("serviceworker");
sw.on("console", (m) => /fall|fail/i.test(m.text()) && console.log("  SW:", m.text().slice(0, 140)));
if (!args.includes("--real")) {
  await sw.evaluate(() => {
    const real = globalThis.fetch;
    globalThis.__googleCalls = 0;
    globalThis.fetch = async (url, opts) => {
      if (!String(url).includes("translate.googleapis.com")) return real(url, opts);
      globalThis.__googleCalls++;
      const q = decodeURIComponent(opts.body.slice(2));
      // "Translate" by upper-casing the text and leaving the markers alone.
      const text = q.split("\n").map((l) => l.replace(/(<\/?\d+\/?>|<br>)|([^<]+)/g, (m, tag, txt) => tag ?? txt.toUpperCase())).join("\n");
      return new Response(JSON.stringify([text.split(/(?<=\n)/).map((s) => [s, "x"])]), { status: 200 });
    };
  });
}
await sw.evaluate(async (s) => chrome.storage.local.set({ settings: s }), {
  ...DEFAULTS, engine,
  apiKey: args.includes("--bad-key") ? "sk-ant-invalid-for-testing" : process.env.ANTHROPIC_API_KEY,
  workspaceId: process.env.ANTHROPIC_WORKSPACE_ID,
});
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForTimeout(6000);
const lines = await page.evaluate(() => [...document.querySelectorAll(".t")].map((e) => e.innerText.slice(0, 95)));
lines.forEach((l) => console.log("  " + l));
console.log("  google requests:", await sw.evaluate(() => globalThis.__googleCalls ?? "n/a (real)"), "| usage:", JSON.stringify(await sw.evaluate(async () => Object.values((await chrome.storage.local.get("usage")).usage ?? {})[0] ?? {})));
await ctx.close(); server.close(); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
