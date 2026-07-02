/**
 * Notion-style block affordances in the left margin: hovering a block (or the
 * margin next to it) shows a `+` (insert a block of a chosen type below it)
 * and a `⋮⋮` drag handle. Typing `/` on an empty line (or empty list/quote
 * prefix) opens the same type menu in convert mode — picking a type replaces
 * the line. Dragging floats a semi-transparent ghost of the
 * block under the pointer, dims the original, and snaps a drop indicator to
 * the nearest valid gap; on drop the ghost flies to the gap and the block
 * flashes at its new home.
 *
 * A "block" is a top-level markdown node — except inside lists, where it's
 * the hovered list item (including its nested children). Drop targets are
 * precomputed block/item boundaries, so the indicator moves monotonically
 * instead of re-deriving a block under the pointer every move.
 *
 * Plain-DOM overlay owned by a ViewPlugin; moves and inserts are ordinary
 * transactions, so they sync, merge, and undo like any other edit.
 */
import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { prefixEnd } from "./blockEdit";
import { sourceModeField } from "./livePreview";

interface BlockRange {
  from: number;
  to: number;
}

interface BlockType {
  label: string;
  hint: string;
  text: string;
  /** caret lands this many chars back from the end of the inserted text */
  caretBack?: number;
  /** needs a blank line above (`---` after a paragraph would parse as setext) */
  blankBefore?: boolean;
  /** creates a new top-level page and inserts an `@slug` link to it */
  page?: boolean;
}

const BLOCK_TYPES: BlockType[] = [
  { label: "Text", hint: "", text: "" },
  { label: "Heading 1", hint: "#", text: "# " },
  { label: "Heading 2", hint: "##", text: "## " },
  { label: "Heading 3", hint: "###", text: "### " },
  { label: "Bulleted list", hint: "-", text: "- " },
  { label: "Numbered list", hint: "1.", text: "1. " },
  { label: "To-do", hint: "[ ]", text: "- [ ] " },
  { label: "Quote", hint: ">", text: "> " },
  { label: "Code", hint: "```", text: "```\n\n```", caretBack: 4 },
  { label: "Table", hint: "| |", text: "| Column | Column |\n| --- | --- |\n|  |  |", caretBack: 5 },
  { label: "Divider", hint: "---", text: "---", blankBefore: true },
  { label: "Page", hint: "@", text: "", page: true },
];

export interface BlockHandlesConfig {
  /** create a top-level page; resolves its slug for the inserted link */
  createPage?: () => Promise<string | null>;
}

/** The draggable block at pos: the top-level node, or the hovered ListItem. */
function blockAt(state: EditorState, pos: number): BlockRange | null {
  // resolve toward this line's own content — at line end, side 1 would
  // resolve forward into the *next* block
  const side = pos >= state.doc.lineAt(pos).to ? -1 : 1;
  const node = syntaxTree(state).resolveInner(pos, side);
  if (node.name === "Document") return null; // blank line between blocks
  let item: SyntaxNode | null = null;
  let top: SyntaxNode = node;
  for (let n: SyntaxNode | null = node; n && n.parent; n = n.parent) {
    if (n.name === "ListItem" && !item) item = n;
    if (n.parent.name === "Document") top = n;
  }
  const b = item ?? top;
  return { from: b.from, to: b.to };
}

/** All positions a dragged block may land: the first line of every top-level
 * block and every list item (however nested), plus the document end. */
function dropBoundaries(state: EditorState): number[] {
  const doc = state.doc;
  const set = new Set<number>();
  syntaxTree(state).iterate({
    enter: n => {
      if (n.name === "Document") return true;
      const isList = n.name === "BulletList" || n.name === "OrderedList";
      if (n.node.parent?.name === "Document") {
        set.add(doc.lineAt(n.from).from);
        return isList;
      }
      if (n.name === "ListItem") {
        set.add(doc.lineAt(n.from).from);
        return true; // descend for nested lists
      }
      return isList;
    },
  });
  set.add(doc.length);
  return [...set].sort((a, b) => a - b);
}

/** Move a block (line-aligned range) so it starts at `insert` (a line start
 * or doc end, in pre-move coordinates outside the block), then flash it. */
