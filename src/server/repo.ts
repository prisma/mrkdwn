/**
 * Automerge repo + the workspace's pages. Content lives in Automerge (one doc
 * per page); the registry (workspace, page ids/titles/slugs) lives in the
 * DocStore. All pages are opened at boot so mention scanning and the REST API
 * can reach any of them; title edits in a page sync back to the registry
 * (debounced), re-deriving the slug.
 */
import { Repo, type DocHandle, type PeerId, type AutomergeUrl } from "@automerge/automerge-repo";
import { WebSocketServerAdapter } from "@automerge/automerge-repo-network-websocket";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import { join } from "node:path";
import { BunWSServer } from "./wsbridge";
import type { ServerConfig } from "./config";
import type { DocStore, DocumentRecord, WorkspaceRecord } from "./store";
import type { MrkdwnDoc } from "../shared/types";
import { newPageId, uniqueSlug } from "../shared/slug";
import { WELCOME_DOC } from "./welcome";
import { createObjectMirror, mirrorKey, type ObjectMirror } from "./persist";

const TITLE_SYNC_DEBOUNCE_MS = 400;

export interface PageEntry {
  record: DocumentRecord;
  handle: DocHandle<MrkdwnDoc>;
}

export interface DocHost {
  repo: Repo;
  bridge: BunWSServer;
  store: DocStore;
  workspace: WorkspaceRecord;
  /** the first page — target of doc endpoints when no `?page=` is given */
  defaultPage: PageEntry;
  /** legacy alias so single-doc call sites keep working */
  handle: DocHandle<MrkdwnDoc>;
  pages(): PageEntry[];
  page(id: string): PageEntry | undefined;
  pageBySlug(slug: string): PageEntry | undefined;
  createPage(title: string): Promise<PageEntry>;
  onPage(cb: (entry: PageEntry) => void): void;
  pagePath(entry: PageEntry): string;
}

