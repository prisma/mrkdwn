/**
 * Formatting commands, shared by the keymap and the selection toolbar.
 * StateCommands (not view commands) so they're unit-testable headless.
 */
import { EditorSelection, type EditorState, type StateCommand } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { KeyBinding } from "@codemirror/view";

export type FormatAction = "bold" | "italic" | "strike" | "code" | "link";

function toggleWrapCommand(left: string, right = left): StateCommand {
  return ({ state, dispatch }) => {
    const changes = state.changeByRange(range => {
      const { from, to } = range;
      const before = state.doc.sliceString(Math.max(0, from - left.length), from);
      const after = state.doc.sliceString(to, to + right.length);
      const inner = state.doc.sliceString(from, to);

      // already wrapped (just outside, or included in the selection) → unwrap
      if (before === left && after === right) {
        return {
          changes: [
            { from: from - left.length, to: from },
            { from: to, to: to + right.length },
          ],
          range: EditorSelection.range(from - left.length, to - left.length),
        };
      }
      if (inner.startsWith(left) && inner.endsWith(right) && inner.length >= left.length + right.length) {
        return {
          changes: [
            { from, to: from + left.length },
            { from: to - right.length, to },
          ],
          range: EditorSelection.range(from, to - left.length - right.length),
        };
      }
      return {
        changes: [
          { from, insert: left },
          { from: to, insert: right },
        ],
        range: EditorSelection.range(from + left.length, to + left.length),
      };
    });
    dispatch(state.update(changes, { userEvent: "input", scrollIntoView: true }));
    return true;
  };
}

export const toggleBold = toggleWrapCommand("**");
export const toggleItalic = toggleWrapCommand("*");
export const toggleCode = toggleWrapCommand("`");
export const toggleStrike = toggleWrapCommand("~~");

export const insertLink: StateCommand = ({ state, dispatch }) => {
  const changes = state.changeByRange(range => {
    const text = state.doc.sliceString(range.from, range.to) || "link text";
    const insert = `[${text}](url)`;
    const urlStart = range.from + text.length + 3;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(urlStart, urlStart + 3),
    };
  });
  dispatch(state.update(changes, { userEvent: "input", scrollIntoView: true }));
  return true;
};

/** Streamlit-style color palette (grey normalizes to gray on write). */
export const MD_COLORS = ["red", "orange", "yellow", "green", "blue", "violet", "gray", "primary", "rainbow"] as const;
export type MdColor = (typeof MD_COLORS)[number];

const COLOR_TAG = "(red|orange|yellow|green|blue|violet|gray|grey|rainbow|primary)";
const LINE_TAGS = new RegExp(`:${COLOR_TAG}(-background)?\\[([^\\]\\n]*)\\]`, "g");

interface TagMatch {
  start: number;
  end: number;
  innerStart: number;
  innerEnd: number;
  color: string;
  bg: boolean;
}

function lineTags(text: string): TagMatch[] {
  const out: TagMatch[] = [];
  LINE_TAGS.lastIndex = 0;
  for (let m; (m = LINE_TAGS.exec(text)); ) {
    const openLen = 1 + m[1]!.length + (m[2]?.length ?? 0) + 1;
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      innerStart: m.index + openLen,
      innerEnd: m.index + m[0].length - 1,
      color: m[1] === "grey" ? "gray" : m[1]!,
      bg: !!m[2],
    });
  }
  return out;
}

interface RecolorResult {
  from: number;
  to: number;
  insert: string;
  /** selection (the recolored text) within `insert` */
  selStart: number;
  selEnd: number;
}

/**
 * Recolor [la, lb] (line-local) in a single line. Existing wraps overlapping
 * the range are decomposed into styled runs, the selected span restyled, and
 * everything re-serialized — so color tags never nest, and coloring part of
 * an already-colored span splits the outer wrap around it (like Notion).
 */
