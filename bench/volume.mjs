// Benchmark 1: how much text does "everything I see" actually contain?
// Loads real pages in headless Chrome, runs the extension's segmenter, and records every
// translation unit with its position, so we can price "first screen", "3 screens", "all".
import { chromium } from "playwright";
import fs from "node:fs";

const OUT = new URL("./out/", import.meta.url).pathname;
const INJECT = fs.readFileSync(OUT + "inject.bundle.js", "utf8");
const VIEW = { width: 1440, height: 900 };

// [id, url | {from, pick}] — "pick" follows the first matching link on another page.
const PAGES = [
  ["wikipedia-espresso", "https://en.wikipedia.org/wiki/Espresso"],
  ["wikipedia-madrid", "https://en.wikipedia.org/wiki/Madrid"],
  ["bbc-news-home", "https://www.bbc.co.uk/news"],
  ["bbc-news-article", { from: "https://www.bbc.co.uk/news", pick: 'a[href*="/news/articles/"]' }],
  ["guardian-home", "https://www.theguardian.com/uk"],
  ["guardian-article", { from: "https://www.theguardian.com/uk", pick: 'a[href*="/2026/"]' }],
  ["hn-front", "https://news.ycombinator.com/"],
  ["hn-comments", { from: "https://news.ycombinator.com/", pick: 'span.subline a[href^="item?id="]:last-child' }],
  ["reddit-sub", "https://www.reddit.com/r/AskReddit/top/?t=day"],
  ["reddit-thread", { from: "https://www.reddit.com/r/AskReddit/top/?t=day", pick: 'a[href*="/comments/"]' }],
  ["github-repo", "https://github.com/facebook/react"],
  ["mdn-docs", "https://developer.mozilla.org/en-US/docs/Web/API/IntersectionObserver"],
  ["stackoverflow-q", "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array"],
  ["youtube-search", "https://www.youtube.com/results?search_query=how+to+make+fresh+pasta"],
  ["youtube-watch", { from: "https://www.youtube.com/results?search_query=how+to+make+fresh+pasta", pick: "a#video-title[href^='/watch'], a[href^='/watch?v=']" }],
  ["apple-uk", "https://www.apple.com/uk/"],
  ["amazon-product", "https://www.amazon.co.uk/dp/B0CHX3QBCH"],
  ["medium-article", "https://medium.com/@karpathy/software-2-0-a64152b37c35"],
];

const only = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({
  viewport: VIEW,
  bypassCSP: true,
  locale: "en-GB",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
});

async function dismissConsent(page) {
  // Pick the most privacy-preserving option on cookie walls (reject, not accept).
  if (/consent\.(youtube|google)\.com/.test(page.url())) {
    await page.getByRole("button", { name: /reject all/i }).first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(2500);
  }
}

async function load(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await dismissConsent(page);
  await page.waitForTimeout(3500);
}

// Same rule the extension uses: rendered, bigger than 1px, and not parked off-page.
const onPage = (u) => u.visible && u.rect.top >= 0 && u.rect.w > 1 && u.rect.h > 1;
const summary = [];
for (const [id, target] of PAGES) {
  if (only.length && !only.includes(id)) continue;
  const page = await ctx.newPage();
  try {
    let url = target;
    if (typeof target === "object") {
      await load(page, target.from);
      url = await page.$eval(target.pick, (a) => a.href).catch(() => null);
      if (!url) throw new Error("no link matched " + target.pick);
    }
    await load(page, url);
    // Scroll down five screens and back so lazy content renders, like a reader would.
    for (let i = 1; i <= 5; i++) {
      await page.mouse.wheel(0, VIEW.height);
      await page.waitForTimeout(700);
    }
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(800);
    await page.evaluate(INJECT);
    const data = await page.evaluate(() => window.__esxBench.collect());
    data.id = id;
    fs.writeFileSync(`${OUT}volume-${id}.json`, JSON.stringify(data, null, 1));
    const vis = data.units.filter(onPage);
    const inScreens = (n) => vis.filter((u) => u.rect.top < n * VIEW.height);
    const chars = (us) => us.reduce((s, u) => s + u.source.length, 0);
    const row = {
      id,
      units: data.units.length,
      visible: vis.length,
      chars_screen1: chars(inScreens(1)),
      chars_3screens: chars(inScreens(3)),
      chars_visible_all: chars(vis),
      chars_all: chars(data.units),
      screens: Math.ceil(data.pageHeight / VIEW.height),
      tagged_pct: Math.round((100 * vis.filter((u) => !u.plain).length) / Math.max(1, vis.length)),
      lang: data.lang,
      hreflangEs: data.hreflangEs.join(","),
      title: data.title.slice(0, 60),
    };
    summary.push(row);
    console.log(JSON.stringify(row));
  } catch (e) {
    console.log(JSON.stringify({ id, error: String(e.message).slice(0, 200) }));
  } finally {
    await page.close();
  }
}
if (!only.length) fs.writeFileSync(OUT + "volume-summary.json", JSON.stringify(summary, null, 1));
await browser.close();
