// Runs the built youtube-player.js in your installed Chrome (headless, throwaway profile)
// against real videos that actually play, to verify caption/audio selection.
import { chromium } from "playwright";
import fs from "node:fs";
const ids = process.argv.slice(2);
const code = fs.readFileSync("dist/youtube-player.js", "utf8");
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-GB" });
await ctx.addCookies([{ name: "SOCS", value: "CAI", domain: ".youtube.com", path: "/" }, { name: "PREF", value: "hl=es&gl=ES", domain: ".youtube.com", path: "/" }]);
await ctx.addInitScript(() => {
  window.__esxInfo = [];
  addEventListener("esx-yt-info", (e) => window.__esxInfo.push(JSON.parse(e.detail)));
  const set = () => document.documentElement?.setAttribute("data-esx-yt-cfg", JSON.stringify({ base: "es", code: "es-ES", audio: true, captions: "auto" }));
  set(); document.addEventListener("readystatechange", set);
});
await ctx.addInitScript({ content: code });
const page = await ctx.newPage();
for (const id of ids) {
  await page.goto(`https://www.youtube.com/watch?v=${id}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.evaluate(() => document.getElementById("movie_player")?.playVideo?.());
  await page.waitForFunction(() => window.__esxInfo?.length > 0, null, { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const st = await page.evaluate(() => {
    const p = document.getElementById("movie_player");
    let cc = null; try { cc = p.getOption("captions", "track"); } catch {}
    return {
      state: p?.getPlayerState?.(),
      info: window.__esxInfo.at(-1) ?? null,
      captionsNow: cc?.languageCode ? `${cc.languageCode}${cc.translationLanguage ? " → " + cc.translationLanguage.languageCode : ""} ${cc.kind || "manual"}` : null,
      captionsVisible: !!document.querySelector(".ytp-caption-segment"),
      captionText: document.querySelector(".ytp-caption-segment")?.textContent?.slice(0, 60),
    };
  });
  console.log(id, JSON.stringify(st));
}
await browser.close();