function recolorLine(text: string, la: number, lb: number, color: MdColor | null, bg: boolean): RecolorResult | null {
  const tags = lineTags(text);
  // endpoints belong in visible text — snap out of tag syntax
  const snap = (p: number) => {
    for (const t of tags) {
      if (p > t.start && p < t.innerStart) return t.innerStart;
      if (p > t.innerEnd && p < t.end) return t.innerEnd;
    }
    return p;
  };
  la = snap(la);
  lb = snap(lb);
  if (la >= lb) return null;

  const overlapping = tags.filter(t => t.start < lb && t.end > la);
  const winFrom = Math.min(la, ...overlapping.map(t => t.start));
  const winTo = Math.max(lb, ...overlapping.map(t => t.end));

  // decompose the window into styled pieces of visible text, splitting at
  // the selection edges; selected pieces take the new style
  interface Piece {
    text: string;
    color: string | null;
    bg: boolean;
    sel: boolean;
  }
  const pieces: Piece[] = [];
  const pushPieces = (a: number, b: number, oldColor: string | null, oldBg: boolean) => {
    const i1 = Math.min(Math.max(la, a), b);
    const i2 = Math.min(Math.max(lb, a), b);
    for (const [s, e, sel] of [
      [a, i1, false],
      [i1, i2, true],
      [i2, b, false],
    ] as const) {
      if (e > s)
        pieces.push({ text: text.slice(s, e), color: sel ? color : oldColor, bg: sel ? bg && !!color : oldBg, sel });
    }
  };
  let w = winFrom;
  for (const t of overlapping) {
    pushPieces(w, t.start, null, false);
    pushPieces(t.innerStart, t.innerEnd, t.color, t.bg);
    w = t.end;
  }
  pushPieces(w, winTo, null, false);

  // merge adjacent pieces with the same style, then serialize
  const runs: { color: string | null; bg: boolean; parts: { text: string; sel: boolean }[] }[] = [];
  for (const p of pieces) {
    const last = runs[runs.length - 1];
    if (last && last.color === p.color && last.bg === p.bg) last.parts.push(p);
    else runs.push({ color: p.color, bg: p.bg, parts: [p] });
  }
  let insert = "";
  let selStart = -1;
  let selEnd = -1;
  for (const r of runs) {
    if (r.color) insert += `:${r.color}${r.bg ? "-background" : ""}[`;
    for (const part of r.parts) {
      if (part.sel && selStart < 0) selStart = insert.length;
      insert += part.text;
      if (part.sel) selEnd = insert.length;
    }
    if (r.color) insert += "]";
  }
  if (selStart < 0) return null;
  return { from: winFrom, to: winTo, insert, selStart, selEnd };
}

/**
 * Apply `:color[…]` / `:color-background[…]` to the selection; `null` clears.
 * Works per line (tags can't span lines) and rebuilds any wraps it touches.
 */
export function applyColor(color: MdColor | null, background: boolean): StateCommand {
  return ({ state, dispatch }) => {
    const specs: (RecolorResult & { abs: number })[] = [];
    const seenLines = new Set<number>();
    for (const range of state.selection.ranges) {
      if (range.empty) continue;
      for (let pos = range.from; pos <= range.to; ) {
        const line = state.doc.lineAt(pos);
        if (!seenLines.has(line.number)) {
          seenLines.add(line.number);
          const a = Math.max(range.from, line.from) - line.from;
          const b = Math.min(range.to, line.to) - line.from;
          const r = recolorLine(line.text, a, b, color, background);
          if (r) specs.push({ ...r, abs: line.from });
        }
        if (line.to >= range.to) break;
        pos = line.to + 1;
      }
    }
    if (!specs.length) return false;
    const changes = specs.map(s => ({ from: s.abs + s.from, to: s.abs + s.to, insert: s.insert }));
    const changeSet = state.changes(changes);
    const first = specs[0]!;
    const last = specs[specs.length - 1]!;
    let selFrom = changeSet.mapPos(first.abs + first.from, -1) + first.selStart;
    let selTo = changeSet.mapPos(last.abs + last.from, -1) + last.selEnd;
    // selection edges on lines that needed no rewrite (blank lines, bare
    // newlines) sit outside every window — keep them selected too
    const rangeFrom = Math.min(...state.selection.ranges.filter(r => !r.empty).map(r => r.from));
    const rangeTo = Math.max(...state.selection.ranges.filter(r => !r.empty).map(r => r.to));
    if (rangeFrom < first.abs + first.from) selFrom = Math.min(selFrom, changeSet.mapPos(rangeFrom, 1));
    if (rangeTo > last.abs + last.to) selTo = Math.max(selTo, changeSet.mapPos(rangeTo, -1));
    dispatch(
      state.update({
        changes,
        selection: EditorSelection.range(selFrom, selTo),
        userEvent: "input",
        scrollIntoView: true,
      })
    );
    return true;
  };
}

export const formatCommands: Record<FormatAction, StateCommand> = {
  bold: toggleBold,
  italic: toggleItalic,
  strike: toggleStrike,
  code: toggleCode,
  link: insertLink,
};

/** Which formats wrap the selection — drives toolbar active states. Resolved
 * from the syntax tree at the selection midpoint, so it's exact. */
export function activeFormats(state: EditorState, from: number, to: number): Set<FormatAction> {
  const active = new Set<FormatAction>();
  const mid = Math.min(Math.floor((from + to) / 2), state.doc.length);
  // the tree may not cover a just-applied edit yet — parse ahead briefly
  const tree = ensureSyntaxTree(state, Math.min(to + 1, state.doc.length), 20) ?? syntaxTree(state);
  for (let node = tree.resolveInner(mid, 1); node; node = node.parent!) {
    switch (node.name) {
      case "StrongEmphasis":
        active.add("bold");
        break;
      case "Emphasis":
        active.add("italic");
        break;
      case "Strikethrough":
        active.add("strike");
        break;
      case "InlineCode":
        active.add("code");
        break;
      case "Link":
      case "Autolink":
        active.add("link");
        break;
    }
    if (!node.parent) break;
  }
  return active;
}

export const formatKeymap: KeyBinding[] = [
  { key: "Mod-b", run: toggleBold },
  { key: "Mod-i", run: toggleItalic },
  { key: "Mod-e", run: toggleCode },
  { key: "Mod-Shift-x", run: toggleStrike },
  { key: "Mod-k", run: insertLink },
];
