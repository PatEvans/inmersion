import { chromium } from "playwright";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const CHROMIUM = path.join(os.homedir(), "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "esx-cc-"));
const ctx = await chromium.launchPersistentContext(profile, { executablePath: CHROMIUM, headless: true, viewport: { width: 1440, height: 900 }, args: ["--headless=new", "--autoplay-policy=no-user-gesture-required"] });
await ctx.addCookies([{ name: "SOCS", value: "CAI", domain: ".youtube.com", path: "/" }, { name: "PREF", value: "hl=es&gl=ES", domain: ".youtube.com", path: "/" }]);
const page = await ctx.newPage();
await page.goto("https://www.youtube.com/watch?v=dQw4w9WgXcQ", { waitUntil: "domcontentloaded" });
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => {
    const p = document.getElementById("movie_player");
    if (!p?.getOption) return { noPlayer: true };
    const r = p.getPlayerResponse?.()?.captions?.playerCaptionsTracklistRenderer;
    return {
      state: p.getPlayerState?.(),
      options: p.getOptions?.(),
      tracklist: (p.getOption("captions", "tracklist", { includeAsr: true }) ?? []).map((t) => `${t.languageCode}/${t.kind ?? "-"}`),
      tl: (p.getOption("captions", "translationLanguages") ?? []).length,
      prTracks: (r?.captionTracks ?? []).map((t) => `${t.languageCode}/${t.kind ?? "-"}`),
      err: document.querySelector(".ytp-error")?.textContent?.slice(0, 80),
    };
  });
  console.log(i, JSON.stringify(st));
}
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
