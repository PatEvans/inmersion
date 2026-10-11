// Renders the extension icon (an ñ on a warm gradient) to PNGs with headless Chrome.
import { chromium } from "playwright";
const svg = (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 128 128">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c2410c"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs>
<rect width="128" height="128" rx="28" fill="url(#g)"/>
<text x="64" y="${s <= 16 ? 100 : 96}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="${s <= 16 ? 112 : 100}" fill="#fff">ñ</text></svg>`;
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
for (const s of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: s, height: s });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(s)}</body></html>`);
  await page.screenshot({ path: `src/icons/${s}.png`, omitBackground: true, clip: { x: 0, y: 0, width: s, height: s } });
}
await browser.close();
console.log("icons written");
