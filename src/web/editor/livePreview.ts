/**
 * Notion-style live preview: markdown syntax is always concealed — there is
 * no cursor-reveal. Structure is edited through commands instead (blockEdit.ts
 * for prefixes, the selection toolbar for inline marks) or the raw source
 * mode (`</>` toggle), which turns all concealment off.
 *
 * Conceals: `#`, `>`, list dashes (→ •), task `- `, `**`/`*`/`~~`/backticks,
 * link/image/autolink syntax, `---` (→ rule), emoji shortcodes (`:+1:` → 👍)
 * and streamlit-style color tags (`:red[text]`, `:blue-background[text]`).
 *
 * Concealed ranges are atomic: the caret skips over them as units. All hiding
 * is view-only — document offsets, anchors, and the agent API see raw text.
 */
import { syntaxTree } from "@codemirror/language";
import { RangeSet, StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { get as emojiGet } from "node-emoji";

export const setSourceMode = StateEffect.define<boolean>();

export const sourceModeField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSourceMode)) value = e.value;
    return value;
  },
});

class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const s = document.createElement("span");
    s.className = "md-bullet";
    s.textContent = "•";
    return s;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

class HrWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const s = document.createElement("span");
    s.className = "md-hrwidget";
    return s;
  }
}

/** Fixed-width custom checkbox replacing the `[ ]`/`[x]` chars — toggling
 * re-renders the widget at the same width, so the line never shifts. */
class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("span");
    box.className = "cm-taskbox" + (this.checked ? " cm-taskbox--done" : "");
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(this.checked));
    box.title = this.checked ? "Mark as to-do" : "Mark as done";
    box.addEventListener("mousedown", e => {
      e.preventDefault();
      const pos = view.posAtDOM(box);
      const cur = view.state.doc.sliceString(pos, pos + 3);
      if (!/^\[[ xX]\]$/.test(cur)) return;
      view.dispatch({
        changes: { from: pos, to: pos + 3, insert: cur === "[ ]" ? "[x]" : "[ ]" },
        userEvent: "input",
      });
    });
    return box;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

class EmojiWidget extends WidgetType {
  constructor(readonly char: string) {
    super();
  }
  override eq(other: EmojiWidget): boolean {
    return other.char === this.char;
  }
  toDOM(): HTMLElement {
    const s = document.createElement("span");
    s.className = "md-emoji";
    s.textContent = this.char;
    return s;
  }
}

const bullet = new BulletWidget();
const hr = new HrWidget();

const COLOR_RE = /:(red|orange|yellow|green|blue|violet|gray|grey|rainbow|primary)(-background)?\[([^\]\n]*)\]/g;
// the parser's Emoji node only covers [a-zA-Z_0-9] names — this catches the
// rest of the GitHub set (`:+1:`, `:-1:`, `:e-mail:`, …)
const EMOJI_RE = /:([\w+-]+):/g;

