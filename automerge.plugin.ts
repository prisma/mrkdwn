/**
 * Bundler plugin for browser builds.
 *
 * `@automerge/automerge`'s "browser" export condition points at a wasm-bindgen
 * "bundler" entrypoint that does a bare `import ... from "./automerge.wasm"`,
 * which Bun's bundler can't satisfy with real ESM-wasm semantics. The package
 * also ships a base64 entrypoint that embeds the wasm and initializes it
 * synchronously at import time — that one works with any bundler.
 *
 * This plugin rewrites bare `@automerge/automerge` imports to the base64
 * entrypoint. It is only registered for the frontend bundle (bunfig
 * [serve.static] + build script); the server keeps the native node entry.
 */
import type { BunPlugin } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";

const base64Entry = join(
  import.meta.dir,
  "node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_base64.js"
);

if (!existsSync(base64Entry)) {
  throw new Error(
    `automerge base64 entrypoint not found at ${base64Entry} — the package layout changed; update automerge.plugin.ts`
  );
}

const wsNativeShim = join(import.meta.dir, "src/web/ws-native.ts");

const plugin: BunPlugin = {
  name: "automerge-wasm-base64-alias",
  setup(build) {
    build.onResolve({ filter: /^@automerge\/automerge$/ }, () => ({
      path: base64Entry,
    }));
    // isomorphic-ws resolves to the node `ws` package here, whose browser
    // stub throws at runtime — the browser wants the native WebSocket.
    build.onResolve({ filter: /^isomorphic-ws$/ }, () => ({
      path: wsNativeShim,
    }));
  },
};

export default plugin;
