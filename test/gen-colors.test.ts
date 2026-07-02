/**
 * 250 generated cases for the color engine (applyColor): random documents of
 * plain and colored segments, random selections (including sub-ranges of
 * wraps, spans across wraps, and multi-line spans), random ops (set color,
 * set background, clear).
 *
 * The spec is a per-character style model of the *visible* text: after the
 * op, every selected character must carry the requested style and every
 * other character its original style, the visible text must be unchanged,
 * and the result may never contain nested color tags.
 */
import { expect, test } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { applyColor, MD_COLORS, type MdColor } from "../src/web/editor/formatKeys";
import { int, pick, rng, words } from "./genutil";

const TAG_RE = /:(red|orange|yellow|green|blue|violet|gray|grey|rainbow|primary)(-background)?\[([^\]\n]*)\]/g;

interface Style {
  color: string | null;
  bg: boolean;
}

const PLAIN: Style = { color: null, bg: false };

/** Build a random doc; track per-visible-char style + doc offset. */
function buildDoc(r: () => number) {
  let doc = "";
  const styles: Style[] = [];
  const docPos: number[] = [];
  const pushText = (text: string, style: Style) => {
    for (const ch of text) {
      styles.push(style);
      docPos.push(doc.length);
      doc += ch;
    }
  };
  const lines = int(r, 1, 3);
  for (let li = 0; li < lines; li++) {
    if (li) pushText("\n", PLAIN);
    const nseg = int(r, 1, 5);
    for (let s = 0; s < nseg; s++) {
      const color = r() < 0.5 ? pick(r, MD_COLORS) : null;
      const text = (s ? " " : "") + words(r);
      if (color) {
        const bg = r() < 0.4;
        doc += `:${color}${bg ? "-background" : ""}[`;
        pushText(text, { color, bg });
        doc += "]";
      } else {
        pushText(text, PLAIN);
      }
    }
  }
  return { doc, styles, docPos };
}

/** Visible-text projection of a doc: per-char styles + doc offsets. */
function project(doc: string): { plain: string; styles: Style[]; pos: number[] } {
  let plain = "";
  const styles: Style[] = [];
  const pos: number[] = [];
  let i = 0;
  const push = (ch: string, at: number, style: Style) => {
    plain += ch;
    styles.push(style);
    pos.push(at);
  };
  TAG_RE.lastIndex = 0;
  for (let m; (m = TAG_RE.exec(doc)); ) {
    for (let k = i; k < m.index; k++) push(doc[k]!, k, PLAIN);
    const color = m[1] === "grey" ? "gray" : m[1]!;
    const innerStart = m.index + 1 + m[1]!.length + (m[2]?.length ?? 0) + 1;
    for (let k = 0; k < m[3]!.length; k++) push(m[3]![k]!, innerStart + k, { color, bg: !!m[2] });
    i = m.index + m[0].length;
  }
  for (let k = i; k < doc.length; k++) push(doc[k]!, k, PLAIN);
  return { plain, styles, pos };
}

for (let i = 0; i < 250; i++) {
  test(`applyColor generated #${i}`, () => {
    const r = rng(41000 + i);
    const { doc, styles, docPos } = buildDoc(r);
    const before = project(doc);
    const n = styles.length;
    const a = int(r, 0, n - 2);
    const b = int(r, a + 1, n - 1); // selected visible chars: [a, b] inclusive
    const from = docPos[a]!;
    const to = docPos[b]! + 1;
    const color: MdColor | null = r() < 0.25 ? null : pick(r, MD_COLORS);
    const bg = color ? r() < 0.5 : false;

    const state = EditorState.create({ doc, selection: EditorSelection.range(from, to) });
    let after = state;
    applyColor(color, bg)({ state, dispatch: tr => (after = tr.state) });
    const result = project(after.doc.toString());

    // visible text is preserved
    expect(result.plain).toBe(before.plain);
    // no nested/leftover tags or stray brackets survive projection
    TAG_RE.lastIndex = 0;
    expect(TAG_RE.test(result.plain)).toBe(false);
    expect(result.plain).not.toMatch(/[[\]]/);
    // every char carries the expected style
    const expected = styles.map((s, idx) =>
      idx >= a && idx <= b && before.plain[idx] !== "\n" ? { color, bg } : s
    );
    expect(result.styles).toEqual(expected);
    // the resulting selection covers exactly the selected visible chars —
    // it may legitimately cut through (concealed) tag syntax, so compare by
    // visible-char membership rather than by raw slice
    const sel = after.selection.main;
    const inSelection = result.pos.map(p => p >= sel.from && p < sel.to);
    expect(inSelection).toEqual(styles.map((_, idx) => idx >= a && idx <= b));
  });
}
