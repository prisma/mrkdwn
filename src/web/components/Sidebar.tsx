import { useState } from "react";
import type { PageMeta } from "../../shared/types";

interface SidebarProps {
  pages: PageMeta[];
  currentPageId: string;
  collapsed: boolean;
  onNavigate(id: string): void;
  onCreatePage(): void;
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
              title={page.title || "Untitled"}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span className="sidebar-page-title">{page.title || "Untitled"}</span>
            </button>
          ))}
          {visible.length === 0 && <div className="sidebar-empty">No pages match “{filter}”</div>}
        </div>
        <button className="sidebar-new" onClick={p.onCreatePage}>
          <span className="sidebar-new-plus">+</span> New page
        </button>
      </div>
    </nav>
  );
}
