/**
 * Who wrote what: per-author attribution of the document text, derived from
 * Automerge history. Each change is diffed against its parents; inserted
 * content spans become cursor pairs, which resolve to positions in the
 * current document (so they survive every later edit, and fully deleted
 * text drops out on its own).
 *
 * Author keys:
 *  - `agent:<handle>` — server-applied agent edits, tagged via the change
 *    message (all agents share the server's actor, so the actor can't
 *    distinguish them)
 *  - `actor:<actorId>` — everything else; clients register their session
 *    actor in `doc.authors` so actors map back to people
 *
 * A range naturally stretches over text later inserted *inside* it by
 * someone else, so resolution subtracts every other author's ranges.
 *
 * Extracting pairs is the expensive part (a wasm diff per change), but a
 * change's insertions never change once written — so `AttributionIndex`
 * does that work once per change and makes repeat lookups cheap. The
 * one-shot functions below share the same core.
 */
import * as A from "@automerge/automerge";
import type { MrkdwnDoc } from "./types";

export type AuthorKey = `agent:${string}` | `actor:${string}`;

export interface AttributedRange {
  from: number;
  to: number;
}

interface CursorPair {
  key: AuthorKey;
  start: string;
  /** cursor of the LAST inserted char — `getCursor(len)` returns the `e`
   * sentinel that tracks the *current* end forever, so bounds pin to real
   * characters and the range end is lastChar + 1 */
  last: string;
  /** change order — only later insertions carve holes into earlier ranges */
  seq: number;
}

export function changeAuthorKey(message: string | null | undefined, actor: string): AuthorKey {
  if (message) {
    try {
      const parsed = JSON.parse(message) as { agent?: unknown };
      if (typeof parsed?.agent === "string" && parsed.agent) return `agent:${parsed.agent}`;
    } catch {}
  }
  return `actor:${actor}`;
}

/** The content insertions one change contributed, as durable cursor pairs. */
function pairsFromChange(doc: A.Doc<MrkdwnDoc>, raw: Uint8Array, seq: number): CursorPair[] {
  const change = A.decodeChange(raw);
  const key = changeAuthorKey(change.message, change.actor);
  const patches = A.diff(doc, change.deps as A.Heads, [change.hash] as A.Heads);
  let after: A.Doc<MrkdwnDoc> | null = null;
  const pairs: CursorPair[] = [];
  for (const patch of patches) {
    if (patch.action !== "splice" || patch.path[0] !== "content" || typeof patch.value !== "string") continue;
    const index = patch.path[1];
    if (typeof index !== "number" || patch.value.length === 0) continue;
    after ??= A.view(doc, [change.hash] as A.Heads);
    pairs.push({
      key,
      start: A.getCursor(after, ["content"], index),
      last: A.getCursor(after, ["content"], index + patch.value.length - 1),
      seq,
    });
  }
  return pairs;
}

function mergeRanges(ranges: AttributedRange[]): AttributedRange[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
  const out: AttributedRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  return out;
}

function subtractRanges(base: AttributedRange[], holes: AttributedRange[]): AttributedRange[] {
  if (holes.length === 0) return base;
  const out: AttributedRange[] = [];
  for (const range of base) {
    let cursor = range.from;
    for (const hole of holes) {
      if (hole.to <= cursor) continue;
      if (hole.from >= range.to) break;
      if (hole.from > cursor) out.push({ from: cursor, to: Math.min(hole.from, range.to) });
      cursor = Math.max(cursor, hole.to);
      if (cursor >= range.to) break;
    }
    if (cursor < range.to) out.push({ from: cursor, to: range.to });
  }
  return out;
}

/** Resolve cursor pairs against the current document and carve overlaps. */
function resolvePairs(doc: A.Doc<MrkdwnDoc>, pairs: CursorPair[]): Map<AuthorKey, AttributedRange[]> {
  interface SeqRange extends AttributedRange {
    key: AuthorKey;
    seq: number;
  }
  const resolved: SeqRange[] = [];
  for (const pair of pairs) {
    try {
      const from = A.getCursorPosition(doc, ["content"], pair.start);
      const lastPos = A.getCursorPosition(doc, ["content"], pair.last);
      // a deleted char's cursor resolves to where it *was* — only count the
      // last char if it still exists (cursor round-trips to the same opId)
      const lastAlive = lastPos < doc.content.length && A.getCursor(doc, ["content"], lastPos) === pair.last;
      const to = lastPos + (lastAlive ? 1 : 0);
      if (to > from) resolved.push({ key: pair.key, from, to, seq: pair.seq });
    } catch {}
  }
  // a range spans text later inserted inside it by someone else — carve out
  // only *later* foreign insertions (earlier text a range landed next to was
  // never part of it, and mutual carving would annihilate the inner author)
  const final = new Map<AuthorKey, AttributedRange[]>();
  for (const range of resolved) {
    const holes = mergeRanges(resolved.filter(other => other.key !== range.key && other.seq > range.seq));
    for (const kept of subtractRanges([range], holes)) {
      if (kept.to <= kept.from) continue;
      const ranges = final.get(range.key) ?? [];
      ranges.push(kept);
      final.set(range.key, ranges);
    }
  }
  for (const [key, ranges] of final) final.set(key, mergeRanges(ranges));
  return final;
}

