// Spend tracking per local day, so the popup can show cost and how long the credit lasts.

const api = globalThis.chrome ?? globalThis.browser;
let days = null;
let saveTimer = null;

const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function load() {
  if (!days) days = (await api.storage.local.get("usage")).usage ?? {};
  return days;
}

function save() {
  saveTimer ??= setTimeout(async () => {
    saveTimer = null;
    const keep = Object.keys(days).sort().slice(-120);
    days = Object.fromEntries(keep.map((k) => [k, days[k]]));
    await api.storage.local.set({ usage: days });
  }, 1500);
}

/** Add to today's totals. Fields: cost, in, out, cacheRead, cacheWrite, requests, chars, cached, local. */
export async function record(delta) {
  await load();
  const k = dayKey();
  const d = (days[k] ??= { cost: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, requests: 0, chars: 0, cached: 0, local: 0 });
  for (const [f, v] of Object.entries(delta)) d[f] = (d[f] ?? 0) + v;
  save();
}

export async function spentToday() {
  await load();
  return days[dayKey()]?.cost ?? 0;
}

export async function summary(credit) {
  await load();
  const today = days[dayKey()] ?? {};
  const keys = Object.keys(days).sort();
  const month = keys.filter((k) => k.startsWith(dayKey().slice(0, 7)));
  const sum = (ks, f) => ks.reduce((s, k) => s + (days[k][f] ?? 0), 0);
  // Average over the days we actually have (max 7) for the runway estimate.
  const recent = keys.slice(-7);
  const perDay = recent.length ? sum(recent, "cost") / recent.length : 0;
  return {
    today,
    monthCost: sum(month, "cost"),
    totalCost: sum(keys, "cost"),
    perDay,
    runwayDays: perDay > 0 ? Math.max(0, (credit - sum(keys, "cost")) / perDay) : null,
    days: recent.map((k) => ({ day: k, cost: days[k].cost, chars: days[k].chars })),
  };
}
