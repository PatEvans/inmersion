// Loads dist/ into your installed Chrome (throwaway profile) via the DevTools protocol and
// checks the free on-device engine works inside the extension's service worker.
//   node bench/local-sw.mjs [e2e]   (e2e: also browse a page with engine=local)
import { chromium } from "playwright";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { DEFAULTS } from "../src/shared/settings.js";
const EXT = path.resolve("dist");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "esx-lsw-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chrome", headless: true, viewport: { width: 1440, height: 900 }, locale: "en-GB",
  args: ["--enable-unsafe-extension-debugging"],
  ignoreDefaultArgs: ["--disable-extensions", "--disable-component-update", "--disable-background-networking"],
});
const cdp = await ctx.browser()?.newBrowserCDPSession?.() ?? await ctx.newCDPSession(await ctx.newPage());
let extId;
try {
  ({ id: extId } = await cdp.send("Extensions.loadUnpacked", { path: EXT }));
} catch (e) {
  console.log("loadUnpacked failed:", e.message);
  process.exit(0);
}
console.log("loaded extension", extId);
let sw = ctx.serviceWorkers().find((w) => w.url().includes(extId));
sw ??= await ctx.waitForEvent("serviceworker", { predicate: (w) => w.url().includes(extId), timeout: 15000 });
console.log("Translator in SW:", await sw.evaluate(() => typeof Translator), "LanguageDetector:", await sw.evaluate(() => typeof LanguageDetector));
const t0 = Date.now();
const r = await sw.evaluate(async () => {
  const t = await Translator.create({ sourceLanguage: "en", targetLanguage: "es" });
  return t.translate("This is <1>very</1> important. Settings");
}).catch((e) => "error: " + e.message);
console.log(`create+translate in SW (${Date.now() - t0} ms):`, r);
if (process.argv[2] === "e2e") {
  await sw.evaluate(async (s) => chrome.storage.local.set({ settings: s }), { ...DEFAULTS, engine: "local" });
  const page = await ctx.newPage();
  await page.goto("https://news.ycombinator.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  console.log("HN with local engine:", await page.evaluate(() => [...document.querySelectorAll(".titleline > a, .pagetop a")].slice(0, 8).map((a) => a.textContent).join(" | ")));
  await page.screenshot({ path: "bench/out/shots/hn-local.png" });
  console.log("usage:", JSON.stringify(await sw.evaluate(async () => (await chrome.storage.local.get("usage")).usage)));
}
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
