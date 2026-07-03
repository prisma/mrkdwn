/**
 * The canvas editor: a FigJam-feel surface over a JSON Canvas document
 * living in Automerge (see shared/canvas.ts for the CRDT mapping).
 *
 * - pan: drag the background or scroll; zoom: ⌘/ctrl + scroll (to cursor)
 * - nodes: notes, shapes, sections, page embeds, links, images; drag to
 *   move, corner handle to resize, Delete to remove
 * - double-click edits notes/shapes/links/sections inline; double-clicking
 *   a page embed animates it up to a near-fullscreen panel with the real
 *   markdown editor and a close button in the header
 * - edges: drag from a side anchor; the draft snaps to the hovered target
 * - text commits are unmount-safe: clicking away never loses input
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as A from "@automerge/automerge";
import type { DocHandle } from "@automerge/automerge-repo/slim";
import { useDocument, useRepo } from "@automerge/automerge-repo-react-hooks";
import type { MrkdwnDoc, PageMeta } from "../../shared/types";
import {
  CANVAS_PRESETS,
  newCanvasId,
  nextZ,
  type CanvasData,
  type CanvasNode,
  type NodeSide,
  type SpecNode,
} from "../../shared/canvas";
import { renderMarkdown } from "./md";
import { imageFromDataTransfer, uploadImage } from "../app/images";
import { Editor } from "../editor/Editor";
import { PresenceStore } from "../app/presence";
import { loadIdentity } from "../app/identity";

interface CanvasEditorProps {
  handle: DocHandle<MrkdwnDoc>;
  pages: PageMeta[];
  currentPageId: string;
  onNavigate(id: string): void;
  onCreatePage(title?: string): Promise<PageMeta | null>;
  readOnly: boolean;
}

interface Viewport {
  x: number;
  y: number;
  scale: number;
}

type Tool = "select" | "note" | "shape-rectangle" | "shape-ellipse" | "shape-diamond" | "section" | "page" | "link";

const NOTE_W = 240;
const NOTE_H = 150;
const EMBED_W = 380;
const EMBED_H = 300;

export function CanvasEditor(p: CanvasEditorProps) {
  const [doc, changeDoc] = useDocument<MrkdwnDoc>(p.handle.url, { suspense: false });
  const canvas: CanvasData = doc?.canvas ?? { nodes: {}, edges: {} };
  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;

  const stageRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<Viewport>({ x: 80, y: 60, scale: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [tool, setTool] = useState<Tool>("select");
  const [shapeMenu, setShapeMenu] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [focused, setFocused] = useState<{ id: string; fromRect: DOMRect; selectTitle?: boolean } | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [edgeDraft, setEdgeDraft] = useState<{ from: string; side: NodeSide; x: number; y: number; targetId: string | null } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const rect = stageRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - rect.left - v.x) / v.scale, y: (clientY - rect.top - v.y) / v.scale };
  }, []);

  // ---- mutations ----

  const mutate = useCallback(
    (fn: (c: CanvasData) => void) => {
      changeDoc(d => {
        if (!d.canvas) d.canvas = { nodes: {}, edges: {} };
        fn(d.canvas);
      });
    },
    [changeDoc]
  );

  const addNode = useCallback(
    (node: SpecNode) => {
      mutate(c => {
        c.nodes[node.id] = { ...node, z: nextZ(c) } as CanvasNode;
      });
      setSelected(node.id);
      setTool("select");
    },
    [mutate]
  );

  const removeNode = useCallback(
    (id: string) => {
      mutate(c => {
        delete c.nodes[id];
        for (const [eid, e] of Object.entries(c.edges)) {
          if (e.fromNode === id || e.toNode === id) delete c.edges[eid];
        }
      });
      setSelected(s => (s === id ? null : s));
    },
    [mutate]
  );

  const bringToFront = useCallback(
    (id: string) => {
      mutate(c => {
        const n = c.nodes[id];
        if (n && n.z !== nextZ(c) - 1) n.z = nextZ(c);
      });
    },
    [mutate]
  );

  // ---- stage gestures: pan, zoom, tool placement ----

  const panState = useRef<{ startX: number; startY: number; viewX: number; viewY: number } | null>(null);
  const isStageTarget = (e: { target: EventTarget | null; currentTarget: EventTarget }) =>
    e.target === e.currentTarget || (e.target as HTMLElement).classList?.contains("canvas-world");

  const onStagePointerDown = (e: React.PointerEvent) => {
    if (!isStageTarget(e)) return;
    setSelected(null);
    setEditing(null);
    setShapeMenu(false);
    if (tool !== "select") {
      placeWithTool(tool, toWorld(e.clientX, e.clientY));
      return;
    }
    panState.current = { startX: e.clientX, startY: e.clientY, viewX: view.x, viewY: view.y };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
  };
  const onStagePointerMove = (e: React.PointerEvent) => {
    if (!panState.current) return;
    const s = panState.current;
    setView(v => ({ ...v, x: s.viewX + (e.clientX - s.startX), y: s.viewY + (e.clientY - s.startY) }));
  };
  const onStagePointerUp = () => {
    panState.current = null;
  };

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      const zooming = e.ctrlKey || e.metaKey;
      // scrolling inside an embedded page scrolls the page, not the canvas
      if (!zooming && (e.target as HTMLElement).closest?.(".canvas-md--embed, .canvas-node-edit")) return;
      e.preventDefault();
      if (zooming) {
        const rect = stage.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        setView(v => {
          const scale = Math.min(2.5, Math.max(0.2, v.scale * Math.exp(-e.deltaY * 0.01)));
          const k = scale / v.scale;
          return { scale, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k };
        });
      } else {
        setView(v => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  const centerWorld = useCallback(() => {
    const rect = stageRef.current!.getBoundingClientRect();
    return toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }, [toWorld]);

  const placeWithTool = (t: Tool, at: { x: number; y: number }) => {
    const id = newCanvasId();
    const centered = (w: number, h: number) => ({ x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2), width: w, height: h });
    if (t === "note") {
      addNode({ id, type: "text", text: "", color: "3", ...centered(NOTE_W, NOTE_H) });
      setEditing(id);
    } else if (t === "shape-rectangle" || t === "shape-ellipse" || t === "shape-diamond") {
      const shape = t.slice("shape-".length) as "rectangle" | "ellipse" | "diamond";
      addNode({ id, type: "text", text: "", shape, ...centered(200, shape === "rectangle" ? 120 : 160) });
      setEditing(id);
    } else if (t === "section") {
      addNode({ id, type: "group", label: "Section", ...centered(520, 380) });
    } else if (t === "page") {
      const first = p.pages.find(pg => pg.kind === "markdown" && pg.id !== p.currentPageId) ?? p.pages[0];
      if (!first) return;
      addNode({ id, type: "file", file: `${first.slug}.md`, pageId: first.id, ...centered(EMBED_W, EMBED_H) });
    } else if (t === "link") {
      addNode({ id, type: "link", url: "", ...centered(NOTE_W, 80) });
      setEditing(id);
    }
  };

  const onStageDoubleClick = (e: React.MouseEvent) => {
    if (!isStageTarget(e)) return;
    placeWithTool("note", toWorld(e.clientX, e.clientY));
  };

  // ---- paste: images become image nodes, text becomes a note ----

  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      if (p.readOnly || focused) return;
      const target = e.target as HTMLElement;
      if (target.closest("textarea, input, [contenteditable=true]")) return;
      const file = imageFromDataTransfer(e.clipboardData);
      const at = centerWorld();
      if (file) {
        e.preventDefault();
        const up = await uploadImage(file);
        if (!up) return;
        const w = Math.min(420, up.width);
        const h = Math.round((w / up.width) * up.height);
        addNode({ id: newCanvasId(), type: "file", file: up.url, x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2), width: w, height: h });
        return;
      }
      const text = e.clipboardData?.getData("text/plain");
      if (text) {
        e.preventDefault();
        addNode({ id: newCanvasId(), type: "text", text, x: Math.round(at.x - NOTE_W / 2), y: Math.round(at.y - NOTE_H / 2), width: NOTE_W, height: NOTE_H });
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [addNode, centerWorld, p.readOnly, focused]);

  // ---- keyboard ----

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || focused || p.readOnly) return;
      const target = e.target as HTMLElement;
      if (target.closest("textarea, input")) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        e.preventDefault();
        if (canvasRef.current.edges[selected]) mutate(c => void delete c.edges[selected]);
        else removeNode(selected);
      }
      if (e.key === "Escape") {
        setSelected(null);
        setTool("select");
        setShapeMenu(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, editing, focused, removeNode, mutate, p.readOnly]);

  // ---- edge creation: window-tracked drag with target snapping ----

  const startEdge = (nodeId: string, side: NodeSide, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const at = toWorld(e.clientX, e.clientY);
    setEdgeDraft({ from: nodeId, side, x: at.x, y: at.y, targetId: null });

    const onMove = (ev: PointerEvent) => {
      const pos = toWorld(ev.clientX, ev.clientY);
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("[data-node-id]");
      const targetId = el?.getAttribute("data-node-id");
      setEdgeDraft(d => (d ? { ...d, x: pos.x, y: pos.y, targetId: targetId && targetId !== nodeId ? targetId : null } : d));
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("[data-node-id]");
      const toId = el?.getAttribute("data-node-id");
      setEdgeDraft(null);
      if (!toId || toId === nodeId) return;
      const to = canvasRef.current.nodes[toId];
      if (!to) return;
      const toSide = nearestSide(to, toWorld(ev.clientX, ev.clientY));
      mutate(c => {
        const id = newCanvasId();
        c.edges[id] = { id, fromNode: nodeId, fromSide: side, toNode: toId, toSide, toEnd: "arrow" };
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ---- toolbar actions ----

  const pickImage = () => fileInput.current?.click();
  const onFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !file.type.startsWith("image/")) return;
    const up = await uploadImage(file);
    if (!up) return;
    const at = centerWorld();
    const w = Math.min(420, up.width);
    const h = Math.round((w / up.width) * up.height);
    addNode({ id: newCanvasId(), type: "file", file: up.url, x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2), width: w, height: h });
  };

  const focusNode = (id: string, el: HTMLElement, selectTitle = false) => {
    setEditing(null);
    setFocused({ id, fromRect: el.getBoundingClientRect(), selectTitle });
  };

  /** "＋ New page…" in an embed: create it, point the node at it, and open
   * the expanded editor right away with the title selected for renaming. */
  const newPageForNode = useCallback(
    async (nodeId: string) => {
      const created = await p.onCreatePage("Untitled");
      if (!created) return;
      mutate(c => {
        const n = c.nodes[nodeId];
        if (n && n.type === "file") {
          n.file = `${created.slug}.md`;
          n.pageId = created.id;
        }
      });
      setTimeout(() => {
        const el = document.querySelector(`[data-node-id="${nodeId}"]`) as HTMLElement | null;
        if (el) focusNode(nodeId, el, true);
      }, 50);
    },
    [p.onCreatePage, mutate]
  );

  // renames re-derive slugs server-side; heal file references via pageId
  // (and backfill pageId on legacy nodes while their slug still resolves)
  useEffect(() => {
    if (p.readOnly) return;
    const fixes: { nodeId: string; file?: string; pageId?: string }[] = [];
    for (const node of Object.values(canvasRef.current.nodes)) {
      if (node.type !== "file" || node.file.startsWith("/api/images/")) continue;
      if (node.pageId) {
        const page = p.pages.find(pg => pg.id === node.pageId);
        if (page && node.file !== `${page.slug}.md`) fixes.push({ nodeId: node.id, file: `${page.slug}.md` });
      } else {
        const page = p.pages.find(pg => pg.slug === node.file.replace(/\.md$/, ""));
        if (page) fixes.push({ nodeId: node.id, pageId: page.id });
      }
    }
    if (fixes.length === 0) return;
    mutate(c => {
      for (const fix of fixes) {
        const n = c.nodes[fix.nodeId];
        if (!n || n.type !== "file") continue;
        if (fix.file) n.file = fix.file;
        if (fix.pageId) n.pageId = fix.pageId;
      }
    });
  }, [p.pages, p.readOnly, mutate]);

  const nodes = useMemo(
    () => Object.values(canvas.nodes).sort((a, b) => (a.z ?? 0) - (b.z ?? 0) || a.id.localeCompare(b.id)),
    [canvas.nodes]
  );
  const focusedNode = focused ? canvas.nodes[focused.id] : undefined;

  return (
    <>
      <div
        ref={stageRef}
        className={"canvas-stage" + (tool !== "select" ? " canvas-stage--placing" : "")}
        style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${24 * view.scale}px ${24 * view.scale}px` }}
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onDoubleClick={onStageDoubleClick}
      >
        <div className="canvas-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
          <EdgeLayer canvas={canvas} draft={edgeDraft} selected={selected} onSelect={setSelected} />
          {nodes.map(node => (
            <NodeView
              key={node.id}
              node={node}
              pages={p.pages}
              scale={view.scale}
              selected={selected === node.id}
              hovered={hovered === node.id}
              editing={editing === node.id}
              dimmed={focused?.id === node.id}
              dropTarget={edgeDraft?.targetId === node.id}
              draftSource={edgeDraft?.from === node.id}
              readOnly={p.readOnly}
              onSelect={() => {
                setSelected(node.id);
                bringToFront(node.id);
              }}
              onHover={h => setHovered(h ? node.id : null)}
              onEdit={() => setEditing(node.id)}
              onDoneEditing={() => setEditing(null)}
              onFocus={el => focusNode(node.id, el)}
              onNewPage={() => void newPageForNode(node.id)}
              mutate={mutate}
              startEdge={startEdge}
            />
          ))}
        </div>

        {!p.readOnly && (
          <div className="canvas-toolbar">
            <ToolButton active={tool === "select"} title="Select & pan (Esc)" onClick={() => { setTool("select"); setShapeMenu(false); }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 3l7 17 2.6-7.4L21 10z" /></svg>
            </ToolButton>
            <ToolButton active={tool === "note"} title="Note — or double-click the canvas" onClick={() => { setTool("note"); setShapeMenu(false); }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16v10l-6 6H4z" /><path d="M14 20v-6h6" /></svg>
            </ToolButton>
            <div className="canvas-tool-group">
              <ToolButton active={tool.startsWith("shape-")} title="Shapes" onClick={() => setShapeMenu(m => !m)}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="10" height="10" rx="1.5" /><circle cx="16.5" cy="16.5" r="4.5" /></svg>
              </ToolButton>
              {shapeMenu && (
                <div className="canvas-shape-menu">
                  <button title="Rectangle" onClick={() => { setTool("shape-rectangle"); setShapeMenu(false); }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="14" rx="2" /></svg>
                  </button>
                  <button title="Ellipse" onClick={() => { setTool("shape-ellipse"); setShapeMenu(false); }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="12" rx="9" ry="7" /></svg>
                  </button>
                  <button title="Diamond" onClick={() => { setTool("shape-diamond"); setShapeMenu(false); }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M12 2l10 10-10 10L2 12z" /></svg>
                  </button>
                </div>
              )}
            </div>
            <ToolButton active={tool === "section"} title="Section (group)" onClick={() => { setTool("section"); setShapeMenu(false); }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="4 3"><rect x="3" y="3" width="18" height="18" rx="3" /></svg>
            </ToolButton>
            <ToolButton active={tool === "page"} title="Embed a page from this workspace" onClick={() => { setTool("page"); setShapeMenu(false); }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
            </ToolButton>
            <ToolButton active={tool === "link"} title="Link card" onClick={() => { setTool("link"); setShapeMenu(false); }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></svg>
            </ToolButton>
            <ToolButton active={false} title="Add image (or paste one)" onClick={pickImage}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>
            </ToolButton>
            <input ref={fileInput} type="file" accept="image/*" style={{ display: "none" }} onChange={onFilePicked} />
          </div>
        )}

        <div className="canvas-zoom">
          <button onClick={() => setView(v => ({ ...v, scale: Math.max(0.2, v.scale / 1.2) }))} title="Zoom out">−</button>
          <span onClick={() => setView({ x: 80, y: 60, scale: 1 })} title="Reset view">{Math.round(view.scale * 100)}%</span>
          <button onClick={() => setView(v => ({ ...v, scale: Math.min(2.5, v.scale * 1.2) }))} title="Zoom in">+</button>
        </div>
      </div>

      {focused && focusedNode && (
        <FocusOverlay
          key={focused.id}
          node={focusedNode}
          fromRect={focused.fromRect}
          selectTitle={focused.selectTitle ?? false}
          pages={p.pages}
          readOnly={p.readOnly}
          onNavigate={p.onNavigate}
          mutate={mutate}
          onClose={() => setFocused(null)}
        />
      )}
    </>
  );
}

function ToolButton(p: { active: boolean; title: string; onClick(): void; children: React.ReactNode }) {
  return (
    <button className={"canvas-tool" + (p.active ? " canvas-tool--active" : "")} title={p.title} onClick={p.onClick}>
      {p.children}
    </button>
  );
}

/** Input/textarea that commits exactly once — on blur, Escape, or unmount —
 * so clicking elsewhere on the canvas never eats what was typed. */
function CommitField(p: {
  multiline: boolean;
  initial: string;
  className: string;
  placeholder?: string;
  onCommit(value: string): void;
}) {
  const value = useRef(p.initial);
  const done = useRef(false);
  const commitRef = useRef(p.onCommit);
  commitRef.current = p.onCommit;

  const commit = useCallback(() => {
    if (done.current) return;
    done.current = true;
    commitRef.current(value.current);
  }, []);
  useEffect(() => commit, [commit]); // unmount ⇒ commit

  const shared = {
    className: p.className,
    autoFocus: true,
    defaultValue: p.initial,
    placeholder: p.placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      value.current = e.target.value;
    },
    onBlur: commit,
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  };
  if (p.multiline) {
    return (
      <textarea
        {...shared}
        onKeyDown={e => {
          if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) commit();
        }}
      />
    );
  }
  return <input {...shared} onKeyDown={e => (e.key === "Enter" || e.key === "Escape") && commit()} />;
}

// ---------- nodes ----------

interface NodeViewProps {
  node: CanvasNode;
  pages: PageMeta[];
  scale: number;
  selected: boolean;
  hovered: boolean;
  editing: boolean;
  dimmed: boolean;
  dropTarget: boolean;
  draftSource: boolean;
  readOnly: boolean;
  onSelect(): void;
  onHover(h: boolean): void;
  onEdit(): void;
  onDoneEditing(): void;
  onFocus(el: HTMLElement): void;
  onNewPage(): void;
  mutate(fn: (c: CanvasData) => void): void;
  startEdge(nodeId: string, side: NodeSide, e: React.PointerEvent): void;
}

function NodeView(p: NodeViewProps) {
  const { node } = p;
  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null);
  const resize = useRef<{ px: number; py: number; w: number; h: number } | null>(null);

  const commitPos = (x: number, y: number) =>
    p.mutate(c => {
      const n = c.nodes[node.id];
      if (n) {
        n.x = Math.round(x);
        n.y = Math.round(y);
      }
    });
  const commitSize = (w: number, h: number) =>
    p.mutate(c => {
      const n = c.nodes[node.id];
      if (n) {
        n.width = Math.max(60, Math.round(w));
        n.height = Math.max(40, Math.round(h));
      }
    });

  const onPointerDown = (e: React.PointerEvent) => {
    if (p.readOnly || p.editing) return;
    if ((e.target as HTMLElement).closest(".canvas-anchor, .canvas-resize, a, select, textarea, input, button")) return;
    e.stopPropagation();
    p.onSelect();
    drag.current = { px: e.clientX, py: e.clientY, x: node.x, y: node.y, moved: false };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (drag.current) {
      const d = drag.current;
      const dx = (e.clientX - d.px) / p.scale;
      const dy = (e.clientY - d.py) / p.scale;
      if (Math.abs(dx) + Math.abs(dy) > 1) d.moved = true;
      if (d.moved) commitPos(d.x + dx, d.y + dy);
    } else if (resize.current) {
      const r = resize.current;
      commitSize(r.w + (e.clientX - r.px) / p.scale, r.h + (e.clientY - r.py) / p.scale);
    }
  };
  const onPointerUp = () => {
    drag.current = null;
    resize.current = null;
  };

  const preset = node.color ? CANVAS_PRESETS[node.color] : undefined;
  const shape = node.type === "text" ? node.shape : undefined;
  const style: React.CSSProperties = {
    left: node.x,
    top: node.y,
    width: node.width,
    height: node.height,
    ...(preset && shape !== "diamond" ? { background: preset.bg, borderColor: preset.fg } : {}),
    ...(node.color?.startsWith("#") && shape !== "diamond" ? { background: `${node.color}22`, borderColor: node.color } : {}),
    ...(shape === "ellipse" ? { borderRadius: "50%" } : {}),
    ...(shape === "diamond" ? { background: "transparent", border: "none", boxShadow: "none" } : {}),
  };

  const showAnchors = (p.selected || p.hovered || p.draftSource) && !p.readOnly && !p.editing;

  return (
    <div
      ref={rootRef}
      className={
        "canvas-node" +
        ` canvas-node--${node.type}` +
        (shape ? ` canvas-node--shape canvas-node--shape-${shape}` : "") +
        (p.selected ? " canvas-node--selected" : "") +
        (p.dropTarget ? " canvas-node--droptarget" : "") +
        (p.dimmed ? " canvas-node--dimmed" : "")
      }
      style={style}
      data-node-id={node.id}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerEnter={() => p.onHover(true)}
      onPointerLeave={() => p.onHover(false)}
      onDoubleClick={e => {
        e.stopPropagation();
        if (p.readOnly || p.editing) return;
        // page embeds expand to the full editor; everything else edits inline
        if (node.type === "file" && !node.file.startsWith("/api/images/")) {
          if (rootRef.current) p.onFocus(rootRef.current);
        } else if (node.type !== "file") {
          p.onEdit();
        }
      }}
    >
      {shape === "diamond" && <DiamondBackdrop node={node} />}
      <NodeContent {...p} />
      {p.selected && !p.readOnly && (
        <>
          <div
            className="canvas-resize"
            onPointerDown={e => {
              e.stopPropagation();
              resize.current = { px: e.clientX, py: e.clientY, w: node.width, h: node.height };
              try {
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              } catch {}
            }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
          <ColorDots node={node} mutate={p.mutate} />
        </>
      )}
      {showAnchors &&
        (["top", "right", "bottom", "left"] as NodeSide[]).map(side => (
          <div key={side} className={`canvas-anchor canvas-anchor--${side}`} onPointerDown={e => p.startEdge(node.id, side, e)}>
            <span />
          </div>
        ))}
    </div>
  );
}

function DiamondBackdrop(p: { node: CanvasNode }) {
  const preset = p.node.color ? CANVAS_PRESETS[p.node.color] : undefined;
  const fill = preset?.bg ?? "var(--bg-soft)";
  const stroke = preset?.fg ?? "var(--border-strong)";
  return (
    <svg className="canvas-diamond" viewBox="0 0 100 100" preserveAspectRatio="none">
      <path d="M50 1 L99 50 L50 99 L1 50 Z" fill={fill} stroke={stroke} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function NodeContent(p: NodeViewProps) {
  const { node } = p;

  if (node.type === "text") {
    if (p.editing) {
      return (
        <CommitField
          multiline
          className="canvas-node-edit"
          initial={node.text}
          placeholder="Write markdown…"
          onCommit={text => {
            p.mutate(c => {
              const n = c.nodes[node.id];
              if (n && n.type === "text") n.text = text;
            });
            p.onDoneEditing();
          }}
        />
      );
    }
    return node.text ? (
      <div className="canvas-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(node.text) }} />
    ) : (
      <div className="canvas-node-placeholder">Double-click to write</div>
    );
  }

  if (node.type === "file") {
    if (node.file.startsWith("/api/images/")) {
      return <img className="canvas-img" src={`${node.file}?w=${Math.min(1280, node.width * 2)}`} alt="" draggable={false} />;
    }
    const slug = node.file.replace(/\.md$/, "");
    const page = p.pages.find(pg => pg.id === node.pageId) ?? p.pages.find(pg => pg.slug === slug);
    return (
      <div className="canvas-embed">
        <div className="canvas-embed-head">
          <span className="canvas-embed-title">
            {page ? page.title || "Untitled" : slug}
            <span className="sidebar-page-ext">.md</span>
          </span>
          {p.selected && !p.readOnly && (
            <select
              className="canvas-embed-pick"
              value={page?.slug ?? slug}
              onChange={e => {
                const targetSlug = e.target.value;
                if (targetSlug === "__new__") {
                  p.onNewPage();
                  return;
                }
                const target = p.pages.find(pg => pg.slug === targetSlug);
                p.mutate(c => {
                  const n = c.nodes[node.id];
                  if (n && n.type === "file") {
                    n.file = `${targetSlug}.md`;
                    if (target) n.pageId = target.id;
                  }
                });
              }}
            >
              {p.pages
                .filter(pg => pg.kind === "markdown")
                .map(pg => (
                  <option key={pg.id} value={pg.slug}>
                    {pg.title || "Untitled"}
                  </option>
                ))}
              <option value="__new__">＋ New page…</option>
            </select>
          )}
        </div>
        {page ? <MarkdownEmbed automergeUrl={page.automergeUrl} /> : <div className="canvas-node-placeholder">page “{slug}” not found</div>}
      </div>
    );
  }

  if (node.type === "link") {
    if (p.editing) {
      return (
        <CommitField
          multiline={false}
          className="canvas-node-edit canvas-link-edit"
          initial={node.url}
          placeholder="https://…"
          onCommit={url => {
            p.mutate(c => {
              const n = c.nodes[node.id];
              if (n && n.type === "link") n.url = url.trim();
            });
            p.onDoneEditing();
          }}
        />
      );
    }
    return (
      <div className="canvas-link" title={node.url || "Double-click to set a URL"}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></svg>
        <span>{node.url ? node.url.replace(/^https?:\/\//, "") : "Double-click to set a URL"}</span>
        {node.url && (
          <a className="canvas-link-open" href={node.url} target="_blank" rel="noreferrer" title="Open link" onPointerDown={e => e.stopPropagation()}>
            ↗
          </a>
        )}
      </div>
    );
  }

  // group / section
  if (p.editing) {
    return (
      <CommitField
        multiline={false}
        className="canvas-node-edit canvas-group-edit"
        initial={node.label ?? ""}
        placeholder="Section name"
        onCommit={label => {
          p.mutate(c => {
            const n = c.nodes[node.id];
            if (n && n.type === "group") n.label = label;
          });
          p.onDoneEditing();
        }}
      />
    );
  }
  return <div className="canvas-group-label">{node.label ?? ""}</div>;
}

/** A live view of another workspace page — just another Automerge handle. */
function MarkdownEmbed(p: { automergeUrl: string }) {
  const [doc] = useDocument<MrkdwnDoc>(p.automergeUrl as never, { suspense: false });
  if (!doc) return <div className="canvas-node-placeholder">loading…</div>;
  return <div className="canvas-md canvas-md--embed" dangerouslySetInnerHTML={{ __html: renderMarkdown(doc.content) }} />;
}

function ColorDots(p: { node: CanvasNode; mutate(fn: (c: CanvasData) => void): void }) {
  return (
    <div className="canvas-colors" onPointerDown={e => e.stopPropagation()}>
      {Object.entries(CANVAS_PRESETS).map(([key, c]) => (
        <button
          key={key}
          className={"canvas-color" + (p.node.color === key ? " canvas-color--on" : "")}
          style={{ background: c.bg, borderColor: c.fg }}
          onClick={() =>
            p.mutate(cv => {
              const n = cv.nodes[p.node.id];
              if (!n) return;
              if (n.color === key) delete (n as { color?: string }).color;
              else n.color = key;
            })
          }
        />
      ))}
    </div>
  );
}

// ---------- focus mode (page embeds only) ----------

/** Double-click expansion for embedded pages: the node animates from its
 * canvas position to a near-fullscreen panel with the real markdown editor. */
function FocusOverlay(p: {
  node: CanvasNode;
  fromRect: DOMRect;
  selectTitle: boolean;
  pages: PageMeta[];
  readOnly: boolean;
  onNavigate(id: string): void;
  mutate(fn: (c: CanvasData) => void): void;
  onClose(): void;
}) {
  const repo = useRepo();
  const [expanded, setExpanded] = useState(false);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setExpanded(true), 20);
    return () => clearTimeout(t);
  }, []);

  const close = useCallback(() => {
    setClosing(true);
    setExpanded(false);
    setTimeout(p.onClose, 240);
  }, [p.onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [close]);

  const { node } = p;
  const page =
    node.type === "file" && !node.file.startsWith("/api/images/")
      ? (p.pages.find(pg => pg.id === node.pageId) ?? p.pages.find(pg => pg.slug === node.file.replace(/\.md$/, "")))
      : undefined;

  // one handle resolution for both the editable title and the editor body
  const [handle, setHandle] = useState<DocHandle<MrkdwnDoc> | null>(null);
  useEffect(() => {
    if (!page) return;
    let dead = false;
    void repo
      .find<MrkdwnDoc>(page.automergeUrl as never)
      .then(h => {
        if (!dead) setHandle(h);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [repo, page?.automergeUrl]);

  const style: React.CSSProperties = expanded
    ? { left: "50%", top: "56px", transform: "translateX(-50%)", width: "min(1080px, 94vw)", height: "calc(100vh - 112px)" }
    : { left: p.fromRect.left, top: p.fromRect.top, transform: "none", width: p.fromRect.width, height: p.fromRect.height };

  return (
    <div className={"focus-backdrop" + (expanded && !closing ? " focus-backdrop--on" : "")} onPointerDown={e => e.target === e.currentTarget && close()}>
      <div className="focus-panel" style={style}>
        <div className="focus-head">
          {page && handle ? (
            <span className="focus-title focus-title--edit">
              <FocusTitle handle={handle} selectOnMount={p.selectTitle && expanded} readOnly={p.readOnly} />
              <span className="sidebar-page-ext">.md</span>
            </span>
          ) : (
            <span className="focus-title">{page ? page.title || "Untitled" : node.type === "file" ? node.file : ""}</span>
          )}
          {page && (
            <button className="linkbtn" onClick={() => p.onNavigate(page.id)}>
              Open page ↗
            </button>
          )}
          <button className="focus-close" onClick={close} title="Close (Esc)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="focus-body">
          {expanded && !closing &&
            (page && handle ? (
              <PageEditor handle={handle} pages={p.pages} onNavigate={p.onNavigate} />
            ) : (
              <div className="canvas-node-placeholder">{page ? "loading…" : "page not found"}</div>
            ))}
        </div>
      </div>
    </div>
  );
}

/** The embedded page's title, editable in place — the same doc field the
 * page's own title bar edits, so the registry re-derives the slug and every
 * embed heals via pageId. */
function FocusTitle(p: { handle: DocHandle<MrkdwnDoc>; selectOnMount: boolean; readOnly: boolean }) {
  const [doc, changeDoc] = useDocument<MrkdwnDoc>(p.handle.url, { suspense: false });
  const ref = useRef<HTMLInputElement>(null);
  const selectedOnce = useRef(false);

  useEffect(() => {
    if (p.selectOnMount && doc && ref.current && !selectedOnce.current) {
      selectedOnce.current = true;
      ref.current.focus();
      ref.current.select();
    }
  }, [p.selectOnMount, doc]);

  return (
    <input
      ref={ref}
      className="focus-title-input"
      value={doc?.title ?? ""}
      placeholder="Untitled"
      disabled={p.readOnly}
      onChange={e =>
        changeDoc(d => {
          A.updateText(d, ["title"], e.target.value);
        })
      }
      onKeyDown={e => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

/** The real markdown editor, mounted on the embedded page's own doc handle —
 * full edit mode: live preview, tables, presence, everything. */
function PageEditor(p: { handle: DocHandle<MrkdwnDoc>; pages: PageMeta[]; onNavigate(id: string): void }) {
  const presence = useMemo(() => new PresenceStore(p.handle, loadIdentity()), [p.handle]);
  useEffect(() => () => presence.dispose(), [presence]);

  const pageLinks = useMemo(() => new Map(p.pages.map(pg => [pg.slug, pg.id])), [p.pages]);

  return (
    <div className="focus-editor">
      <Editor
        handle={p.handle}
        presence={presence}
        onSelectComment={() => {}}
        onSelection={() => {}}
        getMentionOptions={() => []}
        getAgentHandles={() => new Set()}
        getPageLinks={() => pageLinks}
        onOpenPage={slug => {
          const id = pageLinks.get(slug);
          if (id) p.onNavigate(id);
        }}
        createPage={async () => null}
        onExitTop={() => {}}
        onReady={() => {}}
      />
    </div>
  );
}

// ---------- edges ----------

function anchorPoint(node: CanvasNode, side: NodeSide): { x: number; y: number } {
  switch (side) {
    case "top":
      return { x: node.x + node.width / 2, y: node.y };
    case "bottom":
      return { x: node.x + node.width / 2, y: node.y + node.height };
    case "left":
      return { x: node.x, y: node.y + node.height / 2 };
    case "right":
      return { x: node.x + node.width, y: node.y + node.height / 2 };
  }
}

function nearestSide(node: CanvasNode, at: { x: number; y: number }): NodeSide {
  const sides: NodeSide[] = ["top", "right", "bottom", "left"];
  let best: NodeSide = "left";
  let bestDist = Infinity;
  for (const side of sides) {
    const pt = anchorPoint(node, side);
    const d = (pt.x - at.x) ** 2 + (pt.y - at.y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = side;
    }
  }
  return best;
}

function defaultSides(from: CanvasNode, to: CanvasNode): { fromSide: NodeSide; toSide: NodeSide } {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? { fromSide: "right", toSide: "left" } : { fromSide: "left", toSide: "right" };
  return dy > 0 ? { fromSide: "bottom", toSide: "top" } : { fromSide: "top", toSide: "bottom" };
}

function edgePath(a: { x: number; y: number }, aSide: NodeSide, b: { x: number; y: number }, bSide: NodeSide): string {
  const dist = Math.max(50, Math.hypot(b.x - a.x, b.y - a.y) / 2.2);
  const out = (side: NodeSide, pt: { x: number; y: number }) => {
    switch (side) {
      case "top": return { x: pt.x, y: pt.y - dist };
      case "bottom": return { x: pt.x, y: pt.y + dist };
      case "left": return { x: pt.x - dist, y: pt.y };
      case "right": return { x: pt.x + dist, y: pt.y };
    }
  };
  const c1 = out(aSide, a);
  const c2 = out(bSide, b);
  return `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`;
}

function EdgeLayer(p: {
  canvas: CanvasData;
  draft: { from: string; side: NodeSide; x: number; y: number; targetId: string | null } | null;
  selected: string | null;
  onSelect(id: string): void;
}) {
  const edges = Object.values(p.canvas.edges);
  return (
    <svg className="canvas-edges">
      <defs>
        <marker id="canvas-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--canvas-edge)" />
        </marker>
      </defs>
      {edges.map(edge => {
        const from = p.canvas.nodes[edge.fromNode];
        const to = p.canvas.nodes[edge.toNode];
        if (!from || !to) return null;
        const sides = defaultSides(from, to);
        const fromSide = edge.fromSide ?? sides.fromSide;
        const toSide = edge.toSide ?? sides.toSide;
        const a = anchorPoint(from, fromSide);
        const b = anchorPoint(to, toSide);
        const d = edgePath(a, fromSide, b, toSide);
        const stroke = edge.color ? (CANVAS_PRESETS[edge.color]?.fg ?? edge.color) : "var(--canvas-edge)";
        return (
          <g key={edge.id} className={"canvas-edge" + (p.selected === edge.id ? " canvas-edge--selected" : "")}>
            <path className="canvas-edge-hit" d={d} onPointerDown={e => { e.stopPropagation(); p.onSelect(edge.id); }} />
            <path
              className="canvas-edge-line"
              d={d}
              style={{ stroke }}
              markerEnd={(edge.toEnd ?? "arrow") === "arrow" ? "url(#canvas-arrow)" : undefined}
              markerStart={edge.fromEnd === "arrow" ? "url(#canvas-arrow)" : undefined}
            />
            {edge.label && (
              <text className="canvas-edge-label" x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 8} textAnchor="middle">
                {edge.label}
              </text>
            )}
          </g>
        );
      })}
      {p.draft &&
        (() => {
          const from = p.canvas.nodes[p.draft.from];
          if (!from) return null;
          const a = anchorPoint(from, p.draft.side);
          const target = p.draft.targetId ? p.canvas.nodes[p.draft.targetId] : undefined;
          // snap the draft end to the side it would actually connect to
          const end = target ? anchorPoint(target, nearestSide(target, { x: p.draft.x, y: p.draft.y })) : { x: p.draft.x, y: p.draft.y };
          const endSide = target ? nearestSide(target, { x: p.draft.x, y: p.draft.y }) : "left";
          return <path className="canvas-edge-line canvas-edge--draft" d={edgePath(a, p.draft.side, end, endSide)} markerEnd="url(#canvas-arrow)" />;
        })()}
    </svg>
  );
}
