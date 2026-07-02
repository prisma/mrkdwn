import { useEffect, useState } from "react";

interface ModalProps {
  open: boolean;
  /** the page this invite targets */
  pageId: string;
  pageTitle: string;
  onClose(): void;
}

export function InviteAgentModal(p: ModalProps) {
  const [snippet, setSnippet] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!p.open) return;
    setCopied(false);
    setSnippet("");
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/agent-setup?page=${encodeURIComponent(p.pageId)}`);
        if (res.ok && alive) setSnippet(await res.text());
      } catch {}
    })();
    return () => {
      alive = false;
    };
  }, [p.open, p.pageId]);

  if (!p.open) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
    } catch {
      // fallback for clipboard-restricted contexts
      const ta = document.createElement("textarea");
      ta.value = snippet;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="modal-overlay" onMouseDown={e => e.target === e.currentTarget && p.onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>Invite an agent to “{p.pageTitle || "Untitled"}”</h2>
          <button className="iconbtn" onClick={p.onClose} title="Close">
            ✕
          </button>
        </div>

        <p className="modal-sub">
          Paste this into Claude Code, Codex, or any agent with shell access. The invite targets this page; the
          agent introduces itself with its own name and handle, reads the page for anything already waiting for
          it, and its edits, comments and cursor show up here live.
        </p>

        <pre className="snippet">{snippet || "…"}</pre>

        <div className="modal-actions">
          <a className="linkbtn" href="/skill.md" target="_blank" rel="noreferrer">
            View the full agent skill ↗
          </a>
          <div className="modal-spacer" />
          <button className="btn btn--primary" onClick={copy} disabled={!snippet}>
            {copied ? "Copied ✓" : "Copy invite"}
          </button>
        </div>

        <p className="modal-note">The invite contains this workspace's access token — share it only with agents you trust.</p>
      </div>
    </div>
  );
}
