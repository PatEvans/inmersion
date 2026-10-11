// Screenshots of the popup and settings page (light + dark) with realistic state.
import { chromium } from "playwright";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { DEFAULTS } from "../src/shared/settings.js";
const EXT = path.resolve("dist");
const CHROMIUM = path.join(os.homedir(), "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "esx-ui-"));
const ctx = await chromium.launchPersistentContext(profile, { executablePath: CHROMIUM, headless: true, deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new"] });
let [sw] = ctx.serviceWorkers(); sw ??= await ctx.waitForEvent("serviceworker");
const id = sw.url().split("/")[2];
const d = new Date(); const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
await sw.evaluate(async ({ s, day }) => chrome.storage.local.set({ settings: s, usage: { [day]: { cost: 0.0042, chars: 21000, requests: 30 } } }),
  { s: { ...DEFAULTS, apiKey: "sk-ant-test" }, day });
for (const p of ctx.pages()) if (p.url().includes(id)) await p.close();
for (const scheme of ["light", "dark"]) {
  const page = await ctx.newPage();
  await page.emulateMedia({ colorScheme: scheme });
  await page.addInitScript(() => { const q = chrome.tabs.query; chrome.tabs.query = async () => [{ url: "https://www.bbc.co.uk/news" }]; void q; });
  await page.setViewportSize({ width: 290, height: 220 });
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.waitForTimeout(600);
  const h = await page.evaluate(() => document.body.scrollHeight);
  await page.setViewportSize({ width: 290, height: h });
  await page.screenshot({ path: `bench/out/shots/popup-${scheme}.png` });
  await page.setViewportSize({ width: 640, height: 900 });
  await page.goto(`chrome-extension://${id}/options.html?welcome=1`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `bench/out/shots/options-${scheme}.png`, fullPage: true });
  await page.close();
}
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
console.log("ok");