function moveBlock(view: EditorView, block: BlockRange, insert: number): void {
  const doc = view.state.doc;
  const text = doc.sliceString(block.from, block.to);
  const len = block.to - block.from;
  const atEnd = insert >= doc.length;
  view.dispatch({
    changes: [
      // take one adjacent newline along with the block
      block.to < doc.length ? { from: block.from, to: block.to + 1 } : { from: Math.max(0, block.from - 1), to: block.to },
      atEnd ? { from: doc.length, insert: "\n" + text } : { from: insert, insert: text + "\n" },
    ],
    userEvent: "move",
  });
  const newFrom = insert <= block.from ? insert : insert - len - 1 + (atEnd ? 1 : 0);
  // flash after the automerge reconcile (a microtask away) — its doc-end
  // newline juggling is a delete+reinsert that would wipe a mapped
  // decoration; the text is identical afterwards, so offsets stay valid
  setTimeout(() => {
    view.dispatch({ effects: decorateLines.of({ from: newFrom, to: newFrom + len, cls: "blk-landed" }) });
    setTimeout(() => view.dispatch({ effects: decorateLines.of(null) }), 600);
  }, 0);
}

// ——— drag-dim + landed-flash line decorations (survive re-rendering, unlike
// inline styles, which CM wipes whenever it redraws a line) ———

const decorateLines = StateEffect.define<{ from: number; to: number; cls: string } | null>();

const blockDecoField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(decorateLines)) continue;
      if (!e.value) {
        value = Decoration.none;
        continue;
      }
      const doc = tr.state.doc;
      const lines: Range<Decoration>[] = [];
      const first = doc.lineAt(Math.min(e.value.from, doc.length)).number;
      const last = doc.lineAt(Math.min(e.value.to, doc.length)).number;
      const deco = Decoration.line({ class: e.value.cls });
      for (let n = first; n <= last; n++) lines.push(deco.range(doc.line(n).from));
      value = Decoration.set(lines);
    }
    return value;
  },
  provide: f => EditorView.decorations.from(f),
});

class HandlesPlugin {
  private host: HTMLElement;
  private root: HTMLElement;
  private grip: HTMLElement;
  private drop: HTMLElement;
  private ghost: HTMLElement | null = null;
  private menu: HTMLElement | null = null;
  private menuItems: HTMLElement | null = null;
  private block: BlockRange | null = null;
  /** captured at drag start — hover state may expire during a long drag */
  private dragBlock: BlockRange | null = null;
  /** `+` inserts below the block; `/` converts the line it was typed on */
  private menuMode: { kind: "insert"; block: BlockRange } | { kind: "convert"; pos: number } | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private dragging = false;
  private boundaries: number[] = [];
  private dropPos: number | null = null;
  private dropY = 0;
  private filter = "";
  private menuIndex = 0;

  constructor(
    readonly view: EditorView,
    readonly config: BlockHandlesConfig
  ) {
    this.host = view.dom.parentElement!;
    this.root = document.createElement("div");
    this.root.className = "blk-ui";
    const plus = document.createElement("button");
    plus.className = "blk-btn";
    plus.textContent = "+";
    plus.title = "Add a block below";
    this.grip = document.createElement("button");
    this.grip.className = "blk-btn blk-btn--grip";
    this.grip.textContent = "⋮⋮";
    this.grip.title = "Drag to move";
    this.root.append(plus, this.grip);
    this.drop = document.createElement("div");
    this.drop.className = "blk-drop";
    this.drop.style.display = "none";
    this.host.append(this.root, this.drop);

    // document-level: the handles live in the margin, outside view.dom, and
    // hovering that margin should reveal them too
    document.addEventListener("mousemove", this.onHover);
    this.grip.addEventListener("mousedown", this.onDragStart);
    plus.addEventListener("click", this.openMenu);
  }

  update(u: ViewUpdate): void {
    if (u.docChanged) {
      if (this.dragging) this.cancelDrag(); // e.g. a remote edit mid-drag
      this.hide();
      this.closeMenu();
    }
  }

  destroy(): void {
    document.removeEventListener("mousemove", this.onHover);
    this.endDragListeners();
    this.ghost?.remove();
    this.closeMenu();
    this.root.remove();
    this.drop.remove();
  }

