import { createRequire } from "node:module";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { register } from "./register.js";

// Load the manifest at runtime (dist/../openclaw.plugin.json = package root) so
// the single source of truth for id/schema is the manifest, without pulling a
// file outside rootDir into the TypeScript build.
const require = createRequire(import.meta.url);
const manifest = require("../openclaw.plugin.json") as {
  id: string;
  name?: string;
  description?: string;
  configSchema?: unknown;
};

/**
 * Gateway entry point. OpenClaw loads the default export (a DefinedPluginEntry)
 * and calls its `register(api)` at plugin load.
 */
export default definePluginEntry({
  id: manifest.id,
  name: manifest.name,
  description: manifest.description,
  configSchema: manifest.configSchema,
  register,
});

export { register };
