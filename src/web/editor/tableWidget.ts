/**
 * GFM tables render as real HTML tables (Notion-style) instead of raw pipe
 * rows. Cells are directly editable: click to edit (cells with inline markup
 * flip to raw source while focused), Enter moves down, Tab/Shift-Tab move
 * across (Tab past the last cell adds a row), Escape reverts. Hovering the
 * table reveals slim `+` strips on the right/bottom edges that add a
 * column/row, like Notion.
 *
 * Commits rewrite the whole table's markdown in one transaction, so table
 * edits sync/merge/undo like any other edit. Widgets are keyed by the
 * table's source text — unrelated edits keep the DOM (and cell focus) alive.
 *
 * Lives in a StateField because block-replace decorations may not come from
 * view plugins. Off in source mode.
 */
import { syntaxTree } from "@codemirror/language";
import { RangeSet, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { get as emojiGet } from "node-emoji";
import { setSourceMode, sourceModeField } from "./livePreview";

type Align = "left" | "center" | "right" | null;

export interface TableData {
  header: string[];
  aligns: Align[];
  rows: string[][];
}

export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map(c => c.trim());
}

export function parseTable(text: string): TableData | null {
  const lines = text.split("\n").filter(l => l.trim());
  if (lines.length < 2) return null;
  const header = splitRow(lines[0]!);
  const aligns: Align[] = splitRow(lines[1]!).map(d =>
    d.startsWith(":") && d.endsWith(":") ? "center" : d.endsWith(":") ? "right" : d.startsWith(":") ? "left" : null
  );
  while (aligns.length < header.length) aligns.push(null);
  const rows = lines.slice(2).map(l => {
    const cells = splitRow(l);
    while (cells.length < header.length) cells.push("");
    return cells.slice(0, header.length);
  });
  return { header, aligns, rows };
}

export function serializeTable(d: TableData): string {
  const row = (cells: string[]) => `| ${cells.map(c => c || "  ").join(" | ")} |`;
  const delim = d.header.map((_, i) => {
    const a = d.aligns[i];
    return a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---";
  });
  return [row(d.header), `| ${delim.join(" | ")} |`, ...d.rows.map(row)].join("\n");
}

// ——— minimal inline-markdown renderer for cell content (reuses the app's
// md-* / color classes so cells match the rest of the document) ———

const INLINE =
  /(?<code>`[^`\n]+`)|(?<bold>\*\*[^*\n]+\*\*)|(?<em>\*[^*\n]+\*)|(?<strike>~~[^~\n]+~~)|(?<link>\[[^\]\n]+\]\([^)\n]+\))|(?<color>:(?:red|orange|yellow|green|blue|violet|gray|grey|rainbow|primary)(?:-background)?\[[^\]\n]*\])|(?<emoji>:[\w+-]+:)/;

function el(tag: string, cls: string, parent: HTMLElement): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent.append(e);
  return e;
}

export function renderInline(text: string, out: HTMLElement): void {
  for (let rest = text; rest; ) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.append(rest);
      return;
    }
    if (m.index > 0) out.append(rest.slice(0, m.index));
    const g = m.groups!;
    const tok = m[0];
    if (g["code"]) el("span", "md-code", out).textContent = tok.slice(1, -1);
    else if (g["bold"]) renderInline(tok.slice(2, -2), el("span", "md-strong", out));
    else if (g["em"]) renderInline(tok.slice(1, -1), el("span", "md-em", out));
    else if (g["strike"]) renderInline(tok.slice(2, -2), el("span", "md-strike", out));
    else if (g["link"]) {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)!;
      const a = el("span", "md-link", out);
      a.title = lm[2]!;
      renderInline(lm[1]!, a);
    } else if (g["color"]) {
      const cm = /^:([a-z]+)(-background)?\[([^\]]*)\]$/.exec(tok)!;
      const c = cm[1] === "grey" ? "gray" : cm[1]!;
      renderInline(cm[3]!, el("span", cm[2] ? `md-colorbg md-colorbg-${c}` : `md-color md-color-${c}`, out));
    } else if (g["emoji"]) out.append(emojiGet(tok) ?? tok);
    rest = rest.slice(m.index + tok.length);
  }
}

// ——— widget ———

function tableNodeAt(state: EditorState, pos: number): SyntaxNode | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent)
    if (n.name === "Table") return n;
  return null;
}

function placeCaretEnd(elm: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(elm);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function focusCellSoon(view: EditorView, tableFrom: number, row: number, col: number): void {
  setTimeout(() => {
    for (const w of view.contentDOM.querySelectorAll<HTMLElement>(".mdt-wrap")) {
      let pos = -1;
      try {
        pos = view.posAtDOM(w);
      } catch {
        continue;
      }
      if (pos !== tableFrom) continue;
      const cell = w.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`);
      if (cell) {
        cell.focus();
        placeCaretEnd(cell);
      }
      return;
    }
  }, 40);
}

