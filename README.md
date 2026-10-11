# Inmersión

A personal Chrome extension that shows the whole web in Spanish (or any of 12 languages) for language immersion.

- **Text**: everything you see is translated in place with Claude Haiku 5.5, without breaking links, formatting or React/Vue apps.
- **Fallbacks**: without a key, past the daily budget, or if the API fails, Google Translate's free endpoint takes over. It's batched and paced, and backs off for 15+ minutes if Google rate-limits. Chrome's on-device translator is the last resort.
- **You never see English**: text waiting for its translation stays invisible behind a soft shimmer, with a small spinner in the corner. Content a screen ahead, and the rest of a carousel row, is translated before you reach it.
- **Native first**: sites are asked for Spanish (`Accept-Language`, `navigator.language`). If a page has its own Spanish version (`hreflang`, Wikipedia language links), you go there instead.
- **YouTube**:
  - Spanish interface and region.
  - Only videos in your language. If the extension can't tell, the video is hidden.
  - No Shorts.
  - Spanish dub when the video has one; otherwise Spanish captions, auto-translated if needed.
- **Context-aware**: each request carries the text just before and after it on the page (read-only), so short chat messages and labels are translated with their surroundings in mind ("dont use it lol" after "do u have whatsapp web?" → "no lo uso, jaja").
- **Privacy**: anything that looks like an API key, token, hash or bare URL is never sent for translation, not even as context.
- Hold <kbd>⌥</kbd> to peek at the original. <kbd>⌥⇧E</kbd> turns the current site on or off.

## Install

```sh
npm install
npm run build        # → dist/
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose `dist/`.
3. The settings page opens. Paste your Anthropic API key (and a workspace ID if your key needs one), then click **Probar**.

After changing the code, run `npm run build` and click ↻ on the extension card.

## Cost

These figures were measured on 18 real pages (news, Wikipedia, Reddit, Hacker News, GitHub, YouTube, Amazon…) with Haiku 5.5 at $0.10 / $0.50 per million tokens:

| | Per page (first 3 screens, first visit) | Per day | $20 lasts |
|---|---|---|---|
| Light: ~50 pages/day | $0.0017 | ~$0.09 | ~7 months |
| Medium: ~150 pages/day | | ~$0.26 | ~2.5 months |
| Heavy: ~400 pages/day | | capped at $0.50 | 40+ days, then free mode |

Repeated text is cached in IndexedDB and never paid for twice. The settings page shows real spend and how many days your balance will last.

## How it works

- `src/content/segment.js` splits the DOM into translation units: runs of inline text inside a block. Inline elements become numbered tags (`<1>link</1>`), and the translation is written back into the same text nodes; it never restructures the page.
- `src/content/main.js` tracks visibility with an IntersectionObserver plus a prefetch margin, and sends visible units first. It follows page changes with a MutationObserver and handles the shimmer/spinner, page titles, placeholders and native-version redirects.
- `src/background/` is the service worker. It holds the queue: deduplicated, with on-screen text in small batches first, then prefetch in larger batches, up to 24 parallel streamed requests. It also holds the cache, spend tracking, and the fallback chain: Haiku → Google (`google.js`) → Chrome's on-device `Translator`. Every line is checked to have the same marker nesting as its source; otherwise it's retried, then rebuilt from the text between the markers. That API works without a user gesture in an extension service worker.
- `src/shared/prompt.js` defines the prompt and wire format. Lines go out as `N: text` and stream back the same way, so each finished line is applied immediately. The system prompt (~1k tokens) is prompt-cached.
- `src/shared/detect.js` gives an instant language guess for short strings: character trigrams plus function words. It drives the YouTube filter, with Chrome's `LanguageDetector` as a second opinion.
- `src/content/youtube*.js` contains the feed filter, Shorts removal, `PREF` cookie, and the audio-track and caption selection, which uses the page-world player API.

## Benchmarks

Scripts are in `bench/` and their output goes to `bench/out/` (git-ignored). They read the key from a local `.env` containing `ANTHROPIC_API_KEY` and `ANTHROPIC_WORKSPACE_ID`.

| Script | What it measures | Result |
|---|---|---|
| `volume.mjs` + `analyze.mjs` | Text on real pages, as exact Haiku 5.5 tokens | First screen median ~1.1k tokens; 3 screens ~2k; ~2.2 chars/token |
| `haiku.mjs` | Haiku cost, latency, fidelity | $0.031 for 18 pages × 3 screens; 0 dropped lines; 2/302 tag slips. First screen 2.4 s with 1,000-char batches, 1.45 s with 200-char batches × 32 parallel (+15% cost); on-screen text now uses the small batches |
| `local.mjs` | Chrome on-device Translator | Free, ~2–4k chars/s, first screen ~0.8 s; tags kept 92% |
| `judge.mjs` | Blind A/B quality, judged by Opus 5.5 | Haiku won 61/64. Accuracy 4.91 vs 3.80, naturalness 4.80 vs 3.00 |
| `google.mjs` + `judge3.mjs` | Google Translate's free unofficial endpoint (`client=gtx`) vs Haiku vs Chrome local, blind three-way | Best of 64: Haiku 41, Google 5, local 0, tie 18. Naturalness 4.77 / 4.16 / 3.00, accuracy 4.89 / 4.59 / 3.75. Google ~0.27 s/request, tags kept 50/50, but **rate-limited (429 + CAPTCHA) after ~150 requests** |
| `eval-detect.mjs`, `eval-langdetector.mjs` | YouTube title language (1,291 labeled titles) | Spanish shown 88%, non-Spanish leaking through 0.5% |
| `e2e.mjs` | Real browsing with `dist/` loaded | Pages Spanish in ~1.4–4.8 s from navigation |
| `chat.mjs` | Informal chat (40 real messages), blind 4-way judge | Wrong-meaning lines: 2–3 without context → 0 with context (avg score unchanged within run-to-run noise; adding thinking costs 3× for no gain) |

## iPhone

`npm run build:safari` builds `dist-safari/`, and `ios/` holds the Xcode project generated by `safari-web-extension-packager`. Neither has been built or tested on a device yet.

In Safari the Claude engine works as-is. There is no on-device fallback yet: Apple's Translation framework would need a native bridge.
