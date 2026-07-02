/**
 * Durability state for the topbar dot:
 *   "offline" — the sync websocket is down (editing is locked)
 *   "pending" — the doc has changes the server hasn't confirmed as written
 *               to S3 yet (amber)
 *   "saved"   — everything is durable (green)
 *
 * The persist worker broadcasts `{ type: "persisted", heads }` on the doc's
 * sync channel after each S3 write; we compare our own heads against it.
 * Anyone's edit (local or synced-in) moves our heads → pending until the
 * next announcement covers them. Self-correcting: a stale comparison flips
 * back the moment the next broadcast or sync message lands.
 */
import { useEffect, useState } from "react";
import * as A from "@automerge/automerge";
import type { DocHandle } from "@automerge/automerge-repo";
import type { MrkdwnDoc } from "../../shared/types";

export type Durability = "saved" | "pending" | "offline";

interface PersistedMessage {
  type?: unknown;
  heads?: unknown;
}

function sameHeads(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const bs = new Set(b);
  return a.every(h => bs.has(h));
}

export function useDurability(
  handle: DocHandle<MrkdwnDoc>,
  connected: boolean,
  /** server mirrors to S3 (from /api/status) — false keeps the dot green */
  enabled: boolean
): Durability {
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let persistedHeads: string[] | null = null;
    let touched = false; // saw any change before the first announcement

    const recompute = () => {
      const heads = A.getHeads(handle.doc());
      setPending(persistedHeads ? !sameHeads(heads, persistedHeads) : touched);
    };
    const onChange = () => {
      touched = true;
      recompute();
    };
    const onEphemeral = (payload: { message: unknown }) => {
      const msg = payload.message as PersistedMessage;
      if (msg?.type !== "persisted" || !Array.isArray(msg.heads)) return;
      persistedHeads = msg.heads as string[];
      recompute();
    };

    handle.on("change", onChange);
    handle.on("ephemeral-message", onEphemeral);
    return () => {
      handle.off("change", onChange);
      handle.off("ephemeral-message", onEphemeral);
    };
  }, [handle]);

  if (!connected) return "offline";
  return enabled && pending ? "pending" : "saved";
}
