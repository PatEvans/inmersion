// Watch-page test: does the player script pick Spanish audio / captions?
import "./env.mjs";
import { chromium } from "playwright";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { DEFAULTS } from "../src/shared/settings.js";
const ids = process.argv.slice(2);
const EXT = path.resolve("dist");
const CHROMIUM = path.join(os.homedir(), "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "esx-ytw-"));
const ctx = await chromium.launchPersistentContext(profile, { executablePath: CHROMIUM, headless: true, viewport: { width: 1440, height: 900 }, locale: "en-GB",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new", "--autoplay-policy=no-user-gesture-required"] });
let [sw] = ctx.serviceWorkers(); sw ??= await ctx.waitForEvent("serviceworker");
await sw.evaluate(async (s) => chrome.storage.local.set({ settings: s }), { ...DEFAULTS, apiKey: process.env.ANTHROPIC_API_KEY, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID });
const page = await ctx.newPage();
await page.addInitScript(() => { window.__esxInfo = []; addEventListener("esx-yt-info", (e) => window.__esxInfo.push(JSON.parse(e.detail))); });
for (const id of ids) {
  await page.goto(`https://www.youtube.com/watch?v=${id}`, { waitUntil: "domcontentloaded" });
  if (/consent\./.test(page.url())) { await page.getByRole("button", { name: /reject all|rechazar todo/i }).first().click().catch(() => {}); await page.waitForLoadState("domcontentloaded"); }
  await page.waitForTimeout(3000);
  // Like a viewer would: make sure the video is playing (headless doesn't always autoplay).
  await page.evaluate(() => document.getElementById("movie_player")?.playVideo?.());
  await page.waitForFunction(() => window.__esxInfo?.length > 0, null, { timeout: 45000 }).catch(() => {});
  const st = await page.evaluate(() => {
    const p = document.getElementById("movie_player");
    const tid = (t) => { try { return t.getLanguageInfo().getId(); } catch { return String(t?.id); } };
    let cc = null; try { cc = p.getOption("captions", "track"); } catch {}
    return {
      title: p?.getPlayerResponse?.()?.videoDetails?.title?.slice(0, 60),
      shownTitle: document.querySelector("h1 yt-formatted-string, h1")?.textContent?.trim().slice(0, 60),
      tracks: (p?.getAvailableAudioTracks?.() ?? []).map(tid),
      current: tid(p?.getAudioTrack?.()),
      captions: cc && cc.languageCode ? `${cc.languageCode}${cc.translationLanguage ? " → " + cc.translationLanguage.languageCode : ""} (${cc.kind || "manual"})` : null,
      info: window.__esxInfo.at(-1),
      opts: p?.getOptions?.(),
      list: (p?.getOption?.("captions", "tracklist", { includeAsr: true }) ?? []).map((t) => t.languageCode + "/" + (t.kind || "")),
      state: p?.getPlayerState?.(),
      url: location.href.slice(-20),
    };
  });
  console.log(id, JSON.stringify(st));
}
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
