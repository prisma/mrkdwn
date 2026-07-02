import { useEffect, useRef, useState } from "react";
import type { Author, DocComment, MrkdwnDoc } from "../../shared/types";
import { nowId } from "../../shared/types";
import { scanMentions } from "../../shared/mentions";
import { colorFor, initials } from "../../shared/identity";
import type { MentionOption } from "../editor/mentionsExt";
import { MentionInput } from "./MentionInput";

export interface DraftComment {
  anchorStart: string;
  anchorEnd: string;
  quote: string;
}

export interface PositionedComment {
  comment: DocComment;
  /** current doc position, null when the anchored text is gone */
  pos: number | null;
}

interface PanelProps {
  comments: PositionedComment[];
  identity: Author;
  activeId: string | null;
  onActivate(id: string | null): void;
  onReveal(id: string): void;
  draft: DraftComment | null;
  onSubmitDraft(body: string): void;
  onCancelDraft(): void;
  changeDoc(fn: (d: MrkdwnDoc) => void): void;
  agentHandles: Set<string>;
  /** candidates for the @mention dropdown in comment boxes */
  mentionOptions: MentionOption[];
  /** spotlight filter: only threads by/mentioning this author are shown */
  filter: Author | null;
  onClearFilter(): void;
}

export function CommentsPanel(p: PanelProps) {
  const [showResolved, setShowResolved] = useState(false);
  const open = p.comments.filter(c => !c.comment.resolved);
  const resolved = p.comments.filter(c => c.comment.resolved);
  // a spotlight filter shows the person's whole trail, resolved included
  const shown = showResolved || p.filter ? [...open, ...resolved] : open;

  return (
    <aside className="comments-panel">
      <div className="comments-head">
        <span className="comments-title">Comments</span>
        {resolved.length > 0 && !p.filter && (
          <button className="linkbtn" onClick={() => setShowResolved(s => !s)}>
            {showResolved ? "Hide resolved" : `Resolved (${resolved.length})`}
          </button>
        )}
      </div>

      {p.filter && (
        <div className="comments-filter" style={{ borderColor: p.filter.color }}>
          <span className="comments-filter-dot" style={{ background: p.filter.color }} />
          <span className="comments-filter-label">
            By or mentioning <strong>{p.filter.name}</strong>
          </span>
          <button className="linkbtn" onClick={p.onClearFilter} title="Show all comments">
            ✕
          </button>
        </div>
      )}

      {p.draft && <DraftCard draft={p.draft} onSubmit={p.onSubmitDraft} onCancel={p.onCancelDraft} mentionOptions={p.mentionOptions} />}

      {shown.length === 0 && !p.draft && (
        <div className="comments-empty">
          {p.filter ? (
            <p>
              No comments by or mentioning <strong>{p.filter.name}</strong> on this page.
            </p>
          ) : (
            <>
              <p>No comments yet.</p>
              <p className="comments-empty-hint">Select any text in the doc and hit the 💬 button. Mention @claude to hand the thread to an agent.</p>
            </>
          )}
        </div>
      )}

      {shown.map(pc => (
        <CommentCard
          key={pc.comment.id}
          pc={pc}
          active={p.activeId === pc.comment.id}
          identity={p.identity}
          onActivate={p.onActivate}
          onReveal={p.onReveal}
          changeDoc={p.changeDoc}
          agentHandles={p.agentHandles}
          mentionOptions={p.mentionOptions}
        />
      ))}
    </aside>
  );
}

