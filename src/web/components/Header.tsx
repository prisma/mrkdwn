import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentStatus, Author } from "../../shared/types";
import type { Peer } from "../app/presence";
import { colorFor, initials } from "../../shared/identity";

interface HeaderProps {
  identity: Author;
  onRename(name: string): void;
  peers: Peer[];
  agents: AgentStatus[];
  connected: boolean;
  /** drives the topbar dot: green = durable in S3, amber = unpersisted
   * changes, red = connection down (editing locked) */
  durability: "saved" | "pending" | "offline";
  openComments: number;
  commentsOpen: boolean;
  onToggleComments(): void;
  onInviteAgent(): void;
  theme: "light" | "dark";
  onToggleTheme(): void;
  sourceMode: boolean;
  onToggleSource(): void;
  workspace: { handle: string; name: string };
  sidebarOpen: boolean;
  onToggleSidebar(): void;
  /** click an avatar → highlight contributions + filter comments */
  onSpotlight(author: Author): void;
  spotlightId: string | null;
  /** fork this page into a new page (full history + lineage) */
  onFork(): void;
}

/** Claude-spark silhouette — the avatar shape that says "agent". */
function SparkAvatar(p: { color: string; label: string; title: string; muted: boolean; active: boolean; badge?: number; onClick(): void }) {
  return (
    <button
      className={"avatar avatar--agent" + (p.muted ? " avatar--offline" : "") + (p.active ? " avatar--spotlit" : "")}
      title={p.title}
      onClick={p.onClick}
    >
      <svg viewBox="0 0 40 40" width="26" height="26" aria-hidden="true">
        <path
          fill={p.color}
          d="M20 0.5 L23.6 6.5 L29.8 3.1 L29.9 10.1 L36.9 10.3 L33.5 16.4 L39.5 20 L33.5 23.6 L36.9 29.7 L29.9 29.9 L29.8 36.9 L23.6 33.5 L20 39.5 L16.4 33.5 L10.3 36.9 L10.1 29.9 L3.1 29.8 L6.5 23.6 L0.5 20 L6.5 16.4 L3.1 10.2 L10.1 10.1 L10.2 3.1 L16.4 6.5 Z"
        />
        <text x="20" y="21.5" textAnchor="middle" dominantBaseline="middle" className="avatar-agent-label">
          {p.label}
        </text>
      </svg>
      {p.badge ? <span className="avatar-badge">{p.badge}</span> : null}
    </button>
  );
}

/** Breadcrumb workspace switcher: current workspace + the list of available
 * ones (just the public workspace while signed out) + "New workspace", which
 * requires an account. */
