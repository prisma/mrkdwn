/**
 * Long-term durable storage: continually mirrors every page's full Automerge
 * file (content + complete history, via `A.save`) to S3.
 *
 * Write discipline:
 *  - only when a doc actually changed (dirty-tracked off the handle's change
 *    events, compared by heads)
 *  - at most one write per doc per `intervalMs` (default 2s) — a typing burst
 *    coalesces into a single S3 PUT
 *  - Postgres is only touched *after* a successful S3 write (`persistedAt`);
 *    nothing here runs on the edit hot path
 *
 * Objects are named `{workspaceId}/{pageId}.automerge` — the automerge binary
 * is self-contained, so restoring a doc is one GET + `A.load`.
 *
 * After each successful write the worker broadcasts the persisted heads on
 * the doc's sync channel; clients compare their own heads against it to drive
 * the durability indicator (amber = unpersisted changes, green = durable).
 */
import * as A from "@automerge/automerge";
import type { S3Config, ServerConfig } from "./config";
import type { DocStore } from "./store";
import type { PageEntry } from "./repo";

/** The S3 calls we make: the worker writes, boot-time restore reads. */
export interface ObjectWriter {
  write(key: string, data: Uint8Array): Promise<unknown>;
}
export interface ObjectMirror extends ObjectWriter {
  /** null when the object doesn't exist */
  read(key: string): Promise<Uint8Array | null>;
}

export function createObjectMirror(s3: S3Config): ObjectMirror {
  const client = new Bun.S3Client({
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    bucket: s3.bucket,
    endpoint: s3.endpoint,
    region: "auto",
  });
  return {
    write: (key, data) => client.write(key, data),
    async read(key) {
      try {
        return new Uint8Array(await client.file(key).arrayBuffer());
      } catch {
        return null;
      }
    },
  };
}

export function mirrorKey(workspaceId: string, pageId: string): string {
  return `${workspaceId}/${pageId}.automerge`;
}

interface DocState {
  entry: PageEntry;
  dirty: boolean;
  saving: boolean;
  /** wall-clock time the last successful save started (rate-limit anchor) */
  lastSaveAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  persistedHeads: A.Heads | null;
  failures: number;
}

export interface PersistWorkerOptions {
  /** minimum time between S3 writes per doc */
  intervalMs?: number;
  now?: () => number;
}

export class PersistWorker {
  private docs = new Map<string, DocState>();
  private disposed = false;
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(
    private writer: ObjectWriter,
    private store: DocStore,
    private workspaceId: string,
    opts: PersistWorkerOptions = {}
  ) {
    this.intervalMs = opts.intervalMs ?? 2000;
    this.now = opts.now ?? Date.now;
  }

  objectKey(pageId: string): string {
    return mirrorKey(this.workspaceId, pageId);
  }

  /** Start mirroring a page. Persists once immediately as the baseline. */
  watch(entry: PageEntry): void {
    if (this.docs.has(entry.record.id)) return;
    const state: DocState = {
      entry,
      dirty: true, // baseline write on boot — S3 state is unknown
      saving: false,
      lastSaveAt: 0,
      timer: null,
      persistedHeads: null,
      failures: 0,
    };
    this.docs.set(entry.record.id, state);
    entry.handle.on("change", () => this.markDirty(state));
    this.schedule(state);
  }

  private markDirty(state: DocState): void {
    if (this.disposed) return;
    const heads = A.getHeads(state.entry.handle.doc());
    if (state.persistedHeads && sameHeads(heads, state.persistedHeads)) return; // e.g. our own broadcast echo
    state.dirty = true;
    this.schedule(state);
  }

  /** Next write fires `intervalMs` after the previous one — never sooner. */
  private schedule(state: DocState, extraDelay = 0): void {
    if (this.disposed || state.timer || state.saving || !state.dirty) return;
    const dueIn = Math.max(0, state.lastSaveAt + this.intervalMs - this.now()) + extraDelay;
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.save(state);
    }, dueIn);
  }

  private async save(state: DocState): Promise<void> {
    if (this.disposed || state.saving || !state.dirty) return;
    state.saving = true;
    state.dirty = false;
    state.lastSaveAt = this.now();
    const doc = state.entry.handle.doc();
    const heads = A.getHeads(doc);
    try {
      const bytes = A.save(doc);
      await this.writer.write(this.objectKey(state.entry.record.id), bytes);
      state.persistedHeads = heads;
      state.failures = 0;
      // registry bookkeeping + client indicator — both after the S3 write
      await this.store.markPersisted(state.entry.record.id, new Date(this.now())).catch(() => {});
      this.announce(state);
    } catch (err) {
      state.dirty = true;
      state.failures++;
      if (state.failures <= 3 || state.failures % 10 === 0) {
        console.warn(`[mrkdwn] s3 persist failed for ${state.entry.record.id} (attempt ${state.failures}):`, err);
      }
    } finally {
      state.saving = false;
    }
    // more changes may have landed mid-upload; failures retry with backoff
    this.schedule(state, state.failures > 0 ? Math.min(state.failures, 15) * 1000 : 0);
  }

  /** Tell connected clients what's durable now. */
  private announce(state: DocState): void {
    if (!state.persistedHeads) return;
    try {
      state.entry.handle.broadcast({ type: "persisted", heads: state.persistedHeads });
    } catch {}
  }

  /** Number of docs with unpersisted changes (used by /api/status + tests). */
  pendingCount(): number {
    return [...this.docs.values()].filter(s => s.dirty || s.saving).length;
  }

  /** Wait until everything dirty has been written (tests, shutdown). */
  async settle(timeoutMs = 10_000): Promise<void> {
    const deadline = this.now() + timeoutMs;
    while (this.pendingCount() > 0 && this.now() < deadline) {
      await new Promise(r => setTimeout(r, 20));
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const state of this.docs.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
    }
  }
}

export function sameHeads(a: A.Heads, b: A.Heads): boolean {
  if (a.length !== b.length) return false;
  const bs = new Set(b);
  return a.every(h => bs.has(h));
}

export function startPersistence(
  config: ServerConfig,
  store: DocStore,
  workspaceId: string
): PersistWorker | undefined {
  if (!config.s3) return undefined;
  return new PersistWorker(createObjectMirror(config.s3), store, workspaceId);
}
