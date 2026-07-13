// Ambient declaration for the OpenClaw plugin entry helper. This file has no
// top-level import/export, so it is a global script and the ambient module
// declaration is picked up without needing the `openclaw` package installed.
// The real implementation is supplied by the gateway at runtime.
declare module "openclaw/plugin-sdk/plugin-entry" {
  export function definePluginEntry(options: {
    id: string;
    name?: string;
    description?: string;
    configSchema?: unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    register: (api: any) => void;
  }): unknown;
}
