/**
 * Presence over Automerge's ephemeral message channel.
 *
 * Outgoing: the local selection is converted to Automerge cursors at send time
 * (throttled), so every peer can resolve it against *their* view of the doc no
 * matter how far ahead/behind they are. A heartbeat keeps us visible; `gone`
 * lets peers drop us instantly on tab close.
 *
 * Incoming: peers live in a map keyed by user id, pruned on staleness. React
 * consumes snapshots via useSyncExternalStore; the editor extension resolves
 * cursor strings to positions when it decorates.
 */
import * as A from "@automerge/automerge";
import type { DocHandle } from "@automerge/automerge-repo";
import type { Author, MrkdwnDoc, PresenceMessage } from "../../shared/types";

export interface Peer {
  user: Author;
  anchor: string | null;
  head: string | null;
  typing: boolean;
  /** local receipt time — used for staleness, immune to clock skew */
  lastSeen: number;
  /** last time the cursor actually moved — drives the name-flag fade */
  lastMoved: number;
}

const SEND_THROTTLE_MS = 80;
const HEARTBEAT_MS = 5000;
const PEER_TTL_MS = 15000;
const TYPING_TTL_MS = 1600;

export class PresenceStore {
  private peersById = new Map<string, Peer>();
  private listeners = new Set<() => void>();
  private snapshot: Peer[] = [];

  private localSel: { anchor: number; head: number } | null = null;
  private lastTypedAt = 0;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval>;
  private pruner: ReturnType<typeof setInterval>;
  private offEphemeral: () => void;

  constructor(
    private handle: DocHandle<MrkdwnDoc>,
    private self: Author
  ) {
    const onMsg = (payload: { message: unknown }) => this.receive(payload.message as PresenceMessage);
    handle.on("ephemeral-message", onMsg);
    this.offEphemeral = () => handle.off("ephemeral-message", onMsg);

    this.heartbeat = setInterval(() => this.send(), HEARTBEAT_MS);
    this.pruner = setInterval(() => this.prune(), 2500);

    window.addEventListener("beforeunload", this.sayGoodbye);
    this.send();
  }

  get me(): Author {
    return this.self;
  }

  setSelf(user: Author): void {
    this.self = user;
    this.send();
  }

  /** Editor calls this on selection changes; `typed` marks actual edits. */
  setLocalSelection(anchor: number, head: number, typed: boolean): void {
    this.localSel = { anchor, head };
    if (typed) this.lastTypedAt = Date.now();
    if (this.sendTimer) return;
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      this.send();
    }, SEND_THROTTLE_MS);
  }

  private send(gone = false): void {
    const doc = this.handle.doc();
    if (!doc) return;
    let anchor: string | null = null;
    let head: string | null = null;
    if (this.localSel) {
      const len = doc.content.length;
      try {
        anchor = cursorAt(doc, Math.min(this.localSel.anchor, len), len);
        head = cursorAt(doc, Math.min(this.localSel.head, len), len);
      } catch {
        anchor = head = null;
      }
    }
    const msg: PresenceMessage = {
      type: "presence",
      user: this.self,
      anchor,
      head,
      typing: Date.now() - this.lastTypedAt < TYPING_TTL_MS,
      gone: gone || undefined,
      ts: Date.now(),
    };
    try {
      this.handle.broadcast(msg);
    } catch {}
  }

  private sayGoodbye = () => this.send(true);

  private receive(msg: PresenceMessage): void {
    if (!msg || msg.type !== "presence" || !msg.user?.id) return;
    if (msg.user.id === this.self.id) return; // another tab of ours

    if (msg.gone) {
      if (this.peersById.delete(msg.user.id)) this.bump();
      return;
    }
    const prev = this.peersById.get(msg.user.id);
    const moved = !prev || prev.head !== msg.head || prev.anchor !== msg.anchor;
    this.peersById.set(msg.user.id, {
      user: msg.user,
      anchor: msg.anchor,
      head: msg.head,
      typing: !!msg.typing,
      lastSeen: Date.now(),
      lastMoved: moved ? Date.now() : (prev?.lastMoved ?? Date.now()),
    });
    this.bump();
  }

  private prune(): void {
    const cutoff = Date.now() - PEER_TTL_MS;
    let changed = false;
    for (const [id, peer] of this.peersById) {
      if (peer.lastSeen < cutoff) {
        this.peersById.delete(id);
        changed = true;
      } else if (peer.typing && Date.now() - peer.lastSeen > TYPING_TTL_MS) {
        this.peersById.set(id, { ...peer, typing: false });
        changed = true;
      }
    }
    if (changed) this.bump();
  }

  private bump(): void {
    this.snapshot = [...this.peersById.values()].sort((a, b) => a.user.id.localeCompare(b.user.id));
    for (const l of this.listeners) l();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getPeers = (): Peer[] => this.snapshot;

  /** Resolve a peer cursor against the current doc; null when unresolvable. */
  resolve(cursor: string | null): number | null {
    if (cursor === null) return null;
    try {
      const doc = this.handle.doc();
      return A.getCursorPosition(doc, ["content"], cursor);
    } catch {
      return null;
    }
  }

  dispose(): void {
    this.sayGoodbye();
    window.removeEventListener("beforeunload", this.sayGoodbye);
    clearInterval(this.heartbeat);
    clearInterval(this.pruner);
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.offEphemeral();
    this.listeners.clear();
  }
}

export function cursorAt(doc: A.Doc<MrkdwnDoc>, index: number, len: number): string {
  return A.getCursor(doc, ["content"], index >= len ? "end" : index);
}
