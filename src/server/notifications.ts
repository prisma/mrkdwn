/**
 * @mention detection and agent notification queues, across every page in the
 * workspace.
 *
 * Doc-text mentions are keyed by page id + an Automerge *cursor* at the `@`
 * character, so a mention only notifies once no matter how the surrounding
 * text shifts. Comment mentions are keyed by comment/reply id (bodies are
 * immutable).
 *
 * Scanning is debounced so half-typed handles ("@cla…") don't fire; only
 * handles in the known-agent registry produce notifications. The first time a
 * page is watched, it gets a silent baseline scan — pre-existing mentions
 * (welcome doc, adopted docs) don't fire.
 */
import * as A from "@automerge/automerge";
import type { DocHandle } from "@automerge/automerge-repo";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanMentions, mentionSnippet } from "../shared/mentions";
import { nowId, type AgentNotification, type AgentStatus, type MrkdwnDoc } from "../shared/types";

const DEFAULT_AGENTS = ["claude", "codex"];
const SCAN_DEBOUNCE_MS = 1200;
const ONLINE_WINDOW_MS = 60_000;

interface AgentRecord {
  handle: string;
  /** display name the agent introduced itself with (X-Agent-Name) */
  name?: string;
  queue: AgentNotification[];
  lastSeenAt: number | null;
}

interface PersistedNotifications {
  agents: Record<string, AgentRecord>;
  /** page/cursor/comment keys of mentions already notified */
  seenKeys: string[];
  /** page ids that already had their baseline scan */
  knownPages?: string[];
}

interface WatchedPage {
  id: string;
  handle: DocHandle<MrkdwnDoc>;
  title(): string;
  timer: ReturnType<typeof setTimeout> | null;
}

type Waiter = { resolve: (n: AgentNotification[]) => void; timer: ReturnType<typeof setTimeout> };

