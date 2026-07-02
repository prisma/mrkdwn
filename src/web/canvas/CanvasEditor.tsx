/**
 * The canvas editor: a FigJam-feel surface over a JSON Canvas document
 * living in Automerge (see shared/canvas.ts for the CRDT mapping).
 *
 * - pan: drag the background or scroll; zoom: ⌘/ctrl + scroll (to cursor)
 * - nodes: double-click empty space for a note; toolbar for notes, page
 *   embeds, links, images; drag to move, corner handle to resize,
 *   double-click to edit, keyboard Delete to remove
 * - edges: drag from a side anchor of the selected/hovered node onto
 *   another node
 * - file nodes ("slug.md") render that workspace page live — the embed is
 *   just another Automerge doc handle, so it updates as others type
 * - every mutation is a handle.change → syncs to every peer and the agent
 *   API sees it as spec JSON
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocHandle } from "@automerge/automerge-repo/slim";
import { useDocument } from "@automerge/automerge-repo-react-hooks";
import type { MrkdwnDoc, PageMeta } from "../../shared/types";
import {
  CANVAS_PRESETS,
  newCanvasId,
  nextZ,
  type CanvasData,
  type CanvasEdge,
  type CanvasNode,
  type SpecNode,
  type NodeSide,
} from "../../shared/canvas";
import { renderMarkdown } from "./md";
import { imageFromDataTransfer, uploadImage } from "../app/images";

interface CanvasEditorProps {
  handle: DocHandle<MrkdwnDoc>;
  pages: PageMeta[];
  currentPageId: string;
  onNavigate(id: string): void;
  readOnly: boolean;
}

interface Viewport {
  x: number;
  y: number;
  scale: number;
}

type Tool = "select" | "note" | "page" | "link";

const NOTE_W = 240;
const NOTE_H = 150;
const EMBED_W = 380;
const EMBED_H = 300;

export function CanvasEditor(p: CanvasEditorProps) {
  const [doc, changeDoc] = useDocument<MrkdwnDoc>(p.handle.url, { suspense: false });
  const canvas: CanvasData = doc?.canvas ?? { nodes: {}, edges: {} };

  const stageRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<Viewport>({ x: 80, y: 60, scale: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [edgeDraft, setEdgeDraft] = useState<{ from: string; side: NodeSide; x: number; y: number } | null>(null);
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

  const onStagePointerDown = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains("canvas-world")) return;
    setSelected(null);
    setEditing(null);
    if (tool === "note" || tool === "page" || tool === "link") {
      const at = toWorld(e.clientX, e.clientY);
      placeWithTool(tool, at);
      return;
    }
    panState.current = { startX: e.clientX, startY: e.clientY, viewX: view.x, viewY: view.y };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
  };
  const onStagePointerMove = (e: React.PointerEvent) => {
    if (edgeDraft) {
      const at = toWorld(e.clientX, e.clientY);
      setEdgeDraft(d => (d ? { ...d, x: at.x, y: at.y } : d));
      return;
    }
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
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
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
    if (t === "note") {
      addNode({ id, type: "text", text: "", x: Math.round(at.x - NOTE_W / 2), y: Math.round(at.y - NOTE_H / 2), width: NOTE_W, height: NOTE_H, color: "3" });
      setEditing(id);
    } else if (t === "page") {
      const first = p.pages.find(pg => pg.kind === "markdown" && pg.id !== p.currentPageId) ?? p.pages[0];
      if (!first) return;
      addNode({ id, type: "file", file: `${first.slug}.md`, x: Math.round(at.x - EMBED_W / 2), y: Math.round(at.y - EMBED_H / 2), width: EMBED_W, height: EMBED_H });
    } else if (t === "link") {
      addNode({ id, type: "link", url: "https://", x: Math.round(at.x - NOTE_W / 2), y: Math.round(at.y - 40), width: NOTE_W, height: 80 });
      setEditing(id);
    }
  };

  const onStageDoubleClick = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains("canvas-world")) return;
    placeWithTool("note", toWorld(e.clientX, e.clientY));
  };

  // ---- paste: images become image nodes, text becomes a note ----

  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      if (p.readOnly) return;
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
  }, [addNode, centerWorld, p.readOnly]);

  // ---- keyboard ----

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || p.readOnly) return;
      const target = e.target as HTMLElement;
      if (target.closest("textarea, input")) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        e.preventDefault();
        if (canvas.edges[selected]) mutate(c => void delete c.edges[selected]);
        else removeNode(selected);
      }
      if (e.key === "Escape") {
        setSelected(null);
        setTool("select");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, editing, removeNode, mutate, canvas.edges, p.readOnly]);

  // ---- edge creation ----

  const startEdge = (nodeId: string, side: NodeSide, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const at = toWorld(e.clientX, e.clientY);
    setEdgeDraft({ from: nodeId, side, x: at.x, y: at.y });
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointerup", onUp);
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("[data-node-id]");
      const toId = el?.getAttribute("data-node-id");
      setEdgeDraft(null);
      if (!toId || toId === nodeId) return;
      const from = canvasRef.current.nodes[nodeId];
      const to = canvasRef.current.nodes[toId];
      if (!from || !to) return;
      const toSide = nearestSide(to, toWorld(ev.clientX, ev.clientY));
      mutate(c => {
        const id = newCanvasId();
        c.edges[id] = { id, fromNode: nodeId, fromSide: side, toNode: toId, toSide, toEnd: "arrow" };
      });
    };
    window.addEventListener("pointerup", onUp);
  };

  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;

  // ---- image toolbar button ----

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

  const nodes = useMemo(
    () => Object.values(canvas.nodes).sort((a, b) => (a.z ?? 0) - (b.z ?? 0) || a.id.localeCompare(b.id)),
    [canvas.nodes]
  );

  return (
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
            readOnly={p.readOnly}
            toWorld={toWorld}
            onSelect={() => {
              setSelected(node.id);
              bringToFront(node.id);
            }}
            onHover={h => setHovered(h ? node.id : null)}
            onEdit={() => setEditing(node.id)}
            onDoneEditing={() => setEditing(null)}
            onNavigate={p.onNavigate}
            mutate={mutate}
            startEdge={startEdge}
          />
        ))}
      </div>

      {!p.readOnly && (
        <div className="canvas-toolbar">
          <ToolButton active={tool === "select"} title="Select & pan (Esc)" onClick={() => setTool("select")}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 3l7 17 2.6-7.4L21 10z" /></svg>
          </ToolButton>
          <ToolButton active={tool === "note"} title="Note — or double-click the canvas" onClick={() => setTool("note")}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16v10l-6 6H4z" /><path d="M14 20v-6h6" /></svg>
          </ToolButton>
          <ToolButton active={tool === "page"} title="Embed a page from this workspace" onClick={() => setTool("page")}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
          </ToolButton>
          <ToolButton active={tool === "link"} title="Link card" onClick={() => setTool("link")}>
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
  );
}

function ToolButton(p: { active: boolean; title: string; onClick(): void; children: React.ReactNode }) {
  return (
    <button className={"canvas-tool" + (p.active ? " canvas-tool--active" : "")} title={p.title} onClick={p.onClick}>
      {p.children}
    </button>
  );
}

// ---------- nodes ----------

interface NodeViewProps {
  node: CanvasNode;
  pages: PageMeta[];
  scale: number;
  selected: boolean;
  hovered: boolean;
  editing: boolean;
  readOnly: boolean;
  toWorld(x: number, y: number): { x: number; y: number };
  onSelect(): void;
  onHover(h: boolean): void;
  onEdit(): void;
  onDoneEditing(): void;
  onNavigate(id: string): void;
  mutate(fn: (c: CanvasData) => void): void;
  startEdge(nodeId: string, side: NodeSide, e: React.PointerEvent): void;
}

function NodeView(p: NodeViewProps) {
  const { node } = p;
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
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
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
  const style: React.CSSProperties = {
    left: node.x,
    top: node.y,
    width: node.width,
    height: node.height,
    ...(preset ? { background: preset.bg, borderColor: preset.fg } : {}),
    ...(node.color?.startsWith("#") ? { background: `${node.color}22`, borderColor: node.color } : {}),
  };

  const showAnchors = (p.selected || p.hovered) && !p.readOnly && !p.editing;

  return (
    <div
      className={
        "canvas-node" +
        ` canvas-node--${node.type}` +
        (p.selected ? " canvas-node--selected" : "") +
        (node.type === "group" ? " canvas-node--bg" : "")
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
        if (p.readOnly) return;
        if (node.type === "text" || node.type === "link" || node.type === "group") p.onEdit();
      }}
    >
      <NodeContent {...p} />
      {p.selected && !p.readOnly && (
        <>
          <div
            className="canvas-resize"
            onPointerDown={e => {
              e.stopPropagation();
              resize.current = { px: e.clientX, py: e.clientY, w: node.width, h: node.height };
              try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
            }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
          <ColorDots node={node} mutate={p.mutate} />
        </>
      )}
      {showAnchors &&
        (["top", "right", "bottom", "left"] as NodeSide[]).map(side => (
          <div key={side} className={`canvas-anchor canvas-anchor--${side}`} onPointerDown={e => p.startEdge(node.id, side, e)} />
        ))}
    </div>
  );
}

function NodeContent(p: NodeViewProps) {
  const { node } = p;
  if (node.type === "text") {
    if (p.editing) {
      return (
        <textarea
          className="canvas-node-edit"
          autoFocus
          defaultValue={node.text}
          onBlur={e => {
            const text = e.target.value;
            p.mutate(c => {
              const n = c.nodes[node.id];
              if (n && n.type === "text") n.text = text;
            });
            p.onDoneEditing();
          }}
          onKeyDown={e => {
            if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) (e.target as HTMLTextAreaElement).blur();
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
    const page = p.pages.find(pg => pg.slug === slug);
    return (
      <div className="canvas-embed">
        <div className="canvas-embed-head">
          <span className="canvas-embed-title" onDoubleClick={() => page && p.onNavigate(page.id)} title="Double-click to open">
            {page ? page.title || "Untitled" : slug}
            <span className="sidebar-page-ext">.md</span>
          </span>
          {p.selected && !p.readOnly && (
            <select
              className="canvas-embed-pick"
              value={slug}
              onChange={e =>
                p.mutate(c => {
                  const n = c.nodes[node.id];
                  if (n && n.type === "file") n.file = `${e.target.value}.md`;
                })
              }
            >
              {p.pages
                .filter(pg => pg.kind === "markdown")
                .map(pg => (
                  <option key={pg.id} value={pg.slug}>
                    {pg.title || "Untitled"}
                  </option>
                ))}
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
        <input
          className="canvas-node-edit canvas-link-edit"
          autoFocus
          defaultValue={node.url}
          onBlur={e => {
            const url = e.target.value.trim();
            p.mutate(c => {
              const n = c.nodes[node.id];
              if (n && n.type === "link" && url) n.url = url;
            });
            p.onDoneEditing();
          }}
          onKeyDown={e => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      );
    }
    return (
      <a className="canvas-link" href={node.url} target="_blank" rel="noreferrer" title={node.url}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></svg>
        <span>{node.url.replace(/^https?:\/\//, "")}</span>
      </a>
    );
  }

  // group
  if (p.editing) {
    return (
      <input
        className="canvas-node-edit canvas-group-edit"
        autoFocus
        defaultValue={node.label ?? ""}
        onBlur={e => {
          const label = e.target.value;
          p.mutate(c => {
            const n = c.nodes[node.id];
            if (n && n.type === "group") n.label = label;
          });
          p.onDoneEditing();
        }}
        onKeyDown={e => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
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
  draft: { from: string; side: NodeSide; x: number; y: number } | null;
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
          return <path className="canvas-edge-line canvas-edge--draft" d={edgePath(a, p.draft.side, { x: p.draft.x, y: p.draft.y }, "left")} markerEnd="url(#canvas-arrow)" />;
        })()}
    </svg>
  );
}
