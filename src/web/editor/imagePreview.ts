/**
 * Inline previews for pasted images: a line that is exactly
 * `![alt](/api/images/<id>)` gets the image rendered as a block widget
 * right below it. The syntax line stays editable; deleting it removes
 * the preview. Widget carries no vertical margins (padding only) so
 * CodeMirror's height map stays honest.
 */
import { RangeSetBuilder, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

const IMG_LINE = /^!\[[^\]]*\]\((\/api\/images\/[0-9a-f]{16})\)\s*$/;

class ImageWidget extends WidgetType {
  constructor(readonly url: string) {
    super();
  }
  override eq(other: ImageWidget): boolean {
    return other.url === this.url;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-image-preview";
    const img = document.createElement("img");
    img.src = `${this.url}?w=1200`;
    img.draggable = false;
    img.alt = "";
    wrap.appendChild(img);
    return wrap;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

function build(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i);
    const m = IMG_LINE.exec(line.text);
    if (m) builder.add(line.to, line.to, Decoration.widget({ widget: new ImageWidget(m[1]!), block: true, side: 1 }));
  }
  return builder.finish();
}

export function imagePreview() {
  return StateField.define<DecorationSet>({
    create: build,
    update(deco, tr) {
      return tr.docChanged ? build(tr.state) : deco.map(tr.changes);
    },
    provide: f => EditorView.decorations.from(f),
  });
}