export class NotificationCenter {
  private agents = new Map<string, AgentRecord>();
  private seenKeys = new Set<string>();
  private knownPages = new Set<string>();
  private watched = new Map<string, WatchedPage>();
  private waiters = new Map<string, Waiter[]>();
  private file: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    dataDir: string,
    private onActivity?: (handle: string) => void
  ) {
    this.file = join(dataDir, "notifications.json");
    this.load();
    for (const h of DEFAULT_AGENTS) this.ensureAgent(h);
  }

  /** Watch a page's doc + comments for new mentions. First watch is a silent
   * baseline — only mentions written afterwards notify. */
  watch(id: string, handle: DocHandle<MrkdwnDoc>, title: () => string): void {
    if (this.watched.has(id)) return;
    const page: WatchedPage = { id, handle, title, timer: null };
    this.watched.set(id, page);
    const baseline = !this.knownPages.has(id);
    this.knownPages.add(id);
    this.scanPage(page, baseline);
    handle.on("change", () => {
      if (page.timer) clearTimeout(page.timer);
      page.timer = setTimeout(() => {
        page.timer = null;
        this.scanPage(page, false);
      }, SCAN_DEBOUNCE_MS);
    });
  }

  // ---- agent registry ----

  ensureAgent(rawHandle: string): AgentRecord {
    const handle = normalizeHandle(rawHandle);
    let rec = this.agents.get(handle);
    if (!rec) {
      rec = { handle, queue: [], lastSeenAt: null };
      this.agents.set(handle, rec);
      this.scheduleSave();
      // Deliver mentions that were written before this agent existed — wiring
      // up a new agent picks up everything already waiting for it.
      for (const page of this.watched.values()) this.scanPage(page, false);
    }
    return rec;
  }

  /** Any authenticated agent request calls this — powers the online indicator
   * and records the display name the agent sends via X-Agent-Name. */
  markSeen(rawHandle: string, name?: string): void {
    const rec = this.ensureAgent(rawHandle);
    rec.lastSeenAt = Date.now();
    if (name) rec.name = name;
    this.scheduleSave();
    this.onActivity?.(rec.handle);
  }

  displayName(rawHandle: string): string | undefined {
    return this.agents.get(normalizeHandle(rawHandle))?.name;
  }

  knownHandles(): string[] {
    return [...this.agents.keys()].sort();
  }

  statuses(): AgentStatus[] {
    const now = Date.now();
    return this.knownHandles().map(handle => {
      const rec = this.agents.get(handle)!;
      return {
        handle,
        ...(rec.name ? { name: rec.name } : {}),
        online: rec.lastSeenAt !== null && now - rec.lastSeenAt < ONLINE_WINDOW_MS,
        lastSeenAt: rec.lastSeenAt,
        pending: rec.queue.length,
      };
    });
  }

  // ---- delivery ----

  pending(handle: string): AgentNotification[] {
    return this.ensureAgent(handle).queue.slice();
  }

  /** Long-poll: resolves immediately if the queue is non-empty, otherwise when
   * something arrives or `waitSeconds` elapses (empty array). */
  waitForNotifications(handle: string, waitSeconds: number): Promise<AgentNotification[]> {
    const rec = this.ensureAgent(handle);
    if (rec.queue.length > 0 || waitSeconds <= 0) return Promise.resolve(rec.queue.slice());
    return new Promise(resolve => {
      const list = this.waiters.get(rec.handle) ?? [];
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          this.removeWaiter(rec.handle, waiter);
          resolve([]);
        }, Math.min(waitSeconds, 55) * 1000),
      };
      list.push(waiter);
      this.waiters.set(rec.handle, list);
    });
  }

  ack(handle: string, ids: string[]): number {
    const rec = this.ensureAgent(handle);
    const before = rec.queue.length;
    const drop = new Set(ids);
    rec.queue = rec.queue.filter(n => !drop.has(n.id));
    this.scheduleSave();
    return before - rec.queue.length;
  }

  private enqueue(n: AgentNotification): void {
    const rec = this.ensureAgent(n.agent);
    rec.queue.push(n);
    this.scheduleSave();
    const waiting = this.waiters.get(rec.handle);
    if (waiting?.length) {
      this.waiters.delete(rec.handle);
      for (const w of waiting) {
        clearTimeout(w.timer);
        w.resolve(rec.queue.slice());
      }
    }
  }

  private removeWaiter(handle: string, waiter: Waiter): void {
    const list = this.waiters.get(handle);
    if (!list) return;
    const i = list.indexOf(waiter);
    if (i >= 0) list.splice(i, 1);
  }

  // ---- scanning ----

  /** @param silently mark everything seen without enqueueing (baseline). */
  private scanPage(page: WatchedPage, silently: boolean): void {
    const doc = page.handle.doc();
    if (!doc) return;
    const known = new Set(this.knownHandles());
    const pageInfo = () => ({ id: page.id, title: page.title() });
    const found: { key: string; make: () => AgentNotification }[] = [];

    const content = doc.content ?? "";
    for (const m of scanMentions(content)) {
      if (!known.has(m.handle)) continue;
      let cursor: string;
      try {
        cursor = A.getCursor(doc, ["content"], m.index);
      } catch {
        continue;
      }
      found.push({
        key: `${page.id}:doc:${cursor}:${m.handle}`,
        make: () => ({
          id: nowId("n"),
          agent: m.handle,
          kind: "doc-mention",
          createdAt: Date.now(),
          snippet: mentionSnippet(content, m.index),
          page: pageInfo(),
        }),
      });
    }

    // canvas text nodes: an @mention on a sticky note is a task too — keyed
    // by node id + text, so editing the note re-delivers only if the mention
    // survives the edit under a changed text
    for (const node of Object.values(doc.canvas?.nodes ?? {})) {
      if (node.type !== "text" || !node.text) continue;
      for (const m of scanMentions(node.text)) {
        if (!known.has(m.handle)) continue;
        found.push({
          key: `${page.id}:canvas:${node.id}:${m.handle}`,
          make: () => ({
            id: nowId("n"),
            agent: m.handle,
            kind: "doc-mention",
            createdAt: Date.now(),
            snippet: mentionSnippet(node.text, m.index),
            page: pageInfo(),
          }),
        });
      }
    }

    for (const comment of Object.values(doc.comments ?? {})) {
      const bodies = [
        { key: `comment:${comment.id}`, body: comment.body, from: comment.author?.name },
        ...comment.replies.map(r => ({ key: `reply:${r.id}`, body: r.body, from: r.author?.name })),
      ];
      for (const b of bodies) {
        for (const m of scanMentions(b.body)) {
          if (!known.has(m.handle)) continue;
          found.push({
            key: `${page.id}:${b.key}:${m.handle}`,
            make: () => ({
              id: nowId("n"),
              agent: m.handle,
              kind: "comment-mention",
              createdAt: Date.now(),
              snippet: mentionSnippet(b.body, m.index),
              commentId: comment.id,
              from: b.from,
              page: pageInfo(),
            }),
          });
        }
      }
    }

    for (const f of found) {
      if (this.seenKeys.has(f.key)) continue;
      this.seenKeys.add(f.key);
      if (!silently) this.enqueue(f.make());
    }
    this.scheduleSave();
  }

  // ---- persistence ----

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as PersistedNotifications;
      for (const rec of Object.values(data.agents ?? {})) this.agents.set(rec.handle, rec);
      for (const k of data.seenKeys ?? []) this.seenKeys.add(k);
      for (const p of data.knownPages ?? []) this.knownPages.add(p);
    } catch (err) {
      console.warn("[mrkdwn] could not read notifications state, starting fresh:", err);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.saveNow(), 250);
  }

  private saveNow(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const data: PersistedNotifications = {
      agents: Object.fromEntries(this.agents),
      seenKeys: [...this.seenKeys],
      knownPages: [...this.knownPages],
    };
    try {
      writeFileSync(this.file, JSON.stringify(data, null, 2));
    } catch (err) {
      console.warn("[mrkdwn] could not persist notifications state:", err);
    }
  }

  dispose(): void {
    for (const page of this.watched.values()) if (page.timer) clearTimeout(page.timer);
    this.saveNow();
    for (const list of this.waiters.values())
      for (const w of list) {
        clearTimeout(w.timer);
        w.resolve([]);
      }
    this.waiters.clear();
  }
}

export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, "").toLowerCase();
}

export function isValidHandle(handle: string): boolean {
  return /^[a-z][a-z0-9_-]{0,31}$/.test(handle);
}