/** Resolve each author's contributions to ranges in the current document. */
export function attributeContent(doc: A.Doc<MrkdwnDoc>): Map<AuthorKey, AttributedRange[]> {
  const changes = A.getAllChanges(doc);
  const pairs: CursorPair[] = [];
  for (let i = 0; i < changes.length; i++) pairs.push(...pairsFromChange(doc, changes[i]!, i));
  return resolvePairs(doc, pairs);
}

/**
 * Incremental attribution for interactive use (avatar-click spotlight).
 *
 * The wasm diff per change dominates the cost and its result is immutable,
 * so the index processes each change exactly once; Automerge appends to the
 * change log, so new history is just the tail. Resolution against the live
 * text is redone only when the doc's heads moved. Call `update()` off the
 * hot path (e.g. debounced after doc changes) to keep lookups instant.
 */
export class AttributionIndex {
  private seen = 0;
  private pairs: CursorPair[] = [];
  private resolvedHeads: string | null = null;
  private resolved: Map<AuthorKey, AttributedRange[]> | null = null;

  /** Absorb history added since the last call; cheap when nothing is new. */
  update(doc: A.Doc<MrkdwnDoc>): void {
    const changes = A.getAllChanges(doc);
    if (changes.length < this.seen) {
      // history shrank (doc was reloaded/replaced) — start over
      this.seen = 0;
      this.pairs = [];
      this.resolved = null;
    }
    if (changes.length === this.seen) return;
    for (let i = this.seen; i < changes.length; i++) this.pairs.push(...pairsFromChange(doc, changes[i]!, i));
    this.seen = changes.length;
    this.resolved = null;
  }

  /** Everything `authorId` contributed to the current document text. */
  contributionsOf(doc: A.Doc<MrkdwnDoc>, authorId: string): AttributedRange[] {
    this.update(doc);
    const headsKey = A.getHeads(doc).join("|");
    if (!this.resolved || this.resolvedHeads !== headsKey) {
      this.resolved = resolvePairs(doc, this.pairs);
      this.resolvedHeads = headsKey;
    }
    const keys = keysForAuthor(doc, authorId);
    if (keys.size === 0) return [];
    const ranges: AttributedRange[] = [];
    for (const key of keys) ranges.push(...(this.resolved.get(key) ?? []));
    return mergeRanges(ranges);
  }
}

/** Agent handles that authored any change — cheap (no diffs, no cursors),
 * for "who participated in this doc" badges. Pass `fromChange` (a previous
 * `changeCount`) to decode only changes added since the last scan. */
export function agentsInHistory(
  doc: A.Doc<MrkdwnDoc>,
  fromChange = 0
): { handles: Set<string>; changeCount: number } {
  const changes = A.getAllChanges(doc);
  const handles = new Set<string>();
  for (let i = fromChange; i < changes.length; i++) {
    const change = A.decodeChange(changes[i]!);
    const key = changeAuthorKey(change.message, change.actor);
    if (key.startsWith("agent:")) handles.add(key.slice("agent:".length));
  }
  return { handles, changeCount: changes.length };
}

/** The author keys that belong to one person/agent: their agent handle plus
 * every session actor registered under their author id. */
export function keysForAuthor(doc: MrkdwnDoc, authorId: string): Set<AuthorKey> {
  const keys = new Set<AuthorKey>();
  if (authorId.startsWith("agent:")) keys.add(authorId as AuthorKey);
  for (const [actorId, author] of Object.entries(doc.authors ?? {})) {
    if (author.id === authorId) keys.add(`actor:${actorId}`);
  }
  return keys;
}

/** Everything `authorId` contributed to the current document text. */
export function contributionsOf(doc: A.Doc<MrkdwnDoc>, authorId: string): AttributedRange[] {
  const keys = keysForAuthor(doc, authorId);
  if (keys.size === 0) return [];
  const all = attributeContent(doc);
  const ranges: AttributedRange[] = [];
  for (const key of keys) ranges.push(...(all.get(key) ?? []));
  return mergeRanges(ranges);
}
