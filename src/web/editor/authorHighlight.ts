/**
 * Author spotlight: tint every range a collaborator contributed in their
 * color (clicking their avatar toggles it). Ranges map through edits and are
 * cleared/replaced wholesale via the effect.
 */
import { StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

export interface AuthorSpotlight {
  ranges: { from: number; to: number }[];
  color: string;
}

export const setAuthorSpotlight = StateEffect.define<AuthorSpotlight | null>();

const spotlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setAuthorSpotlight)) continue;
      if (!e.value) return Decoration.none;
      const mark = Decoration.mark({
        class: "cm-author-spotlight",
        attributes: { style: `--spot: ${e.value.color}` },
      });
      const len = tr.state.doc.length;
      const decos: Range<Decoration>[] = [];
      for (const r of e.value.ranges) {
        const from = Math.max(0, Math.min(r.from, len));
        const to = Math.max(from, Math.min(r.to, len));
        if (to > from) decos.push(mark.range(from, to));
      }
      value = Decoration.set(decos, true);
    }
    return value;
  },
  provide: f => EditorView.decorations.from(f),
});

export function authorHighlight(): Extension {
  return spotlightField;
}
