// Bundled into an IIFE and injected into pages by the benchmarks: runs the extension's
// real segmenter and reports every unit with its on-screen position.
import { scan, applyTranslation } from "../src/content/segment.js";

const units = [];
function collect() {
  units.length = 0;
  const out = [];
  scan(document.body, (u) => units.push(u));
  for (const u of units) {
    const el = u.anchor;
    let rect = null;
    let visible = false;
    if (el) {
      const r = el.getBoundingClientRect();
      rect = { top: r.top + scrollY, bottom: r.bottom + scrollY, w: r.width, h: r.height };
      visible = r.width > 0 && r.height > 0 && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    out.push({ id: u.id, source: u.source, plain: u.plain, tags: u.ids.size, rect, visible });
  }
  return {
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang,
    viewport: { w: innerWidth, h: innerHeight },
    pageHeight: document.documentElement.scrollHeight,
    hreflangEs: [...document.querySelectorAll('link[rel="alternate"][hreflang]')]
      .map((l) => l.hreflang).filter((h) => /^es\b/i.test(h)),
    units: out,
  };
}
function apply(map) {
  let ok = 0, partial = 0;
  for (const u of units) {
    if (map[u.id] === undefined) continue;
    applyTranslation(u, map[u.id]) ? ok++ : partial++;
  }
  return { ok, partial };
}
window.__esxBench = { collect, apply };
