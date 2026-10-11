// Instant language guess for short strings (video titles, UI labels), where statistical
// detectors are unreliable (Chrome's CLD flags anything under 50 bytes as unreliable).
// Combines function words / special letters with character-trigram profiles trained on
// web text (bench/train-ngram.mjs).

import NGRAMS from "./ngram-data.json" with { type: "json" };

const W = {
  es: "el la los las un una unos unas de del y o que en por con para sin sobre entre hasta desde como cómo qué cuál cuándo dónde quién porque pero más muy ya también no sí se su sus mi mis tu tus te le lo les nos os es son está están estoy fue era ser estar hay tiene tengo hace hacer hice hizo puede este esta esto estos estas ese esa eso aquí ahora hoy así todo todos toda nada algo cada otro otra nuevo nueva nuevos mejor peor vida mundo casa año años día días vez veces cosas gente hombre mujer niño niños cuando mientras donde aunque solo sólo mucho mucha muchos poco después antes siempre nunca bien mal gracias hola vamos voy vas va hemos han he has eres somos sois vosotros ustedes ellos ellas él ella yo nosotros parte primera primer historia receta fácil casero casera rápido cocina comida fútbol música canción noticias última últimas cómo por qué".split(" "),
  en: "the a an and or of to in on at for with without from by about into over after before is are was were be been being am i you he she it we they me my your his her its our their this that these those what which who whom whose why how when where there here not no yes do does did don't doesn't didn't can can't could will won't would should must have has had i'm it's you're we're they're i've i'll let's get got make made best new vs ever never always just only really very more most all every some any first last one two three day days year years time life world people man woman kid kids home house way thing things video full official music song news today live episode part how-to recipe easy quick homemade".split(" "),
  pt: "o os as um uma uns umas de do da dos das e ou que em no na nos nas por pelo pela com para sem sobre como quando onde porque mas mais muito já também não sim se seu sua seus suas meu minha você vocês eu ele ela eles elas nós é são está estão foi era ser estar tem tenho faz fazer fiz pode este esta isto esse essa isso aqui agora hoje assim tudo todos nada algo cada outro outra novo nova melhor vida mundo casa ano anos dia dias vez coisas gente obrigado então receita fácil caseiro música notícias".split(" "),
  fr: "le la les un une des de du et ou que qui dans en sur pour par avec sans sous comme quand où pourquoi mais plus très aussi ne pas oui se son sa ses mon ma mes ton ta tes notre votre leur il elle ils elles nous vous je tu on est sont était être avoir fait faire peut ce cette ces ici maintenant aujourd'hui tout tous rien chaque autre nouveau nouvelle meilleur vie monde maison an ans jour jours fois c'est j'ai recette facile musique".split(" "),
  it: "il lo la i gli le un una uno di del della dei delle e o che in nel nella per con senza su come quando dove perché ma più molto anche non sì si suo sua miei mio mia tuo tua è sono era essere avere fa fare può questo questa quello qui ora oggi così tutto tutti niente ogni altro altra nuovo nuova migliore vita mondo casa anno anni giorno giorni volta ricetta facile musica".split(" "),
  de: "der die das den dem des ein eine einen einem einer und oder dass in im auf für mit ohne von zu zum zur bei nach über unter wie wann wo warum aber mehr sehr auch nicht kein keine ja sich sein seine ihr ihre mein meine dein deine unser ist sind war waren sein haben hat hatte macht machen kann können dieser diese dieses hier jetzt heute so alles alle nichts jeder andere neu neue besser leben welt haus jahr jahre tag tage mal rezept einfach musik".split(" "),
};
const CHARS = [
  [/[ñ¿¡]/g, { es: 3 }],
  [/[ãõ]/g, { pt: 3 }],
  [/ç/g, { pt: 1, fr: 1 }],
  [/[äöß]/g, { de: 3 }],
  [/ü/g, { de: 2, es: 0.5 }],
  [/[àèù]/g, { fr: 1, it: 1.5 }],
  [/[êâîôûëïœ]/g, { fr: 2, pt: 0.5 }],
  [/[áíóú]/g, { es: 1, pt: 0.8 }],
  [/é/g, { es: 0.5, fr: 0.8, pt: 0.5, it: 0.3 }],
];
const SETS = Object.fromEntries(Object.entries(W).map(([k, v]) => [k, new Set(v)]));