  private onHover = (e: MouseEvent): void => {
    if (this.dragging || this.menu) return;
    const { view } = this;
    const cRect = view.contentDOM.getBoundingClientRect();
    // active zone: the content column plus the margin strip with the handles
    if (e.clientX < cRect.left - 76 || e.clientX > cRect.right || e.clientY < cRect.top || e.clientY > cRect.bottom)
      return this.scheduleHide();
    const linePos = view.posAtCoords({ x: Math.max(e.clientX, cRect.left + 1), y: e.clientY }, false);
    const line = view.state.doc.lineAt(linePos);
    // margin hovers land at column 0 — step past list indentation so nested
    // rows resolve to their own item, like hovers over the text do
    const pos =
      e.clientX < cRect.left ? Math.min(line.from + (/^\s*/.exec(line.text)?.[0].length ?? 0), line.to) : linePos;
    const block = blockAt(view.state, pos);
    if (!block) return this.scheduleHide();
    this.cancelHide();
    this.block = block;
    const coords = view.coordsAtPos(block.from);
    if (!coords) return;
    const hostRect = this.host.getBoundingClientRect();
    this.root.style.top = `${coords.top - hostRect.top - 1}px`;
    this.root.classList.add("blk-ui--show");
  };

  private scheduleHide = (): void => {
    if (this.dragging) return; // the drop still needs the hover state
    this.cancelHide();
    this.hideTimer = setTimeout(() => this.hide(), 350);
  };

  private cancelHide = (): void => {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  };

  private hide(): void {
    this.root.classList.remove("blk-ui--show");
    this.block = null;
  }

  // ——— drag to move ———

