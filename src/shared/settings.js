// Settings live in chrome.storage.local (the API key must not sync to other machines).

export const DEFAULTS = {
  enabled: true,
  lang: "es-ES",
  engine: "claude", // "claude" (Haiku 5.5, best) | "local" (Chrome on-device, free)
  apiKey: "",
  workspaceId: "",
  model: "claude-haiku-5-5",
  dailyBudget: 0.5, // USD/day; past it we switch to the free local engine until midnight
  credit: 20, // USD balance, only used to estimate how long it lasts
  disabledSites: [],
  nativeFirst: true, // ask sites for Spanish, follow hreflang / Wikipedia language links
  antiFlash: true, // hide the page briefly so you don't see English before it's translated
  youtube: { filter: "hide", noShorts: true, audio: true, captions: "auto" },
};

const api = globalThis.chrome ?? globalThis.browser;

export async function getSettings() {
  const { settings } = await api.storage.local.get("settings");
  return { ...DEFAULTS, ...settings, youtube: { ...DEFAULTS.youtube, ...settings?.youtube } };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch, youtube: { ...cur.youtube, ...patch.youtube } };
  await api.storage.local.set({ settings: next });
  return next;
}

export function onSettingsChanged(cb) {
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) getSettings().then(cb);
  });
}

export function siteKey(hostname) {
  return hostname.replace(/^www\./, "");
}

export function isSiteDisabled(s, hostname) {
  const h = siteKey(hostname);
  return s.disabledSites.some((d) => h === d || h.endsWith("." + d));
}
