// Free fallback engine: Google Translate's web endpoint (no key). It's unofficial and
// rate-limits hard (429 + CAPTCHA after ~150 quick requests in our tests, lasting 40+
// minutes), so we batch lines, keep one request in flight with gaps between them, and on
// any block simply stop using it for a while; no retries, no CAPTCHA games.

const ENDPOINT = "https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto";
const MAX_CHARS = 1800;
const GAP_MS = 350;
const FIRST_BACKOFF = 15 * 60_000;

let blockedUntil = 0;
let backoff = FIRST_BACKOFF;
let lastAt = 0;
let queue = Promise.resolve();

export const googleAvailable = () => Date.now() >= blockedUntil;
export const googleBlockedUntil = () => blockedUntil;

// Google's codes: Brazilian is plain "pt"; European Portuguese and Chinese keep a region.
const googleLang = (code) => ({ "pt-PT": "pt-PT", "zh-CN": "zh-CN" })[code] ?? code.split("-")[0];

function request(text, target) {
  const run = queue.then(async () => {
    if (!googleAvailable()) throw new Error("google-blocked");
    const wait = lastAt + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    const res = await fetch(`${ENDPOINT}&tl=${googleLang(target)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: "q=" + encodeURIComponent(text),
    });
    let data = null;
    try {
      data = JSON.parse(await res.text());
    } catch {}
    if (res.status === 429 || (res.ok && !Array.isArray(data))) {
      blockedUntil = Date.now() + backoff;
      backoff = Math.min(backoff * 2, 6 * 3600_000);
      throw new Error("google-blocked");
    }
    if (!res.ok || !Array.isArray(data)) throw new Error(`google-${res.status}`);
    backoff = FIRST_BACKOFF;
    return (data[0] ?? []).map((seg) => seg?.[0] ?? "").join("");
  });
  queue = run.catch(() => {});
  return run;
}

/**
 * Translate unit sources (no newlines inside: line breaks are <br>). Lines are sent in
 * newline-joined batches; if Google merges lines in a batch, that batch goes line by line.
 * Calls onResult(index, text); throws once Google is blocked (the caller falls back).
 */
export async function googleTranslate(sources, target, onResult) {
  const batches = [];
  let cur = [];
  let chars = 0;
  sources.forEach((s, i) => {
    if (cur.length && chars + s.length > MAX_CHARS) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(i);
    chars += s.length + 1;
  });
  if (cur.length) batches.push(cur);
  for (const batch of batches) {
    const out = (await request(batch.map((i) => sources[i]).join("\n"), target)).split("\n");
    if (out.length === batch.length) batch.forEach((i, k) => onResult(i, out[k].trim()));
    else for (const i of batch) onResult(i, (await request(sources[i], target)).trim());
  }
}
