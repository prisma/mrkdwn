/**
 * 250 generated cases for structural line editing: caret clamping out of
 * concealed prefixes, Backspace demote/unwrap at content start, and
 * Tab/Shift-Tab indentation — over random docs and random block prefixes.
 */
import { expect, test } from "bun:test";
import { indentLess } from "@codemirror/commands";
import { EditorSelection, EditorState, type StateCommand } from "@codemirror/state";
import { blockEdit, prefixEnd, structuralBackspace, structuralIndent, taskBracket } from "../src/web/editor/blockEdit";
import { setSourceMode, sourceModeField } from "../src/web/editor/livePreview";
import { int, pick, rng, words } from "./genutil";

const PREFIXES = [
  "# ", "## ", "### ", "#### ", "##### ", "###### ",
  "> ", "> > ",
  "- ", "* ", "+ ", "  - ", "    - ",
  "1. ", "12) ", "  3. ",
  "- [ ] ", "- [x] ", "2. [ ] ",
] as const;

function makeDoc(r: () => number, prefix: string) {
  const before = Array.from({ length: int(r, 0, 3) }, () => words(r));
  const after = Array.from({ length: int(r, 0, 3) }, () => words(r));
  const content = words(r);
  const target = prefix + content;
  const lines = [...before, target, ...after];
  const lineStart = before.join("\n").length + (before.length ? 1 : 0);
  return { doc: lines.join("\n"), lineStart, target, content };
}

function run(state: EditorState, cmd: StateCommand): { state: EditorState; handled: boolean } {
  let out = state;
  const handled = cmd({ state, dispatch: tr => (out = tr.state) });
  return { state: out, handled };
}

// ——— `[]` becomes a to-do checkbox ———

test("[] at line start converts to a task", () => {
  // caret sits after the `[` the user already typed; they now type `]`
  const cases: [doc: string, from: number, insert: string | null][] = [
    ["[", 1, "- [ ] "], // bare
    ["  [", 3, "  - [ ] "], // indented
    ["- [", 3, "- [ ] "], // behind a bullet
    ["* [", 3, "* [ ] "], // keeps the marker flavor
    ["1. [", 4, "1. [ ] "], // ordered task
    ["text [", 6, null], // mid-line stays literal
    ["a[", 2, null],
  ];
  for (const [doc, from, insert] of cases) {
    const change = taskBracket(EditorState.create({ doc }), from);
    if (insert === null) expect(change).toBeNull();
    else expect(change).toEqual({ from: 0, to: from, insert });
  }
});

test("[] conversion works on a line mid-document", () => {
  const doc = "para one\n[\npara two";
  const change = taskBracket(EditorState.create({ doc }), 10);
  expect(change).toEqual({ from: 9, to: 10, insert: "- [ ] " });
});

// ——— explicit regressions: headings never indent (at 4 spaces markdown
// would reparse them as an indented code block) ———

test("Tab never indents a heading — twice would turn it into a code block", () => {
  const doc = "## Docs at [runbook](https://x.test)";
  let state = EditorState.create({ doc, selection: EditorSelection.cursor(3), extensions: [sourceModeField] });
  for (let n = 0; n < 2; n++) {
    const { state: after, handled } = run(state, structuralIndent);
    expect(handled).toBe(true); // swallowed — Tab must not escape the editor
    expect(after.doc.toString()).toBe(doc);
    state = after;
  }
});

test("an already-indented heading (≤3 spaces still parses) is not pushed to 4", () => {
  const doc = "  ## Steps";
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(5), extensions: [sourceModeField] });
  expect(run(state, structuralIndent).state.doc.toString()).toBe(doc);
});

test("multi-line Tab indents around headings, not them", () => {
  const doc = "alpha\n## head\n- item";
  const state = EditorState.create({ doc, selection: EditorSelection.range(0, doc.length), extensions: [sourceModeField] });
  expect(run(state, structuralIndent).state.doc.toString()).toBe("  alpha\n## head\n  - item");
});

