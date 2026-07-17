import { resolve, join } from "node:path";
import { loadConfig, type ServerConfig } from "./config";
import { createStore } from "./store";
import { openDocHost } from "./repo";
import { NotificationCenter } from "./notifications";
import { handleApi, broadcastAgentPresence, type ApiContext } from "./api";
import { buildSnippet, skillMarkdown } from "./skill";
import { createObjectMirror, startPersistence, type ObjectMirror, type PersistWorker } from "./persist";
import { handleImages } from "./images";
import { handlePreview } from "./hyperframes";
import type { SyncSocketData } from "./wsbridge";

export interface RunningServer {
  server: Bun.Server<SyncSocketData>;
  ctx: ApiContext;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** Bun HTML bundle for the web app (dev mode, HMR). */
  web?: unknown;
  /** Directory of a prebuilt web bundle (production; see build.ts). */
  webDist?: string;
  config?: ServerConfig;
  /** object storage override (tests inject a fake; default: from config.s3) */
  mirror?: ObjectMirror;
}

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const config = opts.config ?? loadConfig();
  const store = createStore(config.databaseUrl);
  // one mirror shared by boot-restore, the persist worker, and image serving
  const mirror = opts.mirror ?? (config.s3 ? createObjectMirror(config.s3) : undefined);
  const host = await openDocHost(config, store, mirror);

  // eslint-disable-next-line prefer-const
  let ctx: ApiContext;
  const notifications = new NotificationCenter(config.dataDir, handle => {
    // any agent activity → refresh its avatar in connected UIs
    if (ctx) broadcastAgentPresence(ctx, handle, {});
  });
  for (const entry of host.pages()) notifications.watch(entry.record.id, entry.handle, () => entry.record.title);
  host.onPage(entry => notifications.watch(entry.record.id, entry.handle, () => entry.record.title));

  // durable storage: mirror every page's automerge file to S3 (when configured)
  const persistence: PersistWorker | undefined = startPersistence(config, store, host.workspace.id, mirror);
  if (persistence) {
    for (const entry of host.pages()) persistence.watch(entry);
    host.onPage(entry => persistence.watch(entry));
  }

  ctx = { config, host, notifications, persistence, ...(mirror ? { mirror } : {}) };

  async function handleRequest(req: Request, srv: Bun.Server<SyncSocketData>): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/sync") {
      if (srv.upgrade(req, { data: {} })) return undefined as unknown as Response;
      return new Response("expected a websocket upgrade", { status: 426 });
    }

    if (url.pathname === "/skill.md" && req.method === "GET") {
      return new Response(skillMarkdown(config), {
        headers: { "content-type": "text/markdown; charset=utf-8" },
      });
    }

    // The architecture tour — a self-contained static page (src/web/tour.html)
    if (url.pathname === "/tour" && req.method === "GET") {
      return new Response(Bun.file(join(import.meta.dir, "../web/tour.html")), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // Serves the invite snippet to the web UI ("Invite your agent"). The
    // invite targets one page; the agent names itself on first contact
    // (X-Agent/X-Agent-Name), which also delivers pre-existing @mentions.
    if (url.pathname === "/api/agent-setup" && req.method === "GET") {
      const pageId = url.searchParams.get("page");
      const entry = (pageId ? host.page(pageId) : undefined) ?? host.defaultPage;
      const page = {
        id: entry.record.id,
        title: entry.handle.doc().title,
        path: host.pagePath(entry),
        kind: entry.record.kind ?? ("markdown" as const),
      };
      return new Response(buildSnippet(config, page), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // hyperframes projects served as a virtual directory (+ the player shell)
    const preview = await handlePreview(req, url, { config, host, ...(mirror ? { mirror } : {}) });
    if (preview) return preview;

    // pasted images: upload + cached (optionally resized) serving
    const image = await handleImages(req, url, { store, mirror, workspaceId: host.workspace.id });
    if (image) return image;

    const api = await handleApi(req, url, ctx);
    if (api) return api;

    if (opts.webDist && req.method === "GET") {
      const staticRes = await serveStatic(opts.webDist, url.pathname);
      if (staticRes) return staticRes;
      // SPA fallback: /:workspace/:id-slug deep links serve the app shell
      if (!url.pathname.startsWith("/api/") && !url.pathname.includes(".")) {
        const index = await serveStatic(opts.webDist, "/");
        if (index) return index;
      }
    }

    return new Response("not found", { status: 404 });
  }

  const routes: Record<string, unknown> = {};
  if (opts.web) {
    routes["/"] = opts.web;
    // deep links (/:workspace/:id-slug) serve the same dev bundle...
    routes["/:ws/:page"] = opts.web;
    // ...which would shadow two-segment API paths — pin those back to fetch
    for (const p of [
      "/api/status",
      "/api/workspace",
      "/api/pages",
      "/api/doc",
      "/api/comments",
      "/api/notifications",
      "/api/presence",
      "/api/agent-setup",
      "/api/images",
    ]) {
      routes[p] = (req: Request) => handleRequest(req, server);
    }
  }

  const server = Bun.serve<SyncSocketData, never>({
    port: config.port,
    idleTimeout: 120,
    development: opts.web ? { hmr: true } : false,
    routes: routes as never,
    websocket: host.bridge.websocket,
    fetch: handleRequest,
  });

  // If we bound an ephemeral port (tests) or the default, keep baseUrl honest.
  if (!process.env.MRKDWN_BASE_URL) {
    config.baseUrl = `http://localhost:${server.port}`;
  }

  // Agents that are actively polling stay visible in the UI between requests.
  const presencePulse = setInterval(() => {
    for (const status of notifications.statuses()) {
      if (status.online) broadcastAgentPresence(ctx, status.handle, {});
    }
  }, 10_000);

  console.log(
    `mrkdwn listening on ${config.baseUrl}  (workspace: ${host.workspace.handle}, ${host.pages().length} page${host.pages().length === 1 ? "" : "s"}, registry: ${config.databaseUrl ? "prisma-postgres" : "memory"})`
  );

  async function serveStatic(distDir: string, pathname: string): Promise<Response | null> {
    const root = resolve(distDir);
    const rel = pathname === "/" ? "index.html" : pathname.slice(1);
    const full = resolve(join(root, rel));
    if (!full.startsWith(root + "/") && full !== join(root, "index.html")) return null;
    const file = Bun.file(full);
    if (!(await file.exists())) return null;
    return new Response(file, {
      headers: rel === "index.html" ? { "cache-control": "no-cache" } : { "cache-control": "public, max-age=31536000, immutable" },
    });
  }

  return {
    server,
    ctx,
    async stop() {
      clearInterval(presencePulse);
      persistence?.dispose();
      notifications.dispose();
      host.bridge.shutdown();
      server.stop(true);
      await host.repo.shutdown();
      await store.close();
    },
  };
}
