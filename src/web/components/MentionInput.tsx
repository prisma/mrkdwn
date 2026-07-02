/** Comment textarea with an @mention dropdown: type `@cl` → pick @claude.
 * Same option set as the doc editor (agents, present humans, pages); the
 * pure matching lives in mentionQuery.ts. */
import { useEffect, useRef, useState } from "react";
import type { MentionOption } from "../editor/mentionsExt";
import { activeMentionToken, filterMentions, type MentionToken } from "./mentionQuery";

interface Props {
  value: string;
  onChange(v: string): void;
  onSubmit(): void;
  onCancel(): void;
  options: MentionOption[];
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
}

export function MentionInput(p: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [token, setToken] = useState<MentionToken | null>(null);
  const [sel, setSel] = useState(0);

  const matches = token ? filterMentions(p.options, token.query) : [];
  const open = matches.length > 0;
  const selIdx = Math.min(sel, Math.max(0, matches.length - 1));

  /** re-derive the token from the live caret (change, click, arrow moves) */
  const sync = () => {
    const el = ref.current;
    if (!el) return;
    const t = el.selectionStart === el.selectionEnd ? activeMentionToken(el.value, el.selectionStart) : null;
    setToken(prev => {
      if (prev?.from !== t?.from) setSel(0);
      return t;
    });
  };

  useEffect(() => {
    menuRef.current?.querySelector(".mention-menu-item--active")?.scrollIntoView({ block: "nearest" });
  }, [selIdx, open]);

  const apply = (option: MentionOption) => {
    const el = ref.current;
    if (!el || !token) return;
    el.setRangeText(`@${option.handle} `, token.from, el.selectionStart, "end");
    setToken(null);
    p.onChange(el.value);
    el.focus();
  };

  return (
    <div className="mention-wrap">
      <textarea
        ref={ref}
        className="comment-input"
        placeholder={p.placeholder}
        value={p.value}
        rows={p.rows ?? 3}
        autoFocus={p.autoFocus}
        onChange={e => {
          p.onChange(e.target.value);
          sync();
        }}
        onClick={sync}
        onKeyUp={e => {
          if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") sync();
        }}
        onBlur={() => setToken(null)}
        onKeyDown={e => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            p.onSubmit();
            return;
          }
          if (open) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((selIdx + 1) % matches.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((selIdx - 1 + matches.length) % matches.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              apply(matches[selIdx]!);
              return;
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              setToken(null);
              return;
            }
          }
          if (e.key === "Escape") p.onCancel();
        }}
      />
      {open && (
        <div className="mention-menu" ref={menuRef} role="listbox">
          {matches.map((o, i) => (
            <button
              key={o.kind + o.handle}
              className={"mention-menu-item" + (i === selIdx ? " mention-menu-item--active" : "")}
              role="option"
              aria-selected={i === selIdx}
              onMouseDown={e => {
                e.preventDefault(); // keep focus in the textarea
                apply(o);
              }}
              onMouseEnter={() => setSel(i)}
            >
              <span className="mention-menu-handle">@{o.handle}</span>
              <span className="mention-menu-detail">{o.detail}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
