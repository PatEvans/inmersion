// Free engine: Chrome's on-device Translator API, run in the extension service worker
// (no user gesture needed there, and one model instance serves every tab).
// It is a single queue (~2-4k chars/s measured), so we translate in arrival order.

import { tagIds } from "../shared/markup.js";

const translators = new Map(); // "en>es" → Promise<Translator>

export function localAvailable() {
  return typeof globalThis.Translator !== "undefined";
}

export async function localStatus(source, target) {
  if (!localAvailable()) return "unavailable";
  try {
    return await Translator.availability({ sourceLanguage: source, targetLanguage: target });
  } catch {
    return "unavailable";
  }
}

function getTranslator(source, target, onProgress) {
  const key = `${source}>${target}`;
  if (!translators.has(key)) {
    const p = Translator.create({
      sourceLanguage: source,
      targetLanguage: target,
      monitor: (m) => onProgress && m.addEventListener("downloadprogress", (e) => onProgress(e.loaded)),
    });
    p.catch(() => translators.delete(key));
    translators.set(key, p);
  }
  return translators.get(key);
}

export async function prepareLocal(source, target, onProgress) {
  await getTranslator(source, target, onProgress);
}

const sameTags = (a, b) => {
  const x = tagIds(a), y = tagIds(b);
  return x.size === y.size && [...x].every((id) => y.has(id));
};

/**
 * Translate one unit source. Sends the whole unit (more context, keeps tags ~92% of the
 * time); if tags come back broken, translates the text between tags piece by piece.
 */
export async function localTranslate(source, from, to) {
  const t = await getTranslator(from, to);
  const whole = await t.translate(source);
  if (sameTags(source, whole) && !(source.includes("<br>") && !whole.includes("<br>"))) return whole;
  const parts = source.split(/(<\/?\d{1,3}\/?>|<br>)/);
  for (let i = 0; i < parts.length; i += 2) {
    if (/\p{L}/u.test(parts[i])) {
      const lead = parts[i].match(/^\s*/)[0];
      const trail = parts[i].match(/\s*$/)[0];
      parts[i] = lead + (await t.translate(parts[i].trim())) + trail;
    }
  }
  return parts.join("");
}
