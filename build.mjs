// Builds the extension. `node build.mjs` → dist/ (Chrome). `node build.mjs safari` → dist-safari/.
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { LANGS } from "./src/shared/langs.js";

const target = process.argv[2] === "safari" ? "safari" : "chrome";
const out = target === "safari" ? "dist-safari" : "dist";
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "navlang"), { recursive: true });

const common = { bundle: true, outdir: out, target: ["chrome120", "safari17"], legalComments: "none", logLevel: "warning" };
await esbuild.build({
  ...common,
  entryPoints: { background: "src/background/index.js" },
  // Chrome runs the worker as a module; Safari (iOS) is more reliable with a classic script.
  format: target === "safari" ? "iife" : "esm",
});
await esbuild.build({
  ...common,
  entryPoints: {
    content: "src/content/main.js",
    youtube: "src/content/youtube.js",
    "youtube-player": "src/content/youtube-player.js",
    popup: "src/popup/popup.js",
    options: "src/options/options.js",
  },
  format: "iife",
});

fs.copyFileSync("src/popup/popup.html", path.join(out, "popup.html"));
fs.copyFileSync("src/options/options.html", path.join(out, "options.html"));
fs.copyFileSync("src/ui/ui.css", path.join(out, "ui.css"));
fs.cpSync("src/icons", path.join(out, "icons"), { recursive: true });

// navigator.language / languages in the page's own world, so JS-localised sites pick
// your language. Registered dynamically by the background for the chosen language.
for (const [code, info] of Object.entries(LANGS)) {
  const langs = [code, info.base].filter((x, i, a) => a.indexOf(x) === i);
  fs.writeFileSync(
    path.join(out, "navlang", `${code}.js`),
    `(()=>{const l=Object.freeze(${JSON.stringify(langs)});try{Object.defineProperty(Navigator.prototype,"language",{get:()=>l[0],configurable:true});Object.defineProperty(Navigator.prototype,"languages",{get:()=>l,configurable:true})}catch{}})();\n`,
  );
}

const icons = { 16: "icons/16.png", 32: "icons/32.png", 48: "icons/48.png", 128: "icons/128.png" };
const manifest = {
  manifest_version: 3,
  name: "Inmersión — la web en tu idioma",
  short_name: "Inmersión",
  version: "0.1.0",
  description: "Toda la web en español (o el idioma que elijas): traducción con Claude Haiku 5.5 o el traductor local de Chrome, y YouTube solo en tu idioma.",
  icons,
  action: { default_popup: "popup.html", default_icon: icons },
  options_ui: { page: "options.html", open_in_tab: true },
  background: target === "safari" ? { scripts: ["background.js"], persistent: false } : { service_worker: "background.js", type: "module" },
  permissions: ["storage", "declarativeNetRequest", "scripting", ...(target === "safari" ? ["unlimitedStorage"] : [])],
  host_permissions: ["<all_urls>"],
  content_scripts: [
    { matches: ["<all_urls>"], js: ["content.js"], run_at: "document_start", all_frames: true, match_about_blank: true },
    { matches: ["*://*.youtube.com/*"], js: ["youtube.js"], run_at: "document_start" },
    { matches: ["*://*.youtube.com/*"], js: ["youtube-player.js"], run_at: "document_start", world: "MAIN" },
  ],
  web_accessible_resources: [],
  commands: {
    "toggle-site": { suggested_key: { default: "Alt+Shift+E" }, description: "Activar o desactivar en este sitio" },
  },
};
if (target === "chrome") manifest.minimum_chrome_version = "138";
delete manifest.web_accessible_resources;
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`built ${out}/ for ${target}`);
