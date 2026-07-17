/** Exact-match edit planning, shared by the REST edits endpoint and the
 * integrated Kimi agent. Validates and plans against a plain string before
 * anything touches the doc, so a bad edit can never half-apply. */
import { ApiError } from "./errors";

export interface EditOp {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export interface PlannedSplice {
  index: number;
  del: number;
  /** exact text being deleted — lets the typewriter verify/relocate */
  delText: string;
  ins: string;
}

/** Returned splices are ordered for direct sequential application. */
export function planEdits(text: string, edits: EditOp[]): { splices: PlannedSplice[]; finalText: string } {
  const splices: PlannedSplice[] = [];
  edits.forEach((e, i) => {
    if (typeof e?.oldText !== "string" || typeof e?.newText !== "string")
      throw new ApiError(400, `edits[${i}] must be { oldText, newText }`);
    if (e.oldText === "")
      throw new ApiError(400, `edits[${i}].oldText is empty — to add content use POST /api/doc/append`);

    const indices = indicesOf(text, e.oldText);
    if (indices.length === 0)
      throw new ApiError(
        409,
        `edits[${i}]: oldText not found — the doc may have changed; GET /api/doc and retry with the exact current text`
      );
    if (indices.length > 1 && !e.replaceAll)
      throw new ApiError(
        409,
        `edits[${i}]: oldText matches ${indices.length} locations — include more surrounding context, or set "replaceAll": true`
      );

    const targets = e.replaceAll ? [...indices].reverse() : [indices[0]!];
    for (const index of targets) {
      splices.push({ index, del: e.oldText.length, delText: e.oldText, ins: e.newText });
      text = text.slice(0, index) + e.newText + text.slice(index + e.oldText.length);
    }
  });
  return { splices, finalText: text };
}

export function indicesOf(text: string, needle: string): number[] {
  const out: number[] = [];
  let i = 0;
  while ((i = text.indexOf(needle, i)) !== -1) {
    out.push(i);
    i += needle.length;
  }
  return out;
}
