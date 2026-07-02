/**
 * Live markdown niceties on top of syntax highlighting:
 *  - fenced code blocks get a full-width tinted background
 *  - done task lines are dimmed (the checkbox itself is a livePreview widget)
 *  - source-mode tables render in aligned mono
 *  - @mentions render as pills; @page-slug mentions link to that page (click
 *    to navigate)
 */
import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, StateEffect, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { scanMentions } from "../../shared/mentions";

/** Dispatched when the pages/agents registries change, so existing mentions
 * re-classify (e.g. a just-created page's link turns into a pill). */
export const refreshMentions = StateEffect.define<null>();

export interface MentionSources {
  agentHandles(): Set<string>;
  /** page slug → page id */
  pageLinks(): Map<string, string>;
  onOpenPage(slug: string): void;
}

function buildDecorations(view: EditorView, sources: MentionSources): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const doc = view.state.doc;
  const agents = sources.agentHandles();
  const pages = sources.pageLinks();

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: node => {
        if (node.name === "FencedCode") {
          const first = doc.lineAt(node.from).number;
          const last = doc.lineAt(node.to).number;
          for (let n = first; n <= last; n++) {
            const line = doc.line(n);
            let cls = "cm-codeblock";
            if (n === first) cls += " cm-codeblock--first";
            if (n === last) cls += " cm-codeblock--last";
            ranges.push(Decoration.line({ class: cls }).range(line.from));
          }
        } else if (node.name === "TaskMarker") {
          const done = /x/i.test(doc.sliceString(node.from, node.to));
          if (done) ranges.push(Decoration.line({ class: "cm-line--done" }).range(doc.lineAt(node.from).from));
        } else if (node.name === "Table") {
          // mono keeps the pipes column-aligned; header row is the first line
          const first = doc.lineAt(node.from).number;
          const last = doc.lineAt(node.to).number;
          for (let n = first; n <= last; n++) {
            const cls = n === first ? "cm-tableline cm-tableline--head" : "cm-tableline";
            ranges.push(Decoration.line({ class: cls }).range(doc.line(n).from));
          }
        } else if (node.name === "Blockquote") {
          const first = doc.lineAt(node.from).number;
          const last = doc.lineAt(node.to).number;
          for (let n = first; n <= last; n++)
            ranges.push(Decoration.line({ class: "cm-quoteline" }).range(doc.line(n).from));
        }
      },
    });

    const text = doc.sliceString(from, to);
    for (const m of scanMentions(text)) {
      const cls = agents.has(m.handle)
        ? "cm-mention cm-mention--agent"
        : pages.has(m.handle)
          ? "cm-mention cm-mention--page"
          : "cm-mention";
      ranges.push(Decoration.mark({ class: cls }).range(from + m.index, from + m.end));
    }
  }
  return Decoration.set(ranges, true);
}

export function markdownDecorations(sources: MentionSources): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, sources);
      }

      update(u: ViewUpdate): void {
        const bumped = u.transactions.some(t => t.effects.some(e => e.is(refreshMentions)));
        if (u.docChanged || u.viewportChanged || bumped) this.decorations = buildDecorations(u.view, sources);
      }
    },
    { decorations: v => v.decorations }
  );

  // clicking a page link navigates (like Notion's inline page mentions)
  const openPageLinks = EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target as HTMLElement;
      if (!target.closest?.(".cm-mention--page")) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const line = view.state.doc.lineAt(pos);
      for (const m of scanMentions(line.text)) {
        if (line.from + m.index <= pos && pos <= line.from + m.end && sources.pageLinks().has(m.handle)) {
          event.preventDefault();
          sources.onOpenPage(m.handle);
          return true;
        }
      }
      return false;
    },
  });

  return [plugin, openPageLinks];
}
