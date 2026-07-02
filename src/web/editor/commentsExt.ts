/**
 * Comment range highlights. React resolves comment anchors to positions and
 * dispatches them in via `setCommentRanges`; between dispatches the ranges are
 * mapped through edits so highlights track text while you type.
 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

export interface CommentRange {
  id: string;
  from: number;
  to: number;
  active: boolean;
}

export const setCommentRanges = StateEffect.define<CommentRange[]>();

function build(ranges: CommentRange[], docLen: number): DecorationSet {
  const decos = [];
  for (const r of ranges) {
    const from = Math.max(0, Math.min(r.from, docLen));
    const to = Math.max(0, Math.min(r.to, docLen));
    if (from >= to) continue;
    decos.push(
      Decoration.mark({
        class: r.active ? "cm-commented cm-commented--active" : "cm-commented",
        attributes: { "data-comment-id": r.id },
      }).range(from, to)
    );
  }
  return Decoration.set(decos, true);
}

export function commentsExtension(onSelect: (id: string) => void): Extension {
  const field = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
      deco = deco.map(tr.changes);
      for (const e of tr.effects) if (e.is(setCommentRanges)) deco = build(e.value, tr.newDoc.length);
      return deco;
    },
    provide: f => EditorView.decorations.from(f),
  });

  const click = EditorView.domEventHandlers({
    mousedown(event) {
      const el = (event.target as HTMLElement).closest?.("[data-comment-id]") as HTMLElement | null;
      if (el?.dataset.commentId) onSelect(el.dataset.commentId);
      return false; // don't swallow — caret placement still works
    },
  });

  return [field, click];
}
