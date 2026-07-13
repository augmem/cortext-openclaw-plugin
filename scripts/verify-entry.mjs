// Verifies the gateway entry (dist/index.js) wires definePluginEntry correctly.
// The real `openclaw` package isn't a runtime dependency, so we stub the entry
// helper under node_modules and confirm our default export flows through it.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgDir = join(root, "node_modules", "openclaw", "plugin-sdk");
mkdirSync(pkgDir, { recursive: true });
writeFileSync(
  join(root, "node_modules", "openclaw", "package.json"),
  JSON.stringify({ name: "openclaw", version: "0.0.0-stub", exports: { "./plugin-sdk/plugin-entry": "./plugin-sdk/plugin-entry.js" } }),
);
writeFileSync(
  join(pkgDir, "plugin-entry.js"),
  "export function definePluginEntry(o){ return { __definedPluginEntry: true, ...o }; }\n",
);

if (!existsSync(join(root, "dist", "index.js"))) {
  console.error("dist/index.js missing — run `npm run build` first");
  process.exit(1);
}

const mod = await import(join(root, "dist", "index.js"));
const entry = mod.default;
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

if (!entry || entry.__definedPluginEntry !== true) fail("default export is not a definePluginEntry result");
if (entry.id !== "cortext") fail(`entry id is ${entry.id}, expected "cortext"`);
if (typeof entry.register !== "function") fail("entry.register is not a function");
if (typeof mod.register !== "function") fail("named register export missing");
if (!entry.configSchema || typeof entry.configSchema !== "object") fail("configSchema not passed through");

console.log("gateway entry OK: id=cortext, register wired, configSchema present");
