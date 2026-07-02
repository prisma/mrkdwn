/** Pure logic behind the comment-box @mention dropdown: find the token under
 * the caret and rank the candidates. Guards mirror the doc editor's mention
 * autocomplete (mentionsExt.ts) so `@` behaves the same in both places. */
import type { MentionOption } from "../editor/mentionsExt";

export interface MentionToken {
  /** offset of the `@` */
  from: number;
  /** what's typed after the `@`, lowercased for matching as-is */
  query: string;
}

/** The `@word` token ending at the caret, or null when the caret isn't in
 * one (mid-word, emails, code spans — same guard chars as the editor). */
export function activeMentionToken(text: string, caret: number): MentionToken | null {
  const before = text.slice(0, caret);
  const m = /@([\w-]*)$/.exec(before);
  if (!m) return null;
  const from = caret - m[0].length;
  const prev = from > 0 ? before[from - 1]! : "";
  if (/[\w@`]/.test(prev)) return null;
  return { from, query: m[1] ?? "" };
}

const KIND_BOOST = { agent: 0.2, human: 0.1, page: 0 } as const;

/** Rank matches: handle-prefix beats handle-substring beats title match; ties
 * break agents-live-in-this-doc > agent > human > page (arrival order). */
export function filterMentions(options: MentionOption[], query: string, limit = 8): MentionOption[] {
  const q = query.toLowerCase();
  const scored: { o: MentionOption; score: number }[] = [];
  for (const o of options) {
    const handle = o.handle.toLowerCase();
    let score: number;
    if (q === "" || handle.startsWith(q)) score = 4;
    else if (handle.includes(q)) score = 2;
    else if (o.detail.toLowerCase().includes(q)) score = 1;
    else continue;
    scored.push({ o, score: score + KIND_BOOST[o.kind] + (o.live ? 0.2 : 0) });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.o);
}