/** cell text → single-line markdown-safe cell source */
export function normalizeCell(s: string): string {
  return s.replace(/\r?\n+/g, " ").replace(/(?<!\\)\|/g, "\\|").trim();
}

function buildTable(view: EditorView, source: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "mdt-wrap";
  wrap.contentEditable = "false";
  const data = parseTable(source);
  if (!data) {
    el("div", "mdt-raw", wrap).textContent = source;
    return wrap;
  }

  const cols = () => data.header.length;
  const getRaw = (row: number, col: number) => (row < 0 ? data.header[col] : data.rows[row]?.[col]) ?? "";
  const setRaw = (row: number, col: number, v: string) => {
    if (row < 0) data.header[col] = v;
    else if (data.rows[row]) data.rows[row]![col] = v;
  };

  const renderCell = (cell: HTMLElement) => {
    cell.textContent = "";
    renderInline(getRaw(+cell.dataset["row"]!, +cell.dataset["col"]!), cell);
    delete cell.dataset["editing"];
  };

  /** commit the model; focus lands on [row,col] after the widget rebuilds */
  const commit = (focus?: { row: number; col: number }) => {
    const node = tableNodeAt(view.state, view.posAtDOM(wrap));
    if (!node) return;
    const text = serializeTable(data);
    if (view.state.doc.sliceString(node.from, node.to) !== text)
      view.dispatch({ changes: { from: node.from, to: node.to, insert: text }, userEvent: "input" });
    if (focus) focusCellSoon(view, node.from, focus.row, focus.col);
  };

  const box = el("div", "mdt-box", wrap);
  const table = el("table", "mdt", box);
  const thead = el("thead", "", table);
  const trh = el("tr", "", thead);
  const makeCell = (tag: "th" | "td", row: number, col: number, tr: HTMLElement) => {
    const cell = el(tag, "mdt-cell", tr);
    const a = data.aligns[col];
    if (a) cell.style.textAlign = a;
    cell.dataset["row"] = String(row);
    cell.dataset["col"] = String(col);
    try {
      cell.contentEditable = "plaintext-only";
    } catch {
      cell.contentEditable = "true";
    }
    renderCell(cell);
  };
  data.header.forEach((_, c) => makeCell("th", -1, c, trh));
  const tbody = el("tbody", "", table);
  data.rows.forEach((r, ri) => {
    const tr = el("tr", "", tbody);
    r.forEach((_, c) => makeCell("td", ri, c, tr));
  });

  const addCol = el("button", "mdt-add mdt-add--col", wrap);
  addCol.textContent = "+";
  addCol.title = "Add column";
  addCol.addEventListener("click", () => {
    data.header.push("");
    data.aligns.push(null);
    for (const r of data.rows) r.push("");
    commit({ row: -1, col: cols() - 1 });
  });
  const addRow = el("button", "mdt-add mdt-add--row", wrap);
  addRow.textContent = "+";
  addRow.title = "Add row";
  addRow.addEventListener("click", () => {
    data.rows.push(data.header.map(() => ""));
    commit({ row: data.rows.length - 1, col: 0 });
  });

  const asCell = (t: EventTarget | null) => (t instanceof HTMLElement ? t.closest<HTMLElement>(".mdt-cell") : null);

  /** Enter edit mode: plain cells keep their DOM so the caret lands where
   * you clicked; cells with markup flip to raw source. Idempotent — wired to
   * both focusin and mousedown (focus events don't fire in unfocused tabs). */
  const enterCell = (cell: HTMLElement) => {
    if (cell.dataset["editing"]) return;
    cell.dataset["editing"] = "1";
    const raw = getRaw(+cell.dataset["row"]!, +cell.dataset["col"]!);
    if (cell.textContent !== raw) {
      cell.textContent = raw;
      placeCaretEnd(cell);
    }
  };

  /** Leave edit mode: commit if the raw text changed, else re-render. */
  const leaveCell = (cell: HTMLElement) => {
    if (!cell.dataset["editing"]) return;
    delete cell.dataset["editing"];
    const raw = normalizeCell(cell.textContent ?? "");
    if (raw !== getRaw(+cell.dataset["row"]!, +cell.dataset["col"]!)) {
      setRaw(+cell.dataset["row"]!, +cell.dataset["col"]!, raw);
      commit();
    } else {
      renderCell(cell);
    }
  };

  wrap.addEventListener("focusin", e => {
    const cell = asCell(e.target);
    if (cell) enterCell(cell);
  });
  wrap.addEventListener("mousedown", e => {
    const cell = asCell(e.target);
    if (cell) enterCell(cell);
  });
  wrap.addEventListener("focusout", e => {
    const cell = asCell(e.target);
    if (cell && wrap.isConnected) leaveCell(cell);
  });

  wrap.addEventListener("keydown", e => {
    e.stopPropagation(); // the editor's keymaps must not see cell typing
    const cell = asCell(e.target);
    if (!cell) return;
    const row = +cell.dataset["row"]!;
    const col = +cell.dataset["col"]!;
    const save = () => setRaw(row, col, normalizeCell(cell.textContent ?? ""));
    if (e.key === "Escape") {
      renderCell(cell);
      cell.blur();
    } else if (e.key === "Enter") {
      e.preventDefault();
      save();
      if (row + 1 < data.rows.length) commit({ row: row + 1, col });
      else {
        commit();
        cell.blur();
      }
    } else if (e.key === "Tab") {
      e.preventDefault();
      save();
      const flat = (row + 1) * cols() + col + (e.shiftKey ? -1 : 1); // header row is 0
      if (flat < 0) return commit();
      if (flat >= (data.rows.length + 1) * cols()) {
        data.rows.push(data.header.map(() => "")); // Tab past the end adds a row
        commit({ row: data.rows.length - 1, col: 0 });
      } else {
        commit({ row: Math.floor(flat / cols()) - 1, col: flat % cols() });
      }
    }
  });

  return wrap;
}

