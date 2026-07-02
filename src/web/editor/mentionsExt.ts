/** Autocomplete: `@` mentions (agents + present humans) and `:emoji:`
 * shortcodes (type `:tad` → 🎉 :tada:). Selecting an emoji inserts the
 * shortcode, which livePreview immediately conceals into the glyph. */
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
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

export function mentionAutocomplete(getOptions: () => MentionOption[]): Extension {
  const mentionSource = (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/@[\w-]*/);
    if (!word) return null;
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
        apply: `@${o.handle} `,
        boost: o.kind === "agent" ? (o.live ? 2 : 1) : o.kind === "page" ? 0.5 : 0,
      })),
      validFor: /^@[\w-]*$/,
    };
  };

  return autocompletion({
    override: [mentionSource, emojiCompletionSource],
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
  });
}