function WorkspaceCrumb(p: { workspace: { handle: string; name: string } }) {
  const [open, setOpen] = useState(false);
  const [accountPrompt, setAccountPrompt] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="ws-crumb" ref={rootRef}>
      <span className="crumb-sep">/</span>
      <button
        className={"ws-crumb-btn" + (open ? " ws-crumb-btn--open" : "")}
        onClick={() => setOpen(o => !o)}
        title="Switch workspace"
      >
        {p.workspace.name}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="ws-menu">
          <div className="ws-menu-label">Workspaces</div>
          <button className="ws-menu-item ws-menu-item--current" onClick={() => setOpen(false)}>
            <span className="ws-menu-name">{p.workspace.name}</span>
            <span className="ws-menu-handle">/{p.workspace.handle}</span>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </button>
          <div className="ws-menu-divider" />
          <button
            className="ws-menu-item ws-menu-new"
            onClick={() => {
              setOpen(false);
              setAccountPrompt(true);
            }}
          >
            <span className="ws-menu-plus">+</span> New workspace
          </button>
        </div>
      )}

      {accountPrompt &&
        /* portal: the topbar's backdrop-filter turns it into the containing
         * block for fixed descendants, trapping the overlay in the header */
        createPortal(
          <div className="modal-overlay" onMouseDown={e => e.target === e.currentTarget && setAccountPrompt(false)}>
            <div className="modal modal--narrow">
              <div className="modal-head">
                <h2>Create a workspace</h2>
              </div>
              <p className="modal-sub">
                Workspaces belong to accounts. You're in the public workspace without being signed in — to create a
                workspace of your own, you'll need an account.
              </p>
              <div className="modal-actions">
                <span className="modal-note">Accounts are coming soon.</span>
                <div className="modal-spacer" />
                <button className="btn" onClick={() => setAccountPrompt(false)}>
                  Not now
                </button>
                <button className="btn btn--primary" disabled title="Sign-up isn't available yet">
                  Create account
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

export function Header(p: HeaderProps) {
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(p.identity.name);

  const humanPeers = p.peers.filter(x => x.user.kind === "human" && x.user.id !== p.identity.id);
  const agentPeerIds = new Set(p.peers.filter(x => x.user.kind === "agent").map(x => x.user.id));

  const commitName = () => {
    setEditingName(false);
    p.onRename(nameDraft);
  };

  return (
    <header className="topbar">
      <button
        className={"iconbtn iconbtn--sidebar" + (p.sidebarOpen ? " iconbtn--on" : "")}
        onClick={p.onToggleSidebar}
        title={p.sidebarOpen ? "Hide pages (⌘K to search)" : "Show pages (⌘K to search)"}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="9" y1="3" x2="9" y2="21" />
        </svg>
      </button>

      <div
        className="brand"
        title={
          p.durability === "offline"
            ? "Connection lost — editing is paused until sync resumes"
            : p.durability === "pending"
              ? "Saving… changes not yet durable"
              : "All changes saved durably"
        }
      >
        <span className="brand-name">mrkdwn</span>
        <span className="brand-tld">.xyz</span>
        <span className={`conn-dot conn-dot--${p.durability}`} />
      </div>

      <WorkspaceCrumb workspace={p.workspace} />

      <div className="topbar-spacer" />

      <div className="avatars">
        {p.agents.map(a => {
          const author: Author = {
            id: `agent:${a.handle}`,
            name: a.name ?? a.handle,
            color: colorFor(`agent:${a.handle}`),
            kind: "agent",
          };
          const live = a.online || agentPeerIds.has(author.id);
          return (
            <SparkAvatar
              key={a.handle}
              color={author.color}
              label={initials(author.name)}
              muted={!live}
              active={p.spotlightId === author.id}
              badge={a.pending || undefined}
              title={`${author.name} (@${a.handle}) — ${live ? "online" : "offline"}${a.pending ? ` · ${a.pending} unread mention${a.pending > 1 ? "s" : ""}` : ""} · click to see their contributions`}
              onClick={() => p.onSpotlight(author)}
            />
          );
        })}
        {humanPeers.map(peer => (
          <button
            key={peer.user.id}
            className={"avatar" + (p.spotlightId === peer.user.id ? " avatar--spotlit" : "")}
            style={{ background: peer.user.color }}
            title={`${peer.user.name}${peer.typing ? " — typing…" : ""} · click to see their contributions`}
            onClick={() => p.onSpotlight(peer.user)}
          >
            {initials(peer.user.name)}
          </button>
        ))}
        {editingName ? (
          <input
            className="avatar-rename"
            value={nameDraft}
            autoFocus
            onChange={e => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={e => e.key === "Enter" && commitName()}
          />
        ) : (
          <button
            className={"avatar avatar--you" + (p.connected ? "" : " avatar--offline") + (p.spotlightId === p.identity.id ? " avatar--spotlit" : "")}
            style={{ background: p.identity.color }}
            title={`${p.identity.name} (you) — click for your contributions, double-click to rename`}
            onClick={() => p.onSpotlight(p.identity)}
            onDoubleClick={() => {
              setNameDraft(p.identity.name);
              setEditingName(true);
            }}
          >
            {initials(p.identity.name)}
          </button>
        )}
      </div>

      <button className={"iconbtn" + (p.commentsOpen ? " iconbtn--on" : "")} onClick={p.onToggleComments} title="Comments">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        {p.openComments > 0 && <span className="iconbtn-badge">{p.openComments}</span>}
      </button>

      <button
        className={"iconbtn" + (p.sourceMode ? " iconbtn--on" : "")}
        onClick={p.onToggleSource}
        title={p.sourceMode ? "Hide markdown syntax (Notion-style)" : "Show markdown source"}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      </button>

      <button className="iconbtn" onClick={p.onToggleTheme} title={p.theme === "light" ? "Dark mode" : "Light mode"}>
        {p.theme === "light" ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
          </svg>
        )}
      </button>

      <button
        className="iconbtn"
        onClick={p.onFork}
        title="Fork this page — a new page starting from this one (history included)"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="6" cy="5" r="2.4" />
          <circle cx="18" cy="5" r="2.4" />
          <circle cx="12" cy="19" r="2.4" />
          <path d="M6 7.4v1.1a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7.4M12 11.5v5" />
        </svg>
      </button>

      <button className="btn btn--primary" onClick={() => p.onInviteAgent()}>
        Invite your agent
      </button>
    </header>
  );
}
