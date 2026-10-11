// Text that must never leave the browser for translation: API keys, tokens, hashes, long
// IDs, bare URLs. None of it needs translating anyway.

const SECRET = /(sk-[a-z]{2,}-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|wrkspc_[A-Za-z0-9]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY)/;
// One "word" of 20+ chars mixing letters and digits: keys, hashes, session IDs.
const LONG_TOKEN = /\b(?=[A-Za-z0-9_+/=-]*\d)(?=[A-Za-z0-9_+/=-]*[A-Za-z])[A-Za-z0-9_+/=-]{20,}\b/g;
const URL_ONLY = /^(https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w-]+\.[\w.]+)$/i;

/** True if the text shouldn't be sent for translation at all. */
export function untranslatable(text) {
  const t = text.trim();
  if (SECRET.test(t)) return true;
  if (/\s/.test(t)) return false;
  return URL_ONLY.test(t) || (t.length >= 20 && new RegExp(LONG_TOKEN.source).test(t));
}

/** Context text with secrets and long tokens blanked out. */
export function redact(text) {
  return text.replace(new RegExp(SECRET.source, "g"), "…").replace(LONG_TOKEN, "…");
}
