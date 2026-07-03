/**
 * Page embeds in markdown: a line that is exactly `![[page-slug]]` renders
 * the referenced page (markdown, canvas, or html) as a live block widget
 * right below it — same pattern as pasted-image previews. The syntax line
 * stays editable; deleting it removes the embed.
 *
 * Rendering happens in React (the embeds subscribe to their page's Automerge
 * doc), so the widget delegates to a mount callback provided by the editor's
 * host component. Also handles sidebar drags: dropping a page from the file
 * list inserts the embed line at the drop point.
 */
import { RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { MountEmbed } from "../components/PageEmbed";

export const EMBED_LINE = /^!\[\[([\w-]+)\]\]\s*$/;

/** dataTransfer type set by the sidebar's draggable page rows */
export const PAGE_DRAG_MIME = "application/x-mrkdwn-page";

class EmbedWidget extends WidgetType {
  private cleanup: (() => void) | null = null;

  constructor(
    readonly slug: string,
    readonly mount: MountEmbed
  ) {
    super();
  }

  override eq(other: EmbedWidget): boolean {
    return other.slug === this.slug;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-page-embed";
    this.cleanup = this.mount(wrap, this.slug);
    return wrap;
  }

  override destroy(): void {
    this.cleanup?.();
    this.cleanup = null;
  }

  override ignoreEvent(): boolean {
    return true; // clicks inside the embed belong to the embed
  }
}

export function pageEmbeds(getMount: () => MountEmbed): Extension {
  const build = (state: EditorState): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>();
    for (let i = 1; i <= state.doc.lines; i++) {
      const line = state.doc.line(i);
      const m = EMBED_LINE.exec(line.text);
      if (m)
        builder.add(
          line.to,
          line.to,
          Decoration.widget({ widget: new EmbedWidget(m[1]!, getMount()), block: true, side: 1 })
        );
    }
    return builder.finish();
  };

  const field = StateField.define<DecorationSet>({
    create: build,
    update(deco, tr) {
      return tr.docChanged ? build(tr.state) : deco.map(tr.changes);
    },
    provide: f => EditorView.decorations.from(f),
  });

  // sidebar drag → embed line on its own line at the drop point
  const dropHandler = EditorView.domEventHandlers({
    drop: (event, view) => {
      const slug = event.dataTransfer?.getData(PAGE_DRAG_MIME);
      if (!slug) return false;
      event.preventDefault();
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      const line = view.state.doc.lineAt(pos);
      const insert = (line.length > 0 ? "\n" : "") + `![[${slug}]]` + "\n";
      view.dispatch({
        changes: { from: line.to, insert },
        selection: { anchor: line.to + insert.length },
      });
      view.focus();
      return true;
    },
    dragover: event => {
      if (event.dataTransfer?.types.includes(PAGE_DRAG_MIME)) {
        event.preventDefault();
        return true;
      }
      return false;
    },
  });

  return [field, dropHandler];
}
