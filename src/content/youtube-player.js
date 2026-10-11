// YouTube (page world): pick your language's audio track (original, else a dub) and turn
// on captions in your language (native track, else YouTube's auto-translate) when the
// audio isn't in it. Config comes from the isolated script via data-esx-yt-cfg.

const handled = new Set();
const attempts = new Map(); // videoId → tries (captions can take a while to become available)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cfg() {
  try {
    return JSON.parse(document.documentElement.getAttribute("data-esx-yt-cfg"));
  } catch {
    return null;
  }
}

function player() {
  return document.getElementById(location.pathname.startsWith("/shorts") ? "shorts-player" : "movie_player")
    ?? document.querySelector(".html5-video-player");
}

// Track ids look like "es-US.10": the suffix says original (4), creator dub (3), auto-dub (10).
function trackId(t) {
  try {
    const info = t.getLanguageInfo?.();
    if (info) return info.getId?.() ?? info.id ?? "";
  } catch {}
  for (const v of Object.values(t)) if (v && typeof v === "object" && typeof v.id === "string" && /\.\d+$/.test(v.id)) return v.id;
  return "";
}

function originalLang(pr) {
  const r = pr?.captions?.playerCaptionsTracklistRenderer;
  const fromCaptions = r?.audioTracks?.[r.defaultAudioTrackIndex ?? 0]?.audioTrackId;
  const fromFormats = pr?.streamingData?.adaptiveFormats?.find((f) => f.audioTrack?.id?.endsWith(".4"))?.audioTrack.id;
  const id = fromFormats ?? fromCaptions;
  if (id) return id.split(/[.-]/)[0];
  const asr = (r?.captionTracks ?? []).filter((t) => t.kind === "asr");
  return asr.length === 1 ? asr[0].languageCode.split("-")[0] : null;
}

function pickAudio(p, c) {
  const tracks = p.getAvailableAudioTracks?.() ?? [];
  if (tracks.length < 2) return null;
  const score = (t) => {
    const id = trackId(t).toLowerCase();
    if (!id.startsWith(c.base)) return -1;
    let s = 1;
    if (id.endsWith(".4")) s += 4; // original beats any dub
    else if (id.endsWith(".3")) s += 2; // creator dub beats auto-dub
    if (id.startsWith(c.code.toLowerCase())) s += 1; // es-ES voice for es-ES
    return s;
  };
  const best = tracks.map((t) => [t, score(t)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!best) return null;
  if (p.getAudioTrack?.()?.id !== best.id) p.setAudioTrack(best);
  return { lang: c.base, dubbed: !trackId(best).endsWith(".4") };
}

async function pickCaptions(p, orig, c) {
  if (!p.getOptions?.().includes("captions")) p.loadModule?.("captions");
  let list = [];
  for (let i = 0; i < 10 && !list.length; i++) {
    list = p.getOption?.("captions", "tracklist", { includeAsr: true }) ?? [];
    if (!list.length) await sleep(200);
  }
  if (!list.length) return null;
  const mine = list.find((t) => t.languageCode?.startsWith(c.base) && t.kind !== "asr") ?? list.find((t) => t.languageCode?.startsWith(c.base));
  if (mine) {
    p.setOption("captions", "track", mine);
    return { lang: c.base, auto: false };
  }
  // Translate from the spoken language if we know it, else from English (best MT quality).
  const src = list.find((t) => orig && t.languageCode?.startsWith(orig) && t.kind !== "asr")
    ?? list.find((t) => orig && t.languageCode?.startsWith(orig))
    ?? list.find((t) => t.languageCode?.startsWith("en") && t.kind !== "asr")
    ?? list.find((t) => t.kind !== "asr")
    ?? list[0];
  const tl = (p.getOption("captions", "translationLanguages") ?? []).find((l) => l.languageCode === c.base || l.languageCode?.startsWith(c.base + "-"));
  if (src && tl) {
    p.setOption("captions", "track", { ...src, translationLanguage: tl });
    return { lang: c.base, auto: true };
  }
  return null;
}

// Captions only load once the video itself (not a pre-roll ad) is playing, so we also
// react to the player's own state changes.
let hooked = null;
function hook(p) {
  if (hooked === p) return;
  hooked = p;
  try {
    p.addEventListener("onStateChange", (state) => state === 1 && setTimeout(onVideo, 300));
  } catch {}
}

let busy = false;
async function onVideo() {
  if (busy) return;
  const c = cfg();
  const p = player();
  if (!c || !p?.getPlayerResponse) return;
  hook(p);
  if (p.classList?.contains("ad-showing")) return; // try again when the video starts
  const pr = p.getPlayerResponse();
  const vid = pr?.videoDetails?.videoId;
  if (!vid || handled.has(vid)) return;
  busy = true;
  try {
    const orig = originalLang(pr);
    const tries = (attempts.get(vid) ?? 0) + 1;
    attempts.set(vid, tries);
    // Several audio tracks? (dubs) They can show up a moment after the video loads.
    const audioIds = new Set((pr?.streamingData?.adaptiveFormats ?? []).map((f) => f.audioTrack?.id).filter(Boolean));
    let audio = c.audio ? pickAudio(p, c) : null;
    for (let i = 0; c.audio && !audio && audioIds.size > 1 && i < 8 && (p.getAvailableAudioTracks?.() ?? []).length < 2; i++) {
      await sleep(400);
      audio = pickAudio(p, c);
    }
    const audioLang = audio?.lang ?? orig;
    let captions = null;
    // Unknown audio language counts as "not yours" (most videos without metadata aren't).
    const wantCaptions = c.captions === "always" || (c.captions === "auto" && audioLang !== c.base);
    if (wantCaptions) captions = await pickCaptions(p, orig, c);
    if (wantCaptions && !captions && tries < 8) {
      // Caption list not ready (video not started yet): the next "playing" event retries.
      if (p.getPlayerState?.() === 1) setTimeout(onVideo, 2000);
      return;
    }
    handled.add(vid);
    // Object payloads don't survive the trip to the isolated world; send JSON.
    dispatchEvent(new CustomEvent("esx-yt-info", {
      detail: JSON.stringify({ orig, audio: audioLang, dubbed: audio?.dubbed ?? false, captions: captions?.lang ?? null, autoTranslated: captions?.auto ?? false }),
    }));
  } finally {
    busy = false;
  }
}

const soon = () => setTimeout(onVideo, 300);
for (const ev of ["yt-navigate-finish", "yt-player-updated", "state-navigateend", "yt-page-data-updated"]) document.addEventListener(ev, soon);
document.addEventListener("loadedmetadata", soon, true);
