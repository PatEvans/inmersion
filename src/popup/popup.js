import { LANGS } from "../shared/langs.js";
import { getSettings, saveSettings, siteKey } from "../shared/settings.js";
import { money, num } from "../ui/format.js";

const api = globalThis.chrome ?? globalThis.browser;
const $ = (id) => document.getElementById(id);
const openSettings = () => api.runtime.openOptionsPage();

let S;
let host = "";

async function init() {
  S = await getSettings();
  for (const [code, info] of Object.entries(LANGS)) $("lang").add(new Option(info.label, code));
  const [tab] = await api.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  try {
    const u = new URL(tab?.url ?? "");
    if (/^https?:$/.test(u.protocol)) host = siteKey(u.hostname);
  } catch {}
  $("host").textContent = host;
  $("siteRow").hidden = !host;

  $("enabled").onchange = (e) => save({ enabled: e.target.checked });
  $("lang").onchange = (e) => save({ lang: e.target.value });
  $("site").onchange = (e) => {
    const rest = S.disabledSites.filter((d) => d !== host);
    save({ disabledSites: e.target.checked ? rest : [...rest, host] });
  };
  $("settings").onclick = openSettings;
  render();
}

async function save(patch) {
  S = await saveSettings(patch);
  render();
}

async function render() {
  $("enabled").checked = S.enabled;
  $("main").classList.toggle("off", !S.enabled);
  $("lang").value = S.lang;
  $("site").checked = !S.disabledSites.includes(host);

  // One line of status: what needs attention, else what today cost.
  const status = $("status");
  status.classList.remove("warn");
  status.onclick = openSettings;
  if (!S.enabled) return (status.textContent = "Desactivado");
  if (S.engine === "claude" && !S.apiKey) {
    status.textContent = "Añade tu clave de Claude →";
    return status.classList.add("warn");
  }
  if (S.engine === "claude" && S.keyError) {
    status.textContent = "Revisa tu clave de Claude →";
    return status.classList.add("warn");
  }
  const st = await api.runtime.sendMessage({ t: "status" }).catch(() => null);
  const cost = st?.usage?.today?.cost ?? 0;
  if (S.engine === "claude" && cost >= S.dailyBudget) status.textContent = "Límite de hoy alcanzado · modo gratis";
  else if (S.engine === "local") status.textContent = "Traductor gratuito";
  else if (!cost) status.textContent = "Hoy sin gasto";
  else {
    const days = st.usage.runwayDays;
    status.textContent = `Hoy ${money(cost)}` + (days ? ` · saldo para ~${num(Math.min(days, 999))} días` : "");
  }
}

init();
