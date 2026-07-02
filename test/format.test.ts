import { expect, test } from "bun:test";
import { EditorState, EditorSelection, type StateCommand, type Transaction } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  activeFormats,
  insertLink,
  toggleBold,
  toggleCode,
  toggleItalic,
  toggleStrike,
} from "../src/web/editor/formatKeys";

function state(doc: string, from: number, to = from): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(from, to),
    extensions: [markdown({ base: markdownLanguage })],
  });
}

function run(cmd: StateCommand, s: EditorState): EditorState {
  let out = s;
  cmd({
    state: s,
    dispatch: (tr: Transaction) => {
      out = tr.state;
    },
  });
  return out;
}

test("bold wraps a selection and places it inside the markers", () => {
  const s = run(toggleBold, state("hello world", 0, 5));
  expect(s.doc.toString()).toBe("**hello** world");
  expect([s.selection.main.from, s.selection.main.to]).toEqual([2, 7]);
});

test("bold unwraps when the selection sits inside existing markers", () => {
  const s = run(toggleBold, state("**hello** world", 2, 7));
  expect(s.doc.toString()).toBe("hello world");
});

test("bold unwraps when the selection includes the markers", () => {
  const s = run(toggleBold, state("**hello** world", 0, 9));
  expect(s.doc.toString()).toBe("hello world");
});

test("italic, strike and code wrap with their own markers", () => {
  expect(run(toggleItalic, state("abc", 0, 3)).doc.toString()).toBe("*abc*");
  expect(run(toggleStrike, state("abc", 0, 3)).doc.toString()).toBe("~~abc~~");
  expect(run(toggleCode, state("abc", 0, 3)).doc.toString()).toBe("`abc`");
});

test("link inserts a template and selects the url placeholder", () => {
  const s = run(insertLink, state("see docs now", 4, 8));
  expect(s.doc.toString()).toBe("see [docs](url) now");
  const sel = s.selection.main;
  expect(s.doc.sliceString(sel.from, sel.to)).toBe("url");
});

test("collapsed cursor bold inserts an empty pair to type into", () => {
  const s = run(toggleBold, state("ab", 1));
  expect(s.doc.toString()).toBe("a****b");
  expect(s.selection.main.from).toBe(3);
});

test("activeFormats reads the syntax tree at the selection", () => {
  const bold = state("some **bold** text", 7, 11);
  expect(activeFormats(bold, 7, 11).has("bold")).toBe(true);
  expect(activeFormats(bold, 7, 11).has("italic")).toBe(false);

  const nested = state("***both***", 3, 7);
  const active = activeFormats(nested, 3, 7);
  expect(active.has("bold")).toBe(true);
  expect(active.has("italic")).toBe(true);

  const code = state("x `y` z", 3, 4);
  expect(activeFormats(code, 3, 4).has("code")).toBe(true);

  const link = state("[text](http://a.b)", 2, 4);
  expect(activeFormats(link, 2, 4).has("link")).toBe(true);

  expect(activeFormats(state("plain", 1, 3), 1, 3).size).toBe(0);
});
