/** Mention parsing shared by server (notifications) and client (highlighting). */

export interface Mention {
  handle: string;
  /** offset of the `@` in the scanned text */
  index: number;
  /** offset just past the last handle character */
  end: number;
}

/** `@handle` — must start a word (not preceded by a word char, `@`, or backtick). */
const MENTION_RE = /(^|[^\w@`])@([a-zA-Z][a-zA-Z0-9_-]{0,31})/g;

export function scanMentions(text: string): Mention[] {
  const out: Mention[] = [];
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(text)) !== null) {
    const lead = m[1] ?? "";
    const handle = m[2]!;
    const index = m.index + lead.length;
    out.push({ handle: handle.toLowerCase(), index, end: index + 1 + handle.length });
  }
  return out;
}

/** A short excerpt around a mention, single line, trimmed. */
export function mentionSnippet(text: string, index: number, span = 120): string {
  const lineStart = text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  let lineEnd = text.indexOf("\n", index);
  if (lineEnd === -1) lineEnd = text.length;
  let line = text.slice(lineStart, lineEnd).trim();
  if (line.length > span) {
    const at = index - lineStart;
    const from = Math.max(0, at - span / 2);
    line = (from > 0 ? "…" : "") + line.slice(from, from + span) + (from + span < line.length ? "…" : "");
  }
  return line;
}
