/**
 * Notion-like structural editing over the concealed block prefixes that
 * livePreview hides:
 *
 *  - the caret is clamped out of a line's prefix onto its content start, so
 *    hidden syntax can never be edited blind
 *  - Backspace at content start demotes a heading one level (## → #, # → text)
 *    and unwraps quotes / list items / tasks to plain text
 *  - typing `#` at a heading's content start promotes it (capped at ######)
 *  - typing `[]` at a line start (bare or behind a list marker) becomes a
 *    to-do checkbox
 *  - Tab / Shift-Tab indent / outdent the line (list items nest) — except
 *    headings, which never indent: at 4 spaces markdown reparses them as an
 *    indented code block. Inside a table the widget navigates cells and
 *    stops the event before this runs, and an open @-autocomplete accepts
 *    on Tab instead
 *
 * All inactive in source mode, where raw syntax is visible and freely edited.
 */
import { acceptCompletion } from "@codemirror/autocomplete";
import { indentLess, indentMore } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { EditorSelection, EditorState, Prec, type Extension, type StateCommand } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
// not re-exported from the package index, but public in its module graph
import { isReconcileTx } from "@automerge/automerge-codemirror/dist/plugin.js";
import { sourceModeField } from "./livePreview";

/** A concealed block prefix at line start (indent + marker + optional task box). */
const PREFIX_RE = /^(?:#{1,6} |(?:> ?)+|\s*(?:[-*+]|\d+[.)]) (?:\[[ xX]\] )?)/;

export function prefixEnd(lineText: string): number {
  const m = PREFIX_RE.exec(lineText);
  return m ? m[0].length : 0;
}

/** Keep carets out of block prefixes — there is no cursor position "before
 * the hidden `## `", exactly like Notion. */
const clampCaret = EditorState.transactionFilter.of(tr => {
  if (!tr.selection || tr.startState.field(sourceModeField) || isReconcileTx(tr)) return tr;
  let changed = false;
  const ranges = tr.newSelection.ranges.map(r => {
    if (!r.empty) return r;
    const line = tr.newDoc.lineAt(r.head);
    const end = prefixEnd(line.text);
    if (!end || r.head - line.from >= end) return r;
    changed = true;
    return EditorSelection.cursor(line.from + end);
  });
  if (!changed) return tr;
  return [tr, { selection: EditorSelection.create(ranges, tr.newSelection.mainIndex), sequential: true }];
});

export const structuralBackspace: StateCommand = ({ state, dispatch }) => {
  if (state.field(sourceModeField)) return false;
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return false;
  const line = state.doc.lineAt(sel.main.head);
  const end = prefixEnd(line.text);
  if (!end || sel.main.head !== line.from + end) return false;
  // headings demote one level; everything else unwraps to plain text
  const to = /^#{2,6} $/.test(line.text.slice(0, end)) ? line.from + 1 : line.from + end;
  dispatch(state.update({ changes: { from: line.from, to }, userEvent: "delete", scrollIntoView: true }));
  return true;
};

/**
 * Tab-indent for the selected lines — except ATX headings, which never
 * indent: at 4 spaces of indentation markdown reparses them as an indented
 * code block. Empty lines are skipped too. Always handles the key (a Tab
 * that indents nothing should not move browser focus). Source mode gets
 * plain raw indentation.
 */
export const structuralIndent: StateCommand = ({ state, dispatch }) => {
  if (state.field(sourceModeField)) return indentMore({ state, dispatch });
  const unit = state.facet(indentUnit);
  const changes: { from: number; insert: string }[] = [];
  const seen = new Set<number>();
  for (const r of state.selection.ranges) {
    for (let pos = r.from; ; ) {
      const line = state.doc.lineAt(pos);
      if (!seen.has(line.from)) {
        seen.add(line.from);
        // {0,3}: a once-indented heading (≤3 spaces) still parses as a heading
        if (line.text && !/^ {0,3}#{1,6} /.test(line.text)) changes.push({ from: line.from, insert: unit });
      }
      if (line.to >= r.to) break;
      pos = line.to + 1;
    }
  }
  if (changes.length) dispatch(state.update({ changes, userEvent: "input.indent", scrollIntoView: true }));
  return true;
};

/**
 * Typing `]` after a lone `[` at line start — optionally behind a list
 * marker — turns the line into a to-do: `[]` → `- [ ] `, like Notion.
 * Returns the replacement for the typed-so-far prefix, or null.
 */
export function taskBracket(state: EditorState, from: number): { from: number; to: number; insert: string } | null {
  const line = state.doc.lineAt(from);
  const m = /^(\s*)([-*+] |\d+[.)] )?\[$/.exec(state.doc.sliceString(line.from, from));
  if (!m) return null;
  return { from: line.from, to: from, insert: `${m[1]}${m[2] ?? "- "}[ ] ` };
}

const bracketTask = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== "]" || from !== to || view.state.field(sourceModeField)) return false;
  const change = taskBracket(view.state, from);
  if (!change) return false;
  view.dispatch({
    changes: change,
    selection: { anchor: change.from + change.insert.length },
    userEvent: "input.type",
  });
  return true;
});

/** Typing `#` at a heading's content start deepens the heading. */
const hashPromote = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== "#" || from !== to) return false;
  const state = view.state;
  if (state.field(sourceModeField)) return false;
  const line = state.doc.lineAt(from);
  const m = /^(#{1,6}) /.exec(line.text);
  if (!m || from !== line.from + m[0].length) return false;
  if (m[1]!.length >= 6) return true; // h6 is the floor — swallow, like Notion
  view.dispatch({ changes: { from: line.from, insert: "#" }, userEvent: "input.type", scrollIntoView: true });
  return true;
});

export function blockEdit(): Extension {
  // highest precedence: must run before lang-markdown's own Backspace binding
  return [
    Prec.highest(
      keymap.of([
        { key: "Backspace", run: structuralBackspace },
        { key: "Tab", run: view => acceptCompletion(view) || structuralIndent(view), shift: indentLess },
      ])
    ),
    bracketTask,
    hashPromote,
    clampCaret,
  ];
}
