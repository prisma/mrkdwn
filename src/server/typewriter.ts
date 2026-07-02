/**
 * Human-feel agent edits. Instead of landing as one atomic splice, agent text
 * is "typed" into the doc in small chunks on a jittered cadence, with the
 * agent's caret broadcast along — humans see writing, not teleporting text.
 *
 * Correctness under concurrency:
 *  - requests animate one at a time per doc (FIFO queue), and each plans its
 *    edits against the settled content, so agents get read-after-write
 *  - the typing position rides an Automerge cursor pinned to the last typed
 *    char — concurrent human edits shift the caret instead of corrupting text
 *  - each splice's deletion is verified against the text it expects to
 *    replace; if a concurrent edit removed it, the splice is skipped rather
 *    than clobbering someone's work
 *
 * Every chunk is a change tagged with the agent's message, so per-author
 * attribution keeps working unchanged.
 */
import * as A from "@automerge/automerge";
import type { DocHandle } from "@automerge/automerge-repo";
import type { MrkdwnDoc } from "../shared/types";

export interface TypingConfig {
  /** target cadence between chunks (jittered for a human feel) */
  intervalMs: number;
  /** cap on total typing time per request — chunk size scales up to fit */
  budgetMs: number;
}

export interface TypedSplice {
  /** position in the doc as planned (sequential-application coordinates) */
  index: number;
  /** exact text being replaced ("" = pure insertion) */
  delText: string;
  ins: string;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const queues = new Map<string, Promise<unknown>>();

/** Per-doc FIFO: overlapping agent requests run one at a time, each seeing
 * the previous one's settled content. */
export function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  queues.set(
    key,
    next.catch(() => {})
  );
  return next;
}

export async function typeSplices(
  handle: DocHandle<MrkdwnDoc>,
  splices: TypedSplice[],
  changeOpts: { message?: string },
  typing: TypingConfig,
  onCaret?: (index: number) => void
): Promise<void> {
  const totalChars = splices.reduce((n, s) => n + s.ins.length, 0);
  const ticks = Math.max(1, Math.floor(typing.budgetMs / typing.intervalMs));
  const chunkSize = Math.max(1, Math.ceil(totalChars / ticks));

  for (const splice of splices) {
    // Locate the splice in the live doc: planned index first; if a concurrent
    // edit moved/removed the target text, search for it, else skip the splice.
    const content = handle.doc().content;
    let at: number;
    if (splice.delText.length === 0) {
      at = Math.min(splice.index, content.length);
    } else if (content.startsWith(splice.delText, splice.index)) {
      at = splice.index;
    } else {
      at = content.indexOf(splice.delText);
      if (at === -1) continue;
    }

    if (splice.delText.length > 0) {
      handle.change(d => A.splice(d, ["content"], at, splice.delText.length, ""), changeOpts);
      onCaret?.(at);
    }

    let typed = 0;
    let lastChar: string | null = null; // cursor at the last typed char
    while (typed < splice.ins.length) {
      const chunk = splice.ins.slice(typed, typed + chunkSize);
      const doc = handle.doc();
      const pos: number =
        lastChar === null
          ? Math.min(at, doc.content.length)
          : A.getCursorPosition(doc, ["content"], lastChar) + 1;
      handle.change(d => A.splice(d, ["content"], pos, 0, chunk), changeOpts);
      lastChar = A.getCursor(handle.doc(), ["content"], pos + chunk.length - 1);
      typed += chunk.length;
      onCaret?.(pos + chunk.length);
      if (typed < splice.ins.length) await sleep(jitter(typing.intervalMs));
    }
    if (splice !== splices[splices.length - 1]) await sleep(jitter(typing.intervalMs));
  }
}

function jitter(ms: number): number {
  return Math.max(8, Math.round(ms * (0.6 + Math.random() * 0.8)));
}

/** The single contiguous change between two texts (common prefix/suffix
 * trimmed) — how PUT /api/doc full replaces become one typed splice. */
export function singleSpliceDiff(oldText: string, newText: string): TypedSplice | null {
  if (oldText === newText) return null;
  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = Math.min(oldText.length, newText.length) - prefix;
  while (suffix < maxSuffix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix++;
  return {
    index: prefix,
    delText: oldText.slice(prefix, oldText.length - suffix),
    ins: newText.slice(prefix, newText.length - suffix),
  };
}
