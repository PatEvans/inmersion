// Target languages. `code` is what the user picks; `base` is what language detectors
// return; `chrome` is the code Chrome's on-device Translator expects; `yt` sets YouTube's
// interface language/region; `accept` is sent as Accept-Language.

export const LANGS = {
  "es-ES": {
    base: "es", chrome: "es", label: "Español (España)", name: "Spanish (Spain)",
    yt: { hl: "es", gl: "ES" }, accept: "es-ES,es;q=0.9",
    variant: "Use Castilian Spanish as written in Spain: tú for one person, vosotros for several, and Spain vocabulary and usage (ordenador, móvil, coche, vale, vídeo, zumo, conducir, \"me he enterado\" rather than \"me enteré\" for recent events).",
    examples: [
      "Iniciar sesión",
      "Publicado por <1>u/throwaway_42</1> hace 5 horas",
      "<1>Más información</1> sobre cómo usamos las cookies.",
      "1,2 mil comentarios",
      "Ajustes",
      "No me puedo creer que esto haya funcionado de verdad, jaja",
      "Usa el comando <1/> para instalarlo.",
      "El primer ministro dijo que el plan <1>\"arreglaría la economía\"</1>, pero los críticos no estaban de acuerdo.<2/>",
    ],
  },
  "es-419": {
    base: "es", chrome: "es", label: "Español (Latinoamérica)", name: "Latin American Spanish",
    yt: { hl: "es-419", gl: "MX" }, accept: "es-419,es;q=0.9",
    variant: "Use neutral Latin American Spanish: tú for one person, ustedes for several (never vosotros), and Latin American vocabulary (computadora, celular, carro/auto, video, jugo, manejar).",
    examples: [
      "Iniciar sesión",
      "Publicado por <1>u/throwaway_42</1> hace 5 horas",
      "<1>Más información</1> sobre cómo usamos las cookies.",
      "1.2 mil comentarios",
      "Configuración",
      "No puedo creer que esto realmente funcionó jaja",
      "Usa el comando <1/> para instalarlo.",
      "El primer ministro dijo que el plan <1>\"arreglaría la economía\"</1>, pero los críticos no estuvieron de acuerdo.<2/>",
    ],
  },
  "fr-FR": {
    base: "fr", chrome: "fr", label: "Français", name: "French (France)",
    yt: { hl: "fr", gl: "FR" }, accept: "fr-FR,fr;q=0.9",
    variant: "Use the French of France; tutoie in casual contexts (social media, comments) and vouvoie in UI and formal text, as French sites do.",
    examples: [
      "Se connecter",
      "Publié par <1>u/throwaway_42</1> il y a 5 heures",
      "<1>En savoir plus</1> sur notre utilisation des cookies.",
      "1,2 k commentaires",
      "Paramètres",
      "J'arrive pas à croire que ça a vraiment marché mdr",
      "Utilisez la commande <1/> pour l'installer.",
      "Le Premier ministre a déclaré que le plan allait <1>« redresser l'économie »</1>, mais ses détracteurs n'étaient pas d'accord.<2/>",
    ],
  },
  "de-DE": {
    base: "de", chrome: "de", label: "Deutsch", name: "German",
    yt: { hl: "de", gl: "DE" }, accept: "de-DE,de;q=0.9",
    variant: "Use standard German; du in casual contexts and the du/Sie choice German sites typically make for UI (Sie for banks/government, du for social apps).",
    examples: [
      "Anmelden",
      "Gepostet von <1>u/throwaway_42</1> vor 5 Stunden",
      "<1>Mehr erfahren</1> darüber, wie wir Cookies verwenden.",
      "1,2 Tsd. Kommentare",
      "Einstellungen",
      "Ich fass es nicht, dass das wirklich geklappt hat lol",
      "Verwende den Befehl <1/>, um es zu installieren.",
      "Der Premierminister sagte, der Plan werde <1>„die Wirtschaft in Ordnung bringen“</1>, doch Kritiker widersprachen.<2/>",
    ],
  },
  "it-IT": {
    base: "it", chrome: "it", label: "Italiano", name: "Italian",
    yt: { hl: "it", gl: "IT" }, accept: "it-IT,it;q=0.9",
    variant: "Use standard Italian as written on Italian websites.",
    examples: [
      "Accedi",
      "Pubblicato da <1>u/throwaway_42</1> 5 ore fa",
      "<1>Scopri di più</1> su come utilizziamo i cookie.",
      "1,2K commenti",
      "Impostazioni",
      "Non ci credo che abbia funzionato davvero lol",
      "Usa il comando <1/> per installarlo.",
      "Il Primo Ministro ha detto che il piano <1>\"sistemerà l'economia\"</1>, ma i critici non erano d'accordo.<2/>",
    ],
  },
  "pt-BR": {
    base: "pt", chrome: "pt", label: "Português (Brasil)", name: "Brazilian Portuguese",
    yt: { hl: "pt", gl: "BR" }, accept: "pt-BR,pt;q=0.9",
    variant: "Use Brazilian Portuguese (você, celular, tela, ônibus).",
    examples: [
      "Entrar",
      "Postado por <1>u/throwaway_42</1> há 5 horas",
      "<1>Saiba mais</1> sobre como usamos cookies.",
      "1,2 mil comentários",
      "Configurações",
      "Não acredito que isso funcionou mesmo kkkk",
      "Use o comando <1/> para instalar.",
      "O primeiro-ministro disse que o plano iria <1>\"consertar a economia\"</1>, mas os críticos discordaram.<2/>",
    ],
  },
  "pt-PT": {
    base: "pt", chrome: "pt", label: "Português (Portugal)", name: "European Portuguese",
    yt: { hl: "pt-PT", gl: "PT" }, accept: "pt-PT,pt;q=0.9",
    variant: "Use European Portuguese as written in Portugal (telemóvel, ecrã, autocarro, utilizador; tu in casual contexts).",
    examples: [
      "Iniciar sessão",
      "Publicado por <1>u/throwaway_42</1> há 5 horas",
      "<1>Saiba mais</1> sobre como utilizamos os cookies.",
      "1,2 mil comentários",
      "Definições",
      "Nem acredito que isto resultou mesmo lol",
      "Utilize o comando <1/> para o instalar.",
      "O primeiro-ministro afirmou que o plano iria <1>\"resolver a economia\"</1>, mas os críticos discordaram.<2/>",
    ],
  },
  "ja-JP": { base: "ja", chrome: "ja", label: "日本語", name: "Japanese", yt: { hl: "ja", gl: "JP" }, accept: "ja-JP,ja;q=0.9", variant: "Use natural Japanese as Japanese websites write it (polite です/ます for UI and articles, casual for comments)." },
  "ko-KR": { base: "ko", chrome: "ko", label: "한국어", name: "Korean", yt: { hl: "ko", gl: "KR" }, accept: "ko-KR,ko;q=0.9", variant: "Use natural Korean as Korean websites write it." },
  "zh-CN": { base: "zh", chrome: "zh", label: "中文（简体）", name: "Simplified Chinese", yt: { hl: "zh-CN", gl: "CN" }, accept: "zh-CN,zh;q=0.9", variant: "Use Simplified Chinese as written in mainland China." },
  "nl-NL": { base: "nl", chrome: "nl", label: "Nederlands", name: "Dutch", yt: { hl: "nl", gl: "NL" }, accept: "nl-NL,nl;q=0.9", variant: "Use standard Dutch as written in the Netherlands." },
  "en-GB": { base: "en", chrome: "en", label: "English (UK)", name: "British English", yt: { hl: "en-GB", gl: "GB" }, accept: "en-GB,en;q=0.9", variant: "Use British English spelling and vocabulary." },
};

export const DEFAULT_LANG = "es-ES";

export function langInfo(code) {
  const c = LANGS[code] ? code : DEFAULT_LANG;
  return { code: c, ...LANGS[c] };
}