function DraftCard(p: { draft: DraftComment; onSubmit(body: string): void; onCancel(): void; mentionOptions: MentionOption[] }) {
  const [body, setBody] = useState("");
  const submit = () => body.trim() && p.onSubmit(body.trim());
  return (
    <div className="comment-card comment-card--draft">
      <Quote text={p.draft.quote} />
      <MentionInput
        placeholder="Add a comment… mention @claude to bring in an agent"
        value={body}
        rows={3}
        autoFocus
        options={p.mentionOptions}
        onChange={setBody}
        onSubmit={submit}
        onCancel={p.onCancel}
      />
      <div className="comment-actions">
        <button className="btn btn--primary btn--sm" onClick={submit} disabled={!body.trim()}>
          Comment
        </button>
        <button className="btn btn--sm" onClick={p.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function CommentCard(p: {
  pc: PositionedComment;
  active: boolean;
  identity: Author;
  onActivate(id: string | null): void;
  onReveal(id: string): void;
  changeDoc(fn: (d: MrkdwnDoc) => void): void;
  agentHandles: Set<string>;
  mentionOptions: MentionOption[];
}) {
  const { comment } = p.pc;
  const [replyBody, setReplyBody] = useState("");
  const [replying, setReplying] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (p.active) cardRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [p.active]);

  const sendReply = () => {
    const body = replyBody.trim();
    if (!body) return;
    const reply = { id: nowId("r"), author: p.identity, body, createdAt: Date.now() };
    p.changeDoc(d => {
      d.comments[comment.id]?.replies.push(reply);
    });
    setReplyBody("");
    setReplying(false);
  };

  return (
    <div
      ref={cardRef}
      className={
        "comment-card" + (p.active ? " comment-card--active" : "") + (comment.resolved ? " comment-card--resolved" : "")
      }
      onClick={() => {
        p.onActivate(comment.id);
        if (p.pc.pos !== null) p.onReveal(comment.id);
      }}
    >
      {comment.quote && <Quote text={comment.quote} orphaned={p.pc.pos === null && !comment.resolved} />}
      <Message author={comment.author} body={comment.body} createdAt={comment.createdAt} agentHandles={p.agentHandles} />
      {comment.replies.map(r => (
        <div className="comment-reply" key={r.id}>
          <Message author={r.author} body={r.body} createdAt={r.createdAt} agentHandles={p.agentHandles} />
        </div>
      ))}

      {!comment.resolved && (
        <div className="comment-actions" onClick={e => e.stopPropagation()}>
          {replying ? (
            <div className="comment-replybox">
              <MentionInput
                autoFocus
                rows={2}
                placeholder="Reply… (@claude to ask the agent)"
                value={replyBody}
                options={p.mentionOptions}
                onChange={setReplyBody}
                onSubmit={sendReply}
                onCancel={() => setReplying(false)}
              />
              <div className="comment-actions">
                <button className="btn btn--primary btn--sm" onClick={sendReply} disabled={!replyBody.trim()}>
                  Reply
                </button>
                <button className="btn btn--sm" onClick={() => setReplying(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <button className="linkbtn" onClick={() => setReplying(true)}>
                Reply
              </button>
              <button
                className="linkbtn"
                onClick={() =>
                  p.changeDoc(d => {
                    const c = d.comments[comment.id];
                    if (c) c.resolved = true;
                  })
                }
              >
                ✓ Resolve
              </button>
            </>
          )}
        </div>
      )}
      {comment.resolved && (
        <div className="comment-actions" onClick={e => e.stopPropagation()}>
          <button
            className="linkbtn"
            onClick={() =>
              p.changeDoc(d => {
                const c = d.comments[comment.id];
                if (c) c.resolved = false;
              })
            }
          >
            Reopen
          </button>
        </div>
      )}
    </div>
  );
}

function Quote(p: { text: string; orphaned?: boolean }) {
  const text = p.text.length > 80 ? p.text.slice(0, 80) + "…" : p.text;
  return (
    <div className={"comment-quote" + (p.orphaned ? " comment-quote--orphaned" : "")} title={p.orphaned ? "The quoted text was removed from the doc" : undefined}>
      {text}
    </div>
  );
}

function Message(p: { author: Author; body: string; createdAt: number; agentHandles: Set<string> }) {
  const isAgent = p.author.kind === "agent";
  return (
    <div className="comment-msg">
      <div className="comment-meta">
        <span className="comment-avatar" style={{ background: isAgent ? colorFor(p.author.id) : p.author.color }}>
          {isAgent ? "✳" : initials(p.author.name)}
        </span>
        <span className="comment-author">{p.author.name}</span>
        {isAgent && <span className="comment-agentbadge">agent</span>}
        <span className="comment-time">{timeAgo(p.createdAt)}</span>
      </div>
      <div className="comment-body">{renderMentions(p.body, p.agentHandles)}</div>
    </div>
  );
}

function renderMentions(body: string, agents: Set<string>) {
  const mentions = scanMentions(body);
  if (mentions.length === 0) return body;
  const out: (string | React.ReactElement)[] = [];
  let at = 0;
  mentions.forEach((m, i) => {
    if (m.index > at) out.push(body.slice(at, m.index));
    out.push(
      <span key={i} className={"mention-pill" + (agents.has(m.handle) ? " mention-pill--agent" : "")}>
        {body.slice(m.index, m.end)}
      </span>
    );
    at = m.end;
  });
  if (at < body.length) out.push(body.slice(at));
  return out;
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}
