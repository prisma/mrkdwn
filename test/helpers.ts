import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo, type AutomergeUrl } from "@automerge/automerge-repo";
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import { loadConfig } from "../src/server/config";
import { startServer, type RunningServer } from "../src/server/server";
import { whenPeered } from "../src/shared/connect";
import type { MrkdwnDoc } from "../src/shared/types";

export interface TestWorld {
  running: RunningServer;
  base: string;
  token: string;
  docUrl: AutomergeUrl;
  tmp: string;
  clients: Repo[];
  connect(): Promise<{ repo: Repo; handle: Awaited<ReturnType<Repo["find"]>> }>;
  authed(path: string, init?: RequestInit & { agent?: string }): Promise<Response>;
  stop(): Promise<void>;
}

export async function makeWorld(opts: { mirror?: import("../src/server/persist").ObjectMirror } = {}): Promise<TestWorld> {
  const tmp = mkdtempSync(join(tmpdir(), "mrkdwn-test-"));
  const config = loadConfig({ port: 0, dataDir: tmp });
  // never mirror test docs to a real bucket (bun auto-loads .env, which may
  // carry S3 credentials for dev) — persistence has its own unit tests
  delete config.s3;
  // instant agent edits — the typewriter has its own tests
  delete config.agentTyping;
  const running = await startServer({ config, mirror: opts.mirror });
  const base = `http://localhost:${running.server.port}`;
  const clients: Repo[] = [];

  const world: TestWorld = {
    running,
    base,
    token: config.state.agentToken,
    docUrl: config.state.docUrl as AutomergeUrl,
    tmp,
    clients,
    async connect() {
      const repo = new Repo({
        network: [new WebSocketClientAdapter(`ws://localhost:${running.server.port}/sync`, 500)],
      });
      clients.push(repo);
      await whenPeered(repo);
      const handle = await repo.find<MrkdwnDoc>(world.docUrl);
      await handle.whenReady();
      return { repo, handle };
    },
    async authed(path, init = {}) {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${config.state.agentToken}`);
      if (init.agent) headers.set("x-agent", init.agent);
      if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
      return fetch(`${base}${path}`, { ...init, headers });
    },
    async stop() {
      for (const c of clients) await c.shutdown();
      await running.stop();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
  return world;
}

export async function until<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 5000, step = 50): Promise<T> {
  const deadline = Date.now() + ms;
  let last: T;
  for (;;) {
    last = await fn();
    if (ok(last)) return last;
    if (Date.now() > deadline) throw new Error(`until(): condition not met within ${ms}ms; last=${JSON.stringify(last)?.slice(0, 300)}`);
    await new Promise(r => setTimeout(r, step));
  }
}