/** [decorations, atomic (hidden) ranges] */
function buildConcealments(view: EditorView): [DecorationSet, RangeSet<Decoration>] {
  const state = view.state;
  if (state.field(sourceModeField)) return [Decoration.none, RangeSet.empty];

  const doc = state.doc;
  const decos: Range<Decoration>[] = [];
  const atoms: Range<Decoration>[] = [];

  const hide = (from: number, to: number) => {
    if (to <= from) return;
    const r = Decoration.replace({}).range(from, to);
    decos.push(r);
    atoms.push(r);
  };
  /** hide the mark plus a single trailing space, if present */
  const hideWithSpace = (from: number, to: number) => {
    hide(from, doc.sliceString(to, to + 1) === " " ? to + 1 : to);
  };
  const replaceWith = (from: number, to: number, widget: WidgetType) => {
    const r = Decoration.replace({ widget }).range(from, to);
    decos.push(r);
    atoms.push(r);
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: node => {
        switch (node.name) {
          case "HeaderMark": // ATX `#`s and Setext underlines
          case "QuoteMark":
            hideWithSpace(node.from, node.to);
            return;
          case "EmphasisMark":
          case "StrikethroughMark":
          case "CodeMark":
            hide(node.from, node.to);
            return;
          case "ListMark": {
            const markText = doc.sliceString(node.from, node.to);
            if (/^\d/.test(markText)) return; // ordered lists keep their numbers
            const isTask = /^\s?\[[ xX]\]/.test(doc.sliceString(node.to, node.to + 5));
            if (isTask) {
              hideWithSpace(node.from, node.to); // checkbox alone, like Notion
            } else {
              replaceWith(node.from, node.to, bullet);
            }
            return;
          }
          case "TaskMarker": {
            const checked = /x/i.test(doc.sliceString(node.from, node.to));
            replaceWith(node.from, node.to, new CheckboxWidget(checked));
            return;
          }
          case "HorizontalRule":
            replaceWith(node.from, node.to, hr);
            return;
          case "Link":
          case "Image":
            concealLink(node.node, hide);
            return;
          case "Autolink": // <https://…> — drop the angle brackets
            for (const mark of node.node.getChildren("LinkMark")) hide(mark.from, mark.to);
            return;
          case "Emoji": {
            const char = emojiGet(doc.sliceString(node.from, node.to));
            if (char) replaceWith(node.from, node.to, new EmojiWidget(char));
            return;
          }
        }
      },
    });

    // streamlit-style :color[…] / :color-background[…] (not markdown — regex pass)
    const text = doc.sliceString(from, to);
    COLOR_RE.lastIndex = 0;
    for (let m; (m = COLOR_RE.exec(text)); ) {
      const start = from + m.index;
      if (/Code/.test(syntaxTree(state).resolveInner(start, 1).name)) continue;
      const color = m[1] === "grey" ? "gray" : m[1]!;
      const openEnd = start + 1 + m[1]!.length + (m[2]?.length ?? 0) + 1; // `:color[` or `:color-background[`
      const end = start + m[0].length;
      hide(start, openEnd);
      if (end - 1 > openEnd) {
        const cls = m[2] ? `md-colorbg md-colorbg-${color}` : `md-color md-color-${color}`;
        decos.push(Decoration.mark({ class: cls }).range(openEnd, end - 1));
      }
      hide(end - 1, end);
    }

    EMOJI_RE.lastIndex = 0;
    for (let m; (m = EMOJI_RE.exec(text)); ) {
      const start = from + m.index;
      const nodeName = syntaxTree(state).resolveInner(start + 1, 1).name;
      if (nodeName === "Emoji" || /Code/.test(nodeName)) continue; // parsed above / inside code
      const char = emojiGet(m[0]);
      if (char) replaceWith(start, start + m[0].length, new EmojiWidget(char));
    }
  }

  return [Decoration.set(decos, true), RangeSet.of(atoms, true)];
}

/** `[text](url)` / `![alt](url)` → show only text/alt. */
function concealLink(link: SyntaxNode, hide: (from: number, to: number) => void): void {
  const marks = link.getChildren("LinkMark");
  // expect at least the opening `[`/`![` and closing `]`; reference-style
  // links without a URL part are left alone
  if (marks.length < 2) return;
  hide(marks[0]!.from, marks[0]!.to);
  hide(marks[1]!.from, link.to);
}

/** Find the URL of the Link/Autolink containing pos, if any. */
function linkUrlAt(state: EditorState, pos: number): string | null {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === "Link" || node.name === "Image" || node.name === "Autolink") {
      const url = node.getChild("URL");
      if (url) return state.doc.sliceString(url.from, url.to);
      return null;
    }
    if (node.name === "URL") return state.doc.sliceString(node.from, node.to); // bare GFM autolink
  }
  return null;
}

export function livePreview(): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      atoms: RangeSet<Decoration>;

      constructor(view: EditorView) {
        [this.decorations, this.atoms] = buildConcealments(view);
      }

      update(u: ViewUpdate): void {
        const modeFlipped = u.startState.field(sourceModeField) !== u.state.field(sourceModeField);
        if (u.docChanged || u.viewportChanged || modeFlipped)
          [this.decorations, this.atoms] = buildConcealments(u.view);
      }
    },
    {
      decorations: v => v.decorations,
      provide: p => EditorView.atomicRanges.of(view => view.plugin(p)?.atoms ?? RangeSet.empty),
    }
  );

  const openLinks = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!(event.metaKey || event.ctrlKey)) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const url = linkUrlAt(view.state, pos);
      if (!url) return false;
      window.open(/^[a-z][\w+.-]*:/i.test(url) ? url : `https://${url}`, "_blank", "noopener");
      event.preventDefault();
      return true;
    },
  });

  return [sourceModeField, plugin, openLinks];
}
