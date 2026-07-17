import { useRef, useState } from "react";
import type { PageMeta } from "../../shared/types";
import { PAGE_DRAG_MIME } from "../editor/embedExt";

interface SidebarProps {
  pages: PageMeta[];
  currentPageId: string;
  collapsed: boolean;
  onNavigate(id: string): void;
  onCreatePage(): void;
  onCreateCanvas(): void;
  onCreateHtml(): void;
  onCreateHyperframes(): void;
  onUploadHyperframes(file: File): void;
}

export function pageExt(kind: PageMeta["kind"]): string {
  return kind === "canvas" ? "canvas" : kind === "html" ? "html" : kind === "hyperframes" ? "hf" : "md";
}

/** Collapsible page navigation with client-side title filtering. */
export function Sidebar(p: SidebarProps) {
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const visible = q ? p.pages.filter(page => (page.title || "Untitled").toLowerCase().includes(q)) : p.pages;

  return (
    <nav className={"sidebar" + (p.collapsed ? " sidebar--collapsed" : "")} aria-label="Pages">
      <div className="sidebar-inner">
        <input
          className="sidebar-filter"
          placeholder="Filter pages…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <div className="sidebar-pages">
          {visible.map(page => (
            <button
              key={page.id}
              className={"sidebar-page" + (page.id === p.currentPageId ? " sidebar-page--active" : "")}
              onClick={() => p.onNavigate(page.id)}
              title={`${page.title || "Untitled"}.${pageExt(page.kind)}`}
              draggable
              onDragStart={e => {
                // drop into a markdown page to embed it (see editor/embedExt)
                e.dataTransfer.setData(PAGE_DRAG_MIME, page.slug);
                e.dataTransfer.setData("text/plain", `![[${page.slug}]]`);
                e.dataTransfer.effectAllowed = "copy";
              }}
            >
              {page.kind === "canvas" ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="8" height="8" rx="1.5" />
                  <rect x="13" y="13" width="8" height="8" rx="1.5" />
                  <path d="M11 7h4m-8 8v-4" />
                </svg>
              ) : page.kind === "html" ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="16 18 22 12 16 6" />
                  <polyline points="8 6 2 12 8 18" />
                </svg>
              ) : page.kind === "hyperframes" ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <path d="m10 9 5 3-5 3z" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              )}
              <span className="sidebar-page-title">
                {page.title || "Untitled"}
                <span className="sidebar-page-ext">.{pageExt(page.kind)}</span>
              </span>
            </button>
          ))}
          {visible.length === 0 && <div className="sidebar-empty">No pages match “{filter}”</div>}
        </div>
        <button className="sidebar-new" onClick={p.onCreatePage}>
          <span className="sidebar-new-plus">+</span> New page
        </button>
        <button className="sidebar-new" onClick={p.onCreateCanvas}>
          <span className="sidebar-new-plus">+</span> New canvas
        </button>
        <button className="sidebar-new" onClick={p.onCreateHtml}>
          <span className="sidebar-new-plus">+</span> New HTML page
        </button>
        <button className="sidebar-new" onClick={p.onCreateHyperframes}>
          <span className="sidebar-new-plus">+</span> New video
        </button>
        <UploadButton onFile={p.onUploadHyperframes} />
      </div>
    </nav>
  );
}

/** "Upload video project" — a HyperFrames project zip → new hyperframes page. */
function UploadButton(p: { onFile(file: File): void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className="sidebar-new" onClick={() => inputRef.current?.click()} title="Import a HyperFrames project (.zip)">
        <span className="sidebar-new-plus">↑</span> Upload video project
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip"
        style={{ display: "none" }}
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) p.onFile(file);
          e.target.value = "";
        }}
      />
    </>
  );
}
