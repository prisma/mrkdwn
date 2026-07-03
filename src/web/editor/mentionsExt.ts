/** Autocomplete: `@` mentions (agents + present humans + pages) and
 * `:emoji:` shortcodes (type `:tad` → 🎉 :tada:). Selecting an emoji inserts
 * the shortcode, which livePreview immediately conceals into the glyph.
 *
 * Picking a page opens a second stage at the same spot — Embed (a live
 * `![[slug]]` block) or Link (the plain `@slug` pill) — navigated exactly
 * like the first list. */
import {
  autocompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { search as emojiSearch } from "node-emoji";

export interface MentionOption {
  handle: string;
  detail: string;
  kind: "agent" | "human" | "page";
  /** agent with live presence in the current document — ranks first */
  live?: boolean;
}

type EmojiCompletion = Completion & { emoji: string };

let emojiOptions: EmojiCompletion[] | null = null;

function allEmoji(): EmojiCompletion[] {
  emojiOptions ??= emojiSearch("").map(e => ({ label: `:${e.name}:`, emoji: e.emoji }));
  return emojiOptions;
}

/** `:tad` → the full emoji catalog; CodeMirror's matcher filters and ranks
 * (prefix matches like :tada: sort above infix ones like :stadium:). */
export function emojiCompletionSource(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/:[\w+-]{2,}/);
  if (!word) return null;
  const charBefore = word.from > 0 ? context.state.doc.sliceString(word.from - 1, word.from) : "";
  if (/[\w:`]/.test(charBefore)) return null; // times (10:30), paths, code
  return { from: word.from, options: allEmoji(), validFor: /^:[\w+-]*$/ };
}

/** Replace the typed `@query` with `![[slug]]` on its own line. */
function insertEmbed(view: EditorView, slug: string, from: number, to: number): void {
  const line = view.state.doc.lineAt(from);
  const before = view.state.doc.sliceString(line.from, from);
  const after = view.state.doc.sliceString(to, line.to);
  const insert = (before.trim() ? "\n" : "") + `![[${slug}]]` + (after.trim() ? "\n" : "");
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
}

export function mentionAutocomplete(getOptions: () => MentionOption[]): Extension {
  /** a page was picked at `from` — stage 2 (Embed | Link) owns that spot */
  let pending: { slug: string; from: number } | null = null;

  const mentionSource = (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/@[\w-]*/);
    if (!word) return null;
    if (pending && pending.from !== word.from) pending = null; // typed elsewhere — stale
    if (pending) return null; // stage 2 renders this position
    const charBefore = word.from > 0 ? context.state.doc.sliceString(word.from - 1, word.from) : "";
    if (/[\w@`]/.test(charBefore)) return null; // mid-word/email/code — not a mention
    const options = getOptions();
    if (options.length === 0) return null;
    return {
      from: word.from,
      options: options.map(o => ({
        label: `@${o.handle}`,
        detail: o.detail,
        type: o.kind === "agent" ? "keyword" : o.kind === "page" ? "type" : "variable",
        apply:
          o.kind === "page"
            ? (view: EditorView, _c: Completion, from: number) => {
                pending = { slug: o.handle, from };
                setTimeout(() => startCompletion(view), 0);
              }
            : `@${o.handle} `,
        boost: o.kind === "agent" ? (o.live ? 2 : 1) : o.kind === "page" ? 0.5 : 0,
      })),
      validFor: /^@[\w-]*$/,
    };
  };

  const pageActionSource = (context: CompletionContext): CompletionResult | null => {
    if (!pending) return null;
    const { slug, from } = pending;
    if (context.pos < from || context.state.doc.sliceString(from, from + 1) !== "@") {
      pending = null;
      return null;
    }
    return {
      from,
      to: context.pos,
      filter: false,
      options: [
        {
          label: "Embed",
          detail: `live ${slug} block`,
          type: "type",
          boost: 1,
          apply: (view: EditorView, _c: Completion, f: number, t: number) => {
            pending = null;
            insertEmbed(view, slug, f, t);
          },
        },
        {
          label: "Link",
          detail: `@${slug}`,
          type: "type",
          apply: (view: EditorView, _c: Completion, f: number, t: number) => {
            pending = null;
            view.dispatch({
              changes: { from: f, to: t, insert: `@${slug} ` },
              selection: { anchor: f + slug.length + 2 },
            });
          },
        },
      ],
    };
  };

  // typing or moving away abandons a pending stage 2
  const invalidatePending = EditorView.updateListener.of(u => {
    if (!pending) return;
    if (u.docChanged) {
      pending = null;
      return;
    }
    if (u.selectionSet) {
      const head = u.state.selection.main.head;
      if (head < pending.from || head > pending.from + 80) pending = null;
    }
  });

  return [
    invalidatePending,
    autocompletion({
      override: [pageActionSource, mentionSource, emojiCompletionSource],
      icons: false,
      activateOnTyping: true,
      addToOptions: [
        {
          // emoji glyph in front of the shortcode, like Notion
          render: (completion: Completion) => {
            const emoji = (completion as EmojiCompletion).emoji;
            if (!emoji) return null;
            const s = document.createElement("span");
            s.className = "cm-emoji-glyph";
            s.textContent = emoji;
            return s;
          },
          position: 20, // before the label (position 50)
        },
      ],
    }),
  ];
}