  private onDragStart = (e: MouseEvent): void => {
    if (!this.block || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.dragging = true;
    this.dragBlock = this.block;
    this.dropPos = null;
    // boundaries inside the dragged block are not targets
    this.boundaries = dropBoundaries(this.view.state).filter(b => b <= this.block!.from || b > this.block!.to);
    this.makeGhost(this.block, e);
    document.body.classList.add("blk-grabbing");
    window.addEventListener("mousemove", this.onDragMove);
    window.addEventListener("mouseup", this.onDragEnd);
  };

  /** Clone the block's rendered lines into a floating semi-transparent ghost
   * and dim the original lines (via decoration, so it survives re-renders).
   * The editor's classes go on an *inner* wrapper — .cm-editor's own
   * position/display rules would defeat the ghost's fixed positioning. */
  private makeGhost(block: BlockRange, e: MouseEvent): void {
    const { view } = this;
    const doc = view.state.doc;
    const content = view.contentDOM.cloneNode(false) as HTMLElement;
    content.removeAttribute("contenteditable");
    const first = doc.lineAt(block.from).number;
    const last = doc.lineAt(block.to).number;
    // clone each covered top-level element — a .cm-line or a widget (table);
    // widgets span several doc lines, so dedupe
    const seen = new Set<Node>();
    for (let n = first; n <= Math.min(last, first + 7); n++) {
      const { node, offset } = view.domAtPos(doc.line(n).from);
      let e: Node | null = node;
      if (node === view.contentDOM) {
        // widget-replaced lines resolve to the gap *after* the widget
        const prev = view.contentDOM.childNodes[offset - 1];
        e = prev instanceof HTMLElement && !prev.classList.contains("cm-line") ? prev : view.contentDOM.childNodes[offset] ?? prev ?? null;
      }
      while (e && e.parentNode && e.parentNode !== view.contentDOM) e = e.parentNode;
      if (e instanceof HTMLElement && !seen.has(e)) {
        seen.add(e);
        content.append(e.cloneNode(true));
      }
    }
    const inner = document.createElement("div");
    inner.className = view.dom.className;
    inner.append(content);
    const ghost = document.createElement("div");
    ghost.className = "blk-ghost";
    ghost.style.width = `${view.contentDOM.clientWidth}px`;
    ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 10}px)`;
    ghost.append(inner);
    document.body.append(ghost);
    this.ghost = ghost;
    view.dispatch({ effects: decorateLines.of({ from: block.from, to: block.to, cls: "blk-dimmed" }) });
  }

  private onDragMove = (e: MouseEvent): void => {
    const { view } = this;
    if (this.ghost) this.ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 10}px)`;
    const doc = view.state.doc;
    const cRect = view.contentDOM.getBoundingClientRect();
    const lineFrom = doc.lineAt(view.posAtCoords({ x: cRect.left + 1, y: e.clientY }, false)).from;
    let idx = this.boundaries.findIndex(b => b >= lineFrom);
    if (idx < 0) idx = this.boundaries.length - 1;
    // nearest boundary by screen distance — candidates around the pointer line
    let best: number | null = null;
    let bestY = 0;
    let bestDist = Infinity;
    for (const i of [idx - 1, idx, idx + 1]) {
      const b = this.boundaries[i];
      if (b === undefined) continue;
      const c = view.coordsAtPos(Math.min(b, doc.length));
      if (!c) continue;
      const y = b >= doc.length ? c.bottom : c.top;
      const d = Math.abs(y - e.clientY);
      if (d < bestDist) {
        bestDist = d;
        best = b;
        bestY = y;
      }
    }
    if (best === null) return;
    this.dropPos = best;
    this.dropY = bestY;
    const hostRect = this.host.getBoundingClientRect();
    this.drop.style.display = "block";
    this.drop.style.top = `${bestY - hostRect.top - 1}px`;
    this.drop.style.left = `${cRect.left - hostRect.left}px`;
    this.drop.style.width = `${cRect.width}px`;
  };

  private onDragEnd = (): void => {
    const src = this.dragBlock;
    const target = this.dropPos;
    const targetY = this.dropY;
    this.dragBlock = null;
    // dropping onto either edge of the block itself is a no-op
    const valid = src !== null && target !== null && (target < src.from || target > src.to + 1);
    this.endDragListeners();
    this.releaseGhost(valid ? targetY : null);
    if (valid) moveBlock(this.view, src, target);
  };

  private cancelDrag(): void {
    this.dragBlock = null;
    this.endDragListeners();
    this.releaseGhost(null);
  }

  /** Fly the ghost to the drop gap (or just fade it out) and remove it. */
  private releaseGhost(targetY: number | null): void {
    const ghost = this.ghost;
    this.ghost = null;
    if (!ghost) return;
    ghost.classList.add("blk-ghost--drop");
    if (targetY !== null) {
      const cRect = this.view.contentDOM.getBoundingClientRect();
      ghost.style.transform = `translate(${cRect.left}px, ${targetY}px)`;
    }
    setTimeout(() => ghost.remove(), 200);
  }

  private endDragListeners(): void {
    const wasDragging = this.dragging;
    this.dragging = false;
    this.drop.style.display = "none";
    document.body.classList.remove("blk-grabbing");
    window.removeEventListener("mousemove", this.onDragMove);
    window.removeEventListener("mouseup", this.onDragEnd);
    if (wasDragging) {
      // un-dim; guarded because destroy() also lands here mid-drag
      try {
        this.view.dispatch({ effects: decorateLines.of(null) });
      } catch {}
    }
  }

  // ——— "+" block type menu ———

  private openMenu = (): void => {
    if (!this.block) return;
    this.openTypeMenu({ kind: "insert", block: this.block }, parseFloat(this.root.style.top) + 30);
  };

  /** `/` on an empty line/block — same menu, anchored under the caret.
   * False when the caret isn't measurable (off-viewport) — the slash then
   * inserts normally. */
  openSlashMenu(pos: number): boolean {
    const coords = this.view.coordsAtPos(pos);
    if (!coords) return false;
    const hostRect = this.host.getBoundingClientRect();
    const cRect = this.view.contentDOM.getBoundingClientRect();
    this.openTypeMenu({ kind: "convert", pos }, coords.bottom + 6 - hostRect.top, cRect.left - hostRect.left);
    return true;
  }

  private openTypeMenu(mode: NonNullable<HandlesPlugin["menuMode"]>, top: number, left?: number): void {
    this.closeMenu();
    this.menuMode = mode;
    this.filter = "";
    this.menuIndex = 0;

    const menu = (this.menu = document.createElement("div"));
    menu.className = "blk-menu";
    const input = document.createElement("input");
    input.className = "blk-filter";
    input.placeholder = "Type to filter…";
    this.menuItems = document.createElement("div");
    this.menuItems.className = "blk-items";
    menu.append(input, this.menuItems);
    this.renderItems();

    menu.style.top = `${top}px`;
    if (left !== undefined) menu.style.left = `${left}px`;
    this.host.append(menu);

    input.addEventListener("input", () => {
      this.filter = input.value.toLowerCase();
      this.menuIndex = 0;
      this.renderItems();
    });
    menu.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        this.closeMenu();
        this.view.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = this.visibleTypes().length;
        if (n) this.selectMenuItem((this.menuIndex + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const t = this.visibleTypes()[this.menuIndex];
        if (t) this.insertBlock(t);
      }
    });
    setTimeout(() => {
      input.focus();
      document.addEventListener("mousedown", this.onOutsideClick);
    }, 0);
  }

  private onOutsideClick = (e: MouseEvent): void => {
    if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu();
  };

  private visibleTypes(): BlockType[] {
    return BLOCK_TYPES.filter(t => !this.filter || t.label.toLowerCase().includes(this.filter));
  }

  /** Move the keyboard selection (hover keeps it in sync too). */
  private selectMenuItem(index: number): void {
    this.menuIndex = index;
    const items = this.menuItems?.querySelectorAll<HTMLElement>(".blk-item");
    items?.forEach((el, i) => el.classList.toggle("blk-item--selected", i === index));
    items?.[index]?.scrollIntoView({ block: "nearest" });
  }

  private renderItems(): void {
    if (!this.menuItems) return;
    this.menuItems.textContent = "";
    const visible = this.visibleTypes();
    this.menuIndex = Math.min(this.menuIndex, Math.max(0, visible.length - 1));
    visible.forEach((t, i) => {
      const btn = document.createElement("button");
      btn.className = "blk-item" + (i === this.menuIndex ? " blk-item--selected" : "");
      const label = document.createElement("span");
      label.textContent = t.label;
      const hint = document.createElement("span");
      hint.className = "blk-item-hint";
      hint.textContent = t.hint;
      btn.append(label, hint);
      btn.addEventListener("click", () => this.insertBlock(t));
      btn.addEventListener("mouseenter", () => {
        if (this.menuIndex !== i) this.selectMenuItem(i);
      });
      this.menuItems!.append(btn);
    });
  }

  private insertBlock(t: BlockType): void {
    const mode = this.menuMode;
    this.closeMenu();
    if (!mode) return;
    if (t.page) {
      // async: create the page first, then insert a link to it
      void this.config.createPage?.().then(slug => {
        if (slug) this.applyBlock({ ...t, text: `@${slug} ` }, mode);
      });
      return;
    }
    this.applyBlock(t, mode);
  }

  private applyBlock(t: BlockType, mode: NonNullable<HandlesPlugin["menuMode"]>): void {
    const { view } = this;
    const doc = view.state.doc;
    if (mode.kind === "insert") {
      const at = Math.min(mode.block.to, doc.length);
      const insert = (t.blankBefore ? "\n\n" : "\n") + t.text;
      view.dispatch({
        changes: { from: at, insert },
        selection: { anchor: at + insert.length - (t.caretBack ?? 0) },
        userEvent: "input",
        scrollIntoView: true,
      });
    } else {
      // convert: replace the (empty) line the slash was typed on
      const line = doc.lineAt(Math.min(mode.pos, doc.length));
      const prev = line.number > 1 ? doc.line(line.number - 1) : null;
      const insert = (t.blankBefore && prev && prev.text.trim() ? "\n" : "") + t.text;
      view.dispatch({
        changes: { from: line.from, to: line.to, insert },
        selection: { anchor: line.from + insert.length - (t.caretBack ?? 0) },
        userEvent: "input",
        scrollIntoView: true,
      });
    }
    view.focus();
  }

  private closeMenu(): void {
    document.removeEventListener("mousedown", this.onOutsideClick);
    this.menu?.remove();
    this.menu = null;
    this.menuItems = null;
    this.menuMode = null;
  }
}

export function blockHandles(config: BlockHandlesConfig = {}): Extension {
  const plugin = ViewPlugin.define(view => new HandlesPlugin(view, config));
  // `/` on an empty line (or an empty `- ` / `> ` prefix) opens the type
  // menu instead of inserting a slash; mid-text slashes stay literal
  const slashMenu = EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== "/" || from !== to || view.state.field(sourceModeField)) return false;
    const line = view.state.doc.lineAt(from);
    if (from !== line.to) return false;
    if (line.text.trim() && prefixEnd(line.text) !== line.text.length) return false;
    // the view is mid-DOM-reconciliation here and coords aren't measurable
    // yet — claim the key now, open the menu once the input cycle settles
    setTimeout(() => view.plugin(plugin)?.openSlashMenu(from), 0);
    return true;
  });
  return [blockDecoField, plugin, slashMenu];
}
