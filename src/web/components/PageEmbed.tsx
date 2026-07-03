/**
 * Live page embeds inside markdown documents: a line containing only
 * `![[page-slug]]` renders the referenced page as a block below it, fixed
 * to the markdown content width.
 *
 * - markdown pages render like their canvas tiles (scrollable, read-only)
 * - html pages render their sandboxed iframe scaled to the content width
 * - canvas pages render a static thumbnail of the whole board
 *
 * The blocks live inside CodeMirror block widgets, so `usePageEmbeds`
 * hands the editor a mount function: it creates a React root per widget
 * and re-renders all of them when the page registry changes (renames).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RepoContext, useDocument, useRepo } from "@automerge/automerge-repo-react-hooks";
import type { Repo } from "@automerge/automerge-repo/slim";
import type { MrkdwnDoc, PageMeta } from "../../shared/types";
import { CANVAS_PRESETS, type CanvasData, type CanvasNode } from "../../shared/canvas";
import { anchorPoint, defaultSides, edgePath } from "../canvas/geometry";
import { renderMarkdown } from "../canvas/md";
import { HTML_SANDBOX, htmlRenderSize } from "../../shared/html";
import { pageExt } from "./Sidebar";

export type MountEmbed = (el: HTMLElement, slug: string) => () => void;

/** One mount function per editor; re-renders every mounted embed when the
 * page registry (titles, slugs, kinds) changes. */
export function usePageEmbeds(pages: PageMeta[], onNavigate: (id: string) => void): MountEmbed {
  const repo = useRepo();
  const roots = useRef(new Map<Root, string>());
  const pagesRef = useRef(pages);
  const navRef = useRef(onNavigate);
  pagesRef.current = pages;
  navRef.current = onNavigate;

  const renderInto = useCallback(
    (root: Root, slug: string) => {
      root.render(
        <RepoContext.Provider value={repo as Repo}>
          <PageEmbedBlock slug={slug} pages={pagesRef.current} onNavigate={id => navRef.current(id)} />
        </RepoContext.Provider>
      );
    },
    [repo]
  );

  useEffect(() => {
    for (const [root, slug] of roots.current) renderInto(root, slug);
  }, [pages, renderInto]);

  return useCallback(
    (el, slug) => {
      const root = createRoot(el);
      roots.current.set(root, slug);
      renderInto(root, slug);
      return () => {
        roots.current.delete(root);
        // widgets are destroyed during editor updates — unmount off-cycle
        setTimeout(() => root.unmount(), 0);
      };
    },
    [renderInto]
  );
}

function PageEmbedBlock(p: { slug: string; pages: PageMeta[]; onNavigate(id: string): void }) {
  const page = p.pages.find(pg => pg.slug === p.slug);
  if (!page) {
    return <div className="md-embed md-embed--missing">page “{p.slug}” not found</div>;
  }
  return (
    <div className="md-embed">
      <div className="md-embed-head">
        <span className="md-embed-title">
          {page.title || "Untitled"}
          <span className="sidebar-page-ext">.{pageExt(page.kind)}</span>
        </span>
        <button className="linkbtn" onClick={() => p.onNavigate(page.id)}>
          Open ↗
        </button>
      </div>
      <EmbedBody page={page} onNavigate={p.onNavigate} />
    </div>
  );
}

function EmbedBody(p: { page: PageMeta; onNavigate(id: string): void }) {
  const [doc] = useDocument<MrkdwnDoc>(p.page.automergeUrl as never, { suspense: false });
  if (!doc) return <div className="md-embed-loading">loading…</div>;
  if (p.page.kind === "html") return <HtmlBody html={doc.content} />;
  if (p.page.kind === "canvas")
    return <CanvasThumb canvas={doc.canvas ?? { nodes: {}, edges: {} }} onOpen={() => p.onNavigate(p.page.id)} />;
  return <div className="canvas-md md-embed-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(doc.content) }} />;
}

/** The html page's iframe, scaled so the declared width fills the content
 * column; height follows the declared aspect. Interactive. */