export async function openDocHost(
  config: ServerConfig,
  store: DocStore,
  mirror: ObjectMirror | undefined = config.s3 ? createObjectMirror(config.s3) : undefined
): Promise<DocHost> {
  const bridge = new BunWSServer();
  // The bridge implements exactly the surface the adapter uses; the adapter's
  // types want `ws.WebSocketServer`, hence the cast.
  const adapter = new WebSocketServerAdapter(bridge as never);

  const storage = new NodeFSStorageAdapter(join(config.dataDir, "automerge"));
  const repo = new Repo({
    peerId: `mrkdwn-server-${config.port}` as PeerId,
    network: [adapter],
    storage,
    sharePolicy: async () => true,
  });

  const workspace = await store.ensurePublicWorkspace(config.workspace.handle, config.workspace.name);
  const entries = new Map<string, PageEntry>();
  const pageListeners: ((entry: PageEntry) => void)[] = [];

  const takenSlugs = (excludeId?: string) =>
    new Set([...entries.values()].filter(e => e.record.id !== excludeId).map(e => e.record.slug));

  /** Title edits (from any peer or the API) flow back into the registry. */
  const watchTitle = (entry: PageEntry) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    entry.handle.on("change", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const title = entry.handle.doc()?.title ?? "";
        if (title === entry.record.title) return;
        const slug = uniqueSlug(title, takenSlugs(entry.record.id));
        entry.record.title = title;
        entry.record.slug = slug;
        entry.record.updatedAt = Date.now();
        store.updateDocument(entry.record.id, { title, slug }).catch(err => {
          console.warn("[mrkdwn] title sync failed:", err);
        });
      }, TITLE_SYNC_DEBOUNCE_MS);
    });
  };

  /** Compute disks are ephemeral per deployment: the registry may know pages
   * the local Automerge storage has never seen. Before opening, seed missing
   * docs from the S3 mirror (a full `A.save` file is a valid storage chunk),
   * so `repo.find` resolves offline instead of hanging the boot. */
  const restoreFromMirror = async (record: DocumentRecord): Promise<void> => {
    if (!mirror) return;
    const docId = record.automergeUrl.replace(/^automerge:/, "");
    const local = await storage.loadRange([docId]);
    if (local.length > 0) return; // present on disk — nothing to restore
    const bytes = await mirror.read(mirrorKey(record.workspaceId, record.id));
    if (!bytes) return; // never persisted (or mirror unreachable) — let the timeout decide
    await storage.save([docId, "snapshot", "s3-restore"], bytes);
    console.log(`[mrkdwn] restored ${record.id} ("${record.title}") from the S3 mirror`);
  };

  const openEntry = async (record: DocumentRecord): Promise<PageEntry | null> => {
    await restoreFromMirror(record).catch(err => {
      console.warn(`[mrkdwn] mirror restore failed for ${record.id}:`, err);
    });
    // find() blocks until the doc is ready — a doc in neither storage nor
    // mirror would block forever, so race it against a timeout and skip the
    // page instead of never booting (the registry row stays; a future mirror
    // can revive it). Rejections (unavailable, bad url) also skip.
    const handle = await Promise.race([
      repo.find<MrkdwnDoc>(record.automergeUrl as AutomergeUrl),
      new Promise<null>(r => setTimeout(() => r(null), 10_000)),
    ]).catch((err: unknown) => {
      console.warn(`[mrkdwn] page ${record.id} ("${record.title}") failed to load — skipping:`, err);
      return null;
    });
    if (!handle) {
      console.warn(`[mrkdwn] page ${record.id} ("${record.title}") has no local data and no mirror — skipping`);
      // drop the never-ready handle, or repo.shutdown()'s flush trips on it
      try {
        repo.delete(record.automergeUrl as AutomergeUrl);
      } catch {}
      return null;
    }
    await handle.whenReady();
    const entry: PageEntry = { record, handle };
    entries.set(record.id, entry);
    watchTitle(entry);
    return entry;
  };

  const createEntry = async (title: string, initial?: MrkdwnDoc): Promise<PageEntry> => {
    const handle = repo.create<MrkdwnDoc>(initial ?? { title, content: "", comments: {} });
    const record = await store.createDocument({
      id: newPageId(),
      workspaceId: workspace.id,
      title,
      slug: uniqueSlug(title, takenSlugs()),
      automergeUrl: handle.url,
    });
    const entry: PageEntry = { record, handle };
    entries.set(record.id, entry);
    watchTitle(entry);
    for (const cb of pageListeners) cb(entry);
    return entry;
  };

  // Open everything registered; migrate a pre-workspace single doc; seed the
  // welcome page into an empty workspace.
  const records = await store.listDocuments(workspace.id);
  for (const record of records) await openEntry(record);

  if (config.state.docUrl && ![...entries.values()].some(e => e.record.automergeUrl === config.state.docUrl)) {
    const handle = await repo.find<MrkdwnDoc>(config.state.docUrl as AutomergeUrl);
    const ready = await Promise.race([
      handle.whenReady().then(() => true),
      new Promise<false>(r => setTimeout(() => r(false), 10_000)),
    ]);
    if (!ready) {
      console.warn(`[mrkdwn] legacy doc ${config.state.docUrl} is not in local storage — skipping migration`);
    } else {
      const title = handle.doc()?.title ?? "Untitled";
      const record = await store.createDocument({
        id: newPageId(),
        workspaceId: workspace.id,
        title,
        slug: uniqueSlug(title, takenSlugs()),
        automergeUrl: handle.url,
      });
      const entry: PageEntry = { record, handle };
      entries.set(record.id, entry);
      watchTitle(entry);
    }
  }

  if (entries.size === 0) {
    const entry = await createEntry(WELCOME_DOC.title, WELCOME_DOC);
    config.state.docUrl = entry.handle.url; // legacy pointer, kept for compat
    config.saveState();
  }

  const ordered = () =>
    [...entries.values()].sort(
      (a, b) => a.record.createdAt - b.record.createdAt || a.record.id.localeCompare(b.record.id)
    );

  const defaultPage = ordered()[0]!;
  if (!config.state.docUrl) {
    config.state.docUrl = defaultPage.handle.url;
    config.saveState();
  }

  // The repo defers adapter.connect() behind async peer metadata; a socket
  // accepted before the adapter listens would have its join message dropped
  // and hang that client. Only start serving once the adapter is wired up.
  const deadline = Date.now() + 5000;
  while (bridge.listenerCount("connection") === 0) {
    if (Date.now() > deadline) throw new Error("sync adapter never attached to the websocket bridge");
    await new Promise(r => setTimeout(r, 1));
  }

  return {
    repo,
    bridge,
    store,
    workspace,
    defaultPage,
    handle: defaultPage.handle,
    pages: ordered,
    page: id => entries.get(id),
    pageBySlug: slug => ordered().find(e => e.record.slug === slug),
    createPage: title => createEntry(title),
    onPage: cb => pageListeners.push(cb),
    pagePath: entry => `/${workspace.handle}/${entry.record.id}${entry.record.slug ? `-${entry.record.slug}` : ""}`,
  };
}
