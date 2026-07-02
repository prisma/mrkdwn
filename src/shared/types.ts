/** Shared data model. The whole document — text, title, comments — lives in one
 * Automerge doc so everything syncs and merges together. */
import type { CanvasData } from "./canvas";

export type AuthorKind = "human" | "agent";

export interface Author {
  /** stable id: humans get a random local id, agents are `agent:<handle>` */
  id: string;
  name: string;
  color: string;
  kind: AuthorKind;
}

export interface CommentReply {
  id: string;
  author: Author;
  body: string;
  createdAt: number;
}

export interface DocComment {
  id: string;
  author: Author;
  body: string;
  createdAt: number;
  /** Automerge cursors into `content` — they track the range across edits. */
  anchorStart: string;
  anchorEnd: string;
  /** The text that was selected when the comment was created. */
  quote: string;
  resolved: boolean;
  replies: CommentReply[];
}

export interface MrkdwnDoc {
  title: string;
  content: string;
  comments: { [id: string]: DocComment };
  /** Automerge actor id → the author behind it. Each client registers its
   * session actor here so contributions can be attributed to people; agent
   * edits are attributed via change messages instead (see attribution.ts). */
  authors?: { [actorId: string]: Author };
  /** present on canvas pages: JSON Canvas data, CRDT-keyed by id
   * (see shared/canvas.ts for the spec mapping) */
  canvas?: CanvasData;
}

/** Ephemeral presence message, broadcast over the Automerge sync channel. */
export interface PresenceMessage {
  type: "presence";
  user: Author;
  /** Automerge cursors into `content`; null = present but no caret to show. */
  anchor: string | null;
  head: string | null;
  /** true while actively editing — drives the "✏️ writing" hint. */
  typing?: boolean;
  /** sent when a peer leaves so others can drop it immediately */
  gone?: boolean;
  ts: number;
}

export type NotificationKind = "doc-mention" | "comment-mention";

export interface AgentNotification {
  id: string;
  agent: string;
  kind: NotificationKind;
  createdAt: number;
  /** short excerpt around the mention */
  snippet: string;
  /** for comment mentions */
  commentId?: string;
  /** who wrote the mentioning text, when known (comments carry authors) */
  from?: string;
  /** which page the mention lives on (`?page=<id>` on the doc endpoints) */
  page?: { id: string; title: string };
}

export interface AgentStatus {
  handle: string;
  /** display name the agent introduced itself with (X-Agent-Name) */
  name?: string;
  online: boolean;
  lastSeenAt: number | null;
  pending: number;
}

/** Unauthenticated status payload for UI badges. Never include secrets. */
export interface StatusPayload {
  title: string;
  /** automerge url the web client syncs against (the default page) */
  docUrl: string;
  agents: AgentStatus[];
  /** true when the server mirrors docs to S3 — drives the durability dot */
  persistence: boolean;
}

/** One page of a workspace, as served by GET /api/workspace. */
export interface PageMeta {
  id: string;
  title: string;
  slug: string;
  /** "markdown" pages edit as text; "canvas" pages are JSON Canvas boards */
  kind: "markdown" | "canvas";
  /** `/{workspaceHandle}/{id}-{slug}` — the id does the lookup, slug is cosmetic */
  path: string;
  automergeUrl: string;
  updatedAt: number;
}

/** Unauthenticated workspace payload (single public workspace in v1). */
export interface WorkspacePayload {
  workspace: { handle: string; name: string };
  pages: PageMeta[];
}

export const nowId = (prefix: string) =>
  `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