function HtmlBody(p: { html: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [srcdoc, setSrcdoc] = useState(p.html);
  useEffect(() => {
    const t = setTimeout(() => setSrcdoc(p.html), 300);
    return () => clearTimeout(t);
  }, [p.html]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const compute = () => el.clientWidth > 40 && setWidth(el.clientWidth);
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const size = htmlRenderSize(srcdoc);
  const scale = width > 0 ? Math.min(1, width / size.width) : 0;
  return (
    <div ref={wrapRef} className="md-embed-html" style={{ height: Math.round(size.height * scale) || 120 }}>
      {scale > 0 && (
        <iframe
          className="html-frame"
          sandbox={HTML_SANDBOX}
          srcDoc={srcdoc}
          title="embedded html page"
          style={{
            width: size.width,
            height: size.height,
            transform: `scale(${scale})`,
            marginLeft: Math.max(0, (width - size.width * scale) / 2),
          }}
        />
      )}
    </div>
  );
}

const THUMB_MAX_H = 420;
const THUMB_PAD = 40;

/** A static, whole-board rendering of a canvas page — click to open. */
function CanvasThumb(p: { canvas: CanvasData; onOpen(): void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const compute = () => el.clientWidth > 40 && setWidth(el.clientWidth);
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const nodes = Object.values(p.canvas.nodes);
  const edges = Object.values(p.canvas.edges);

  let body: React.ReactNode;
  if (nodes.length === 0) {
    body = <div className="md-embed-loading">empty canvas</div>;
  } else if (width > 0) {
    const minX = Math.min(...nodes.map(n => n.x)) - THUMB_PAD;
    const minY = Math.min(...nodes.map(n => n.y)) - THUMB_PAD;
    const maxX = Math.max(...nodes.map(n => n.x + n.width)) + THUMB_PAD;
    const maxY = Math.max(...nodes.map(n => n.y + n.height)) + THUMB_PAD;
    const scale = Math.min(width / (maxX - minX), THUMB_MAX_H / (maxY - minY), 1);
    const h = Math.round((maxY - minY) * scale);
    const sorted = [...nodes].sort(
      (a, b) =>
        (a.type === "group" ? 0 : 1) - (b.type === "group" ? 0 : 1) || (a.z ?? 0) - (b.z ?? 0)
    );
    body = (
      <div className="md-embed-canvas" style={{ height: h }}>
        <div
          className="md-embed-canvas-world"
          style={{
            transform: `scale(${scale})`,
            left: Math.max(0, (width - (maxX - minX) * scale) / 2),
            width: maxX - minX,
            height: maxY - minY,
          }}
        >
          <svg className="canvas-edges">
            {edges.map(edge => {
              const from = p.canvas.nodes[edge.fromNode];
              const to = p.canvas.nodes[edge.toNode];
              if (!from || !to) return null;
              const sides = defaultSides(from, to);
              const a = anchorPoint(offset(from, minX, minY), edge.fromSide ?? sides.fromSide);
              const b = anchorPoint(offset(to, minX, minY), edge.toSide ?? sides.toSide);
              const stroke = edge.color ? (CANVAS_PRESETS[edge.color]?.fg ?? edge.color) : "var(--canvas-edge)";
              return (
                <path
                  key={edge.id}
                  className="canvas-edge-line"
                  d={edgePath(a, edge.fromSide ?? sides.fromSide, b, edge.toSide ?? sides.toSide)}
                  style={{ stroke }}
                />
              );
            })}
          </svg>
          {sorted.map(node => (
            <ThumbNode key={node.id} node={offset(node, minX, minY)} />
          ))}
        </div>
      </div>
    );
  } else {
    body = <div className="md-embed-loading">…</div>;
  }

  return (
    <div ref={wrapRef} onClick={p.onOpen} title="Open canvas" style={{ cursor: "pointer" }}>
      {body}
    </div>
  );
}

function offset(node: CanvasNode, dx: number, dy: number): CanvasNode {
  return { ...node, x: node.x - dx, y: node.y - dy };
}

function ThumbNode({ node }: { node: CanvasNode }) {
  const preset = node.color ? CANVAS_PRESETS[node.color] : undefined;
  const base: React.CSSProperties = { left: node.x, top: node.y, width: node.width, height: node.height };

  if (node.type === "group") {
    return (
      <div
        className="md-thumb-node md-thumb-frame"
        style={{
          ...base,
          ...(preset ? { background: `${preset.bg}73`, borderColor: `${preset.fg}66` } : {}),
        }}
      >
        {node.label && <span style={preset ? { color: preset.fg } : undefined}>{node.label}</span>}
      </div>
    );
  }
  if (node.type === "text") {
    const shape = node.shape;
    if (shape === "diamond") {
      return (
        <div className="md-thumb-node md-thumb-shape" style={{ ...base, background: "transparent", border: "none" }}>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
            <path
              d="M50 1 L99 50 L50 99 L1 50 Z"
              fill={preset?.bg ?? "var(--bg-soft)"}
              stroke={preset?.fg ?? "var(--border-strong)"}
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <div className="canvas-md md-thumb-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(node.text) }} />
        </div>
      );
    }
    return (
      <div
        className={"md-thumb-node" + (shape ? " md-thumb-shape" : "")}
        style={{
          ...base,
          ...(preset ? { background: preset.bg, borderColor: preset.fg } : {}),
          ...(shape === "ellipse" ? { borderRadius: "50%" } : {}),
        }}
      >
        <div className="canvas-md md-thumb-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(node.text) }} />
      </div>
    );
  }
  if (node.type === "file") {
    if (node.file.startsWith("/api/images/")) {
      return <img className="md-thumb-node md-thumb-img" style={base} src={`${node.file}?w=640`} alt="" draggable={false} />;
    }
    return (
      <div className="md-thumb-node md-thumb-file" style={base}>
        <span>{node.file}</span>
      </div>
    );
  }
  // link
  return (
    <div className="md-thumb-node md-thumb-link" style={base}>
      <span>{node.url.replace(/^https?:\/\//, "") || "link"}</span>
    </div>
  );
}
