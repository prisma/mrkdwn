// Must be first: in browser bundles this resolves (via automerge.plugin.ts) to
// automerge's base64 entrypoint, which initializes wasm synchronously — every
// later automerge import then finds it ready.
import "@automerge/automerge";
import "./styles.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Repo, type AutomergeUrl, type DocHandle } from "@automerge/automerge-repo/slim";
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import { RepoContext } from "@automerge/automerge-repo-react-hooks";
import { App } from "./App";
import { whenPeered } from "../shared/connect";
import { createPageRequest, parsePageId, useWorkspace } from "./app/workspace";
import type { MrkdwnDoc, PageMeta } from "../shared/types";

function Splash({ message, error }: { message?: string; error?: string }) {
  return (
    <div className="splash">
      <div className="splash-inner">
        <div className="splash-brand">mrkdwn</div>
        {error ? <p className="splash-error">{error}</p> : <p>{message ?? "Connecting…"}</p>}
      </div>
    </div>
  );
}

/** Routing + workspace shell: resolves /:workspace/:id-slug to a page (by id
 * only), opens its Automerge doc, and remounts the editor app per page. */
function Root({ repo, adapter }: { repo: Repo; adapter: WebSocketClientAdapter }) {
  const { workspace, refresh } = useWorkspace();
  const [routePageId, setRoutePageId] = useState<string | null>(() => parsePageId(location.pathname));
  const handles = useRef(new Map<string, DocHandle<MrkdwnDoc>>());
  const [, setHandleVersion] = useState(0);
  // navigation must see the freshest pages even from stale closures
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  const page: PageMeta | null = useMemo(
    () => workspace?.pages.find(p => p.id === routePageId) ?? workspace?.pages[0] ?? null,
    [workspace, routePageId]
  );

  useEffect(() => {
    const onPop = () => setRoutePageId(parsePageId(location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // canonicalize the URL (default page on "/", slug drift after renames)
  useEffect(() => {
    if (page && location.pathname !== page.path) history.replaceState(null, "", page.path);
  }, [page?.path]);

  // open (and cache) the doc handle for the current page
  useEffect(() => {
    if (!page || handles.current.has(page.id)) return;
    let cancelled = false;
    (async () => {
      const handle = await repo.find<MrkdwnDoc>(page.automergeUrl as AutomergeUrl);
      await handle.whenReady();
      if (!cancelled) {
        handles.current.set(page.id, handle);
        setHandleVersion(v => v + 1);
      }
    })().catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [page?.id, repo]);

  const navigate = useCallback((id: string) => {
    const target = workspaceRef.current?.pages.find(p => p.id === id);
    if (!target) return;
    history.pushState(null, "", target.path);
    setRoutePageId(id);
  }, []);

  const createPage = useCallback(
    async (title?: string) => {
      const created = await createPageRequest(title);
      if (created) {
        await refresh();
        // navigate(created.id) may run before the refreshed state renders —
        // patch the ref so the new page is findable immediately
        const ws = workspaceRef.current;
        if (ws && !ws.pages.some(p => p.id === created.id)) {
          workspaceRef.current = { ...ws, pages: [...ws.pages, created] };
        }
      }
      return created;
    },
    [refresh]
  );

  // create → open → title focused & selected, so typing renames immediately
  const [freshPageId, setFreshPageId] = useState<string | null>(null);
  const createAndOpenPage = useCallback(
    async (title?: string) => {
      const created = await createPage(title);
      if (created) {
        setFreshPageId(created.id);
        navigate(created.id);
      }
      return created;
    },
    [createPage, navigate]
  );

  const handle = page ? handles.current.get(page.id) : undefined;
  if (!workspace || !page || !handle) return <Splash message="Loading workspace…" />;

  return (
    <App
      key={page.id}
      handle={handle}
      adapter={adapter}
      workspace={workspace.workspace}
      pages={workspace.pages}
      currentPageId={page.id}
      onNavigate={navigate}
      onCreatePage={createPage}
      onCreateAndOpenPage={createAndOpenPage}
      focusTitle={page.id === freshPageId}
      onFocusTitleConsumed={() => setFreshPageId(null)}
    />
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<Splash />);

async function boot() {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) throw new Error(`status ${res.status} from /api/status`);
    await res.json();

    const wsProto = location.protocol === "https:" ? "wss" : "ws";
    const adapter = new WebSocketClientAdapter(`${wsProto}://${location.host}/sync`);
    const repo = new Repo({ network: [adapter] });
    // debugging hook, like __mrkdwnView (e.g. simulate outages from the console)
    (window as unknown as Record<string, unknown>).__mrkdwnAdapter = adapter;
    // wait for the sync handshake — find() before a peer exists caches "unavailable"
    await whenPeered(repo);

    root.render(
      <RepoContext.Provider value={repo}>
        <Root repo={repo} adapter={adapter} />
      </RepoContext.Provider>
    );
  } catch (err) {
    console.error(err);
    root.render(<Splash error={`Couldn't connect to the workspace. Is the server running? (${String(err)})`} />);
  }
}

boot();
