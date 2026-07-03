import { useState } from "react";
import type { PageMeta } from "../../shared/types";

interface SidebarProps {
  pages: PageMeta[];
  currentPageId: string;
  collapsed: boolean;
  onNavigate(id: string): void;
  onCreatePage(): void;
  onCreateCanvas(): void;
  onCreateHtml(): void;
}

export function pageExt(kind: PageMeta["kind"]): string {
  return kind === "canvas" ? "canvas" : kind === "html" ? "html" : "md";
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
      </div>
    </nav>
  );
}