class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  override eq(other: TableWidget): boolean {
    return other.source === this.source;
  }
  override ignoreEvent(): boolean {
    return true;
  }
  toDOM(view: EditorView): HTMLElement {
    return buildTable(view, this.source);
  }
}

function computeTables(state: EditorState): DecorationSet {
  if (state.field(sourceModeField)) return Decoration.none;
  const decos: Range<Decoration>[] = [];
  const doc = state.doc;
  syntaxTree(state).iterate({
    enter: n => {
      if (n.name !== "Table") return;
      // block decorations must cover whole lines — skip tables nested inside
      // quotes/lists whose lines carry prefixes
      const firstLine = doc.lineAt(n.from);
      const lastLine = doc.lineAt(n.to);
      if (doc.sliceString(firstLine.from, n.from).trim() || doc.sliceString(n.to, lastLine.to).trim()) return false;
      const source = doc.sliceString(n.from, n.to);
      decos.push(Decoration.replace({ widget: new TableWidget(source), block: true }).range(firstLine.from, lastLine.to));
      return false;
    },
  });
  return Decoration.set(decos, true);
}

const tableField = StateField.define<DecorationSet>({
  create: computeTables,
  update(value, tr) {
    // also recompute when the parse tree advanced without a doc change
    // (fields don't hear about background parsing on their own)
    if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState) || tr.effects.some(e => e.is(setSourceMode)))
      return computeTables(tr.state);
    return value.map(tr.changes);
  },
  provide: f => [
    EditorView.decorations.from(f),
    EditorView.atomicRanges.of(view => view.state.field(f) as RangeSet<Decoration>),
  ],
});

export function tables(): Extension {
  return tableField;
}