test("source mode keeps raw indentation, headings included", () => {
  const base = EditorState.create({ doc: "## raw", selection: EditorSelection.cursor(3), extensions: [sourceModeField] });
  const srcOn = base.update({ effects: setSourceMode.of(true) }).state;
  expect(run(srcOn, structuralIndent).state.doc.toString()).toBe("  ## raw");
});

for (let i = 0; i < 250; i++) {
  test(`block editing generated #${i}`, () => {
    const r = rng(72000 + i);
    const prefix = pick(r, PREFIXES);
    const { doc, lineStart, target, content } = makeDoc(r, prefix);
    const end = prefixEnd(target);

    // the prefix regex must claim exactly the constructed prefix
    expect(end).toBe(prefix.length);

    const kind = i % 4;
    if (kind === 0) {
      // caret clamp: any caret position inside the prefix snaps to content start
      const state = EditorState.create({ doc, extensions: [sourceModeField, blockEdit()] });
      const inside = int(r, 0, prefix.length - 1);
      const clamped = state.update({ selection: EditorSelection.cursor(lineStart + inside) });
      expect(clamped.state.selection.main.head).toBe(lineStart + prefix.length);
      // positions at/after content start are untouched
      const at = lineStart + prefix.length + int(r, 0, content.length);
      const kept = state.update({ selection: EditorSelection.cursor(at) });
      expect(kept.state.selection.main.head).toBe(at);
    } else if (kind === 1) {
      // Backspace at content start: headings demote one level, others unwrap
      const state = EditorState.create({
        doc,
        selection: EditorSelection.cursor(lineStart + prefix.length),
        extensions: [sourceModeField],
      });
      const { state: after, handled } = run(state, structuralBackspace);
      expect(handled).toBe(true);
      const newLine = after.doc.lineAt(lineStart).text;
      const heading = /^(#{2,6}) $/.exec(prefix);
      expect(newLine).toBe(heading ? prefix.slice(1) + content : content);
      // Backspace mid-content is NOT structural (falls through to default)
      const mid = EditorState.create({
        doc,
        selection: EditorSelection.cursor(lineStart + prefix.length + 1 + int(r, 0, content.length - 2)),
        extensions: [sourceModeField],
      });
      expect(run(mid, structuralBackspace).handled).toBe(false);
    } else if (kind === 2) {
      // Tab indents the line by one unit (headings refuse); Shift-Tab restores
      const caret = lineStart + prefix.length + int(r, 0, content.length);
      const state = EditorState.create({ doc, selection: EditorSelection.cursor(caret), extensions: [sourceModeField] });
      const isHeading = /^#{1,6} $/.test(prefix);
      const { state: indented, handled } = run(state, structuralIndent);
      expect(handled).toBe(true);
      expect(indented.doc.lineAt(lineStart).text).toBe(isHeading ? target : "  " + target);
      if (isHeading) {
        // pressing Tab again still changes nothing — never a code block
        expect(run(indented, structuralIndent).state.doc.toString()).toBe(doc);
      } else {
        expect(run(indented, indentLess).state.doc.toString()).toBe(doc);
      }
    } else {
      // multi-line selection: indent shifts every covered line except
      // headings and blanks; dedent reverts
      const state = EditorState.create({
        doc,
        selection: EditorSelection.range(0, doc.length),
        extensions: [sourceModeField],
      });
      const indented = run(state, structuralIndent).state;
      for (let ln = 1; ln <= indented.doc.lines; ln++) {
        const orig = state.doc.line(ln).text;
        const keep = !orig || /^ {0,3}#{1,6} /.test(orig);
        expect(indented.doc.line(ln).text).toBe(keep ? orig : "  " + orig);
      }
      const restored = run(indented, indentLess).state;
      expect(restored.doc.toString()).toBe(doc);
    }
  });
}
