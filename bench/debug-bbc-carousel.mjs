// Find the BBC video carousel cards and show why they weren't translated.
import "./env.mjs";
import { chromium } from "playwright";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { DEFAULTS } from "../src/shared/settings.js";
const EXT = path.resolve("dist");
const CHROMIUM = path.join(os.homedir(), "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "esx-bbc-"));
const ctx = await chromium.launchPersistentContext(profile, { executablePath: CHROMIUM, headless: true, viewport: { width: 1440, height: 900 }, locale: "en-GB",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new"] });
let [sw] = ctx.serviceWorkers(); sw ??= await ctx.waitForEvent("serviceworker");
await sw.evaluate(async (s) => chrome.storage.local.set({ settings: s }), { ...DEFAULTS, apiKey: process.env.ANTHROPIC_API_KEY, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID });
const page = await ctx.newPage();
page.on("console", (m) => /Inmersi|esx/i.test(m.text()) && console.log("console:", m.text().slice(0, 200)));
await page.goto("https://www.bbc.co.uk/news", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
// Scroll through the page like a reader, then look for video-card headlines still in English.
for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 700); await page.waitForTimeout(700); }
await page.waitForTimeout(3000);
const found = await page.evaluate(() => {
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.nodeValue.trim();
    if (t.length < 20 || !/\b(the|you|your|what|when|is|do|in|of|about|should|would|why|how)\b/i.test(t)) continue;
    const el = n.parentElement;
    if (!el || !el.checkVisibility() || el.closest("script,style,noscript")) continue;
    const chain = [];
    for (let p = el; p && p !== document.body && chain.length < 9; p = p.parentElement) {
      const attrs = ["translate", "contenteditable", "aria-hidden", "role", "data-testid"].filter((a) => p.hasAttribute(a)).map((a) => `${a}=${p.getAttribute(a)}`);
      const cs = getComputedStyle(p);
      chain.push(`${p.localName}${p.className && typeof p.className === "string" ? "." + p.className.split(/\s+/)[0].slice(0, 25) : ""}${attrs.length ? "[" + attrs.join(",") + "]" : ""}{${cs.display}${cs.position !== "static" ? "," + cs.position : ""}${p.classList.contains("esx-pending") ? ",PENDING" : ""}}`);
    }
    const r = el.getBoundingClientRect();
    out.push({ text: t.slice(0, 60), rect: [Math.round(r.left), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)], root: n.getRootNode() === document ? "doc" : "shadow", chain: chain.join(" < ") });
  }
  return out;
});
console.log(`${found.length} English text nodes still visible`);
for (const f of found.slice(0, 12)) console.log(JSON.stringify(f));
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