function trigrams(text) {
  const words = text.toLowerCase().replace(/[^\p{L}' ]+/gu, " ").split(/\s+/).filter(Boolean);
  const grams = [];
  for (const w of words) {
    const s = ` ${w} `;
    for (let i = 0; i + 3 <= s.length; i++) grams.push(s.slice(i, i + 3));
  }
  return grams;
}

/** Trigram log-likelihood per language (higher = more likely) and the trigram count. */
export function ngramScores(text) {
  const grams = trigrams(text);
  const scores = {};
  for (const [lang, prof] of Object.entries(NGRAMS)) {
    let s = 0;
    for (const g of grams) s += prof.g[g] ?? prof.floor;
    scores[lang] = s;
  }
  return { scores, n: grams.length };
}

/**
 * Returns { lang, confident }. Trigram evidence (a log-likelihood ratio) plus a word-list
 * score; `confident` means the winner is ahead by a clear margin.
 */
export function guessLang(text) {
  const script = scriptOf(text.toLowerCase());
  if (script) return { lang: script, confident: true };
  const lex = lexicon(text);
  const { scores, n } = ngramScores(text);
  if (n < 4) return lex;
  for (const k in scores) scores[k] += 2.5 * (lex.scores[k] ?? 0);
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [[lang, top], [, second]] = ranked;
  return { lang, confident: top - second >= MARGIN, margin: top - second };
}

export let MARGIN = 6; // tuned on 1,291 labelled YouTube titles (bench/eval-detect.mjs)
export const setMargin = (m) => (MARGIN = m);

/** Word-list only (the original heuristic). */
export function lexicon(text) {
  const t = text.toLowerCase();
  const script = scriptOf(t);
  if (script) return { lang: script, confident: true, scores: {} };
  const scores = { es: 0, en: 0, pt: 0, fr: 0, it: 0, de: 0 };
  const words = t.match(/[\p{L}']+/gu) ?? [];
  for (const w of words) {
    const hits = Object.keys(SETS).filter((k) => SETS[k].has(w));
    for (const k of hits) scores[k] += 1 / hits.length;
  }
  for (const [re, bonus] of CHARS) {
    const n = (t.match(re) ?? []).length;
    if (n) for (const k in bonus) scores[k] += bonus[k] * Math.min(n, 3);
  }
  // Words shared by several languages count less.
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [[lang, top], [, second]] = ranked;
  if (top === 0) return { lang: null, confident: false, scores };
  const confident = top >= 1.5 && top >= second * 1.8 + 0.5;
  return { lang, confident, scores };
}

function scriptOf(t) {
  const letters = t.match(/\p{L}/gu);
  if (!letters || letters.length < 2) return null;
  const count = (re) => (t.match(re) ?? []).length / letters.length;
  if (count(/[぀-ヿ]/g) > 0.2) return "ja";
  if (count(/[가-힯]/g) > 0.3) return "ko";
  if (count(/[一-鿿]/g) > 0.3) return "zh";
  if (count(/[Ѐ-ӿ]/g) > 0.3) return "ru";
  if (count(/[؀-ۿ]/g) > 0.3) return "ar";
  if (count(/[ऀ-ॿ]/g) > 0.3) return "hi";
  if (count(/[฀-๿]/g) > 0.3) return "th";
  if (count(/[Ͱ-Ͽ]/g) > 0.3) return "el";
  if (count(/[֐-׿]/g) > 0.3) return "he";
  return null;
}
