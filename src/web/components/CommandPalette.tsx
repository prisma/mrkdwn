import { useEffect, useMemo, useRef, useState } from "react";
import type { PageMeta } from "../../shared/types";

interface PaletteProps {
  pages: PageMeta[];
  currentPageId: string;
  onNavigate(id: string): void;
  onCreatePage(title: string): void;
  onClose(): void;
}

/** ⌘K: search page titles and jump. Arrow keys + Enter, Esc closes. The last
 * row is always “New page” — with a query it creates a page with that title,
 * so creating works whether or not pages match. */
export function CommandPalette(p: PaletteProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () => (q ? p.pages.filter(page => (page.title || "Untitled").toLowerCase().includes(q)) : p.pages),
    [p.pages, q]
  );
  // the create row sits after the matches, at index matches.length
  const createIndex = matches.length;
  const title = query.trim();

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setSelected(0), [q]);

  const pick = (page: PageMeta) => {
    p.onNavigate(page.id);
    p.onClose();
  };

  const create = () => {
    p.onCreatePage(title);
    p.onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") p.onClose();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected(s => Math.min(s + 1, createIndex));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected(s => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = matches[selected];
      if (hit) pick(hit);
      else create();
    }
  };

  return (
    <div className="modal-overlay palette-overlay" onMouseDown={e => e.target === e.currentTarget && p.onClose()}>
      <div className="palette" onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Jump to a page…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <div className="palette-results">
          {matches.map((page, i) => (
            <button
              key={page.id}
              className={
                "palette-item" +
                (i === selected ? " palette-item--selected" : "") +
                (page.id === p.currentPageId ? " palette-item--current" : "")
              }
              onMouseEnter={() => setSelected(i)}
              onClick={() => pick(page)}
            >
              <span className="palette-item-title">{page.title || "Untitled"}</span>
              <span className="palette-item-slug">@{page.slug}</span>
            </button>
          ))}
          <button
            className={
              "palette-item palette-item--create" + (selected === createIndex ? " palette-item--selected" : "")
            }
            onMouseEnter={() => setSelected(createIndex)}
            onClick={create}
          >
            <span className="palette-item-title">
              <span className="palette-create-plus">+</span>
              {title ? (
                <>
                  New page: <strong>“{title}”</strong>
                </>
              ) : (
                "New page"
              )}
            </span>
            <span className="palette-item-slug">↵ create</span>
          </button>
        </div>
        <div className="palette-hint">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
