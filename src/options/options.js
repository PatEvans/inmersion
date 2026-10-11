import { getSettings, saveSettings } from "../shared/settings.js";
import { money, num } from "../ui/format.js";

const api = globalThis.chrome ?? globalThis.browser;
const $ = (id) => document.getElementById(id);
let S;

async function init() {
  S = await getSettings();
  if (new URLSearchParams(location.search).has("welcome")) {
    $("welcome").hidden = false;
    $("apiKey").focus();
  }
  $("engine").value = S.engine;
  $("apiKey").value = S.apiKey;
  $("workspaceId").value = S.workspaceId;
  $("dailyBudget").value = S.dailyBudget;
  $("credit").value = S.credit;
  $("ytFilter").value = S.youtube.filter;
  $("ytAudio").checked = S.youtube.audio;
  $("ytNoShorts").checked = S.youtube.noShorts;
  $("ytCaptions").value = S.youtube.captions;
  $("nativeFirst").checked = S.nativeFirst;
  $("antiFlash").checked = S.antiFlash;
  $("keyBlock").hidden = S.engine !== "claude";
  if (S.keyError) setKeyStatus(`Error de la API: ${S.keyError}`, "warn");

  const save = (patch) => saveSettings(patch).then((s) => (S = s));
  $("engine").onchange = (e) => {
    $("keyBlock").hidden = e.target.value !== "claude";
    save({ engine: e.target.value });
  };
  $("apiKey").onchange = (e) => save({ apiKey: e.target.value.trim(), keyError: "" });
  $("workspaceId").onchange = (e) => save({ workspaceId: e.target.value.trim(), keyError: "" });
  $("dailyBudget").onchange = (e) => save({ dailyBudget: Math.max(0, Number(e.target.value) || 0) });
  $("credit").onchange = (e) => save({ credit: Math.max(0, Number(e.target.value) || 0) }).then(refresh);
  $("ytFilter").onchange = (e) => save({ youtube: { filter: e.target.value } });
  $("ytAudio").onchange = (e) => save({ youtube: { audio: e.target.checked } });
  $("ytNoShorts").onchange = (e) => save({ youtube: { noShorts: e.target.checked } });
  $("ytCaptions").onchange = (e) => save({ youtube: { captions: e.target.value } });
  $("nativeFirst").onchange = (e) => save({ nativeFirst: e.target.checked });
  $("antiFlash").onchange = (e) => save({ antiFlash: e.target.checked });
  $("testKey").onclick = async () => {
    await save({ apiKey: $("apiKey").value.trim(), workspaceId: $("workspaceId").value.trim() });
    setKeyStatus("Probando…");
    const r = await api.runtime.sendMessage({ t: "testKey" });
    setKeyStatus(r?.ok ? "✓ Funciona" : `✗ ${r?.error ?? "Error"}`, r?.ok ? "good" : "warn");
  };
  $("clearCache").onclick = async () => {
    await api.runtime.sendMessage({ t: "clearCache" });
    refresh();
  };
  refresh();
}

function setKeyStatus(text, cls = "muted") {
  $("keyStatus").textContent = text;
  $("keyStatus").className = `small ${cls}`;
}

async function refresh() {
  const st = await api.runtime.sendMessage({ t: "status" }).catch(() => null);
  if (!st) return;
  const u = st.usage;
  $("today").textContent = money(u.today.cost ?? 0);
  $("month").textContent = money(u.monthCost);
  $("runway").textContent = u.runwayDays === null ? "—" : u.runwayDays > 999 ? "999+" : num(u.runwayDays);
  $("cacheCount").textContent = `· ${num(st.cache.entries)} traducciones`;
}

init();
