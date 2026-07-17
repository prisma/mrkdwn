/**
 * Agent-facing REST API. Everything under /api requires the bearer token
 * except GET /api/status (UI badges — no secrets).
 *
 * Editing follows the "exact match" contract agents already know from their
 * editing tools: send the precise text to replace. Ambiguity and misses are
 * 409s with actionable hints. All edits become Automerge splices, so they
 * merge cleanly with concurrent human keystrokes.
 */
import * as A from "@automerge/automerge";
import { tokenMatches, type ServerConfig } from "./config";
import { ApiError } from "./errors";
import { planEdits as planEditOps, indicesOf, type EditOp } from "./edits";
import type { DocHost, PageEntry } from "./repo";
import type { PersistWorker } from "./persist";
import { enqueue, singleSpliceDiff, typeSplices, type TypedSplice } from "./typewriter";
import { CanvasValidationError, canvasToSpec, emptyCanvas, parseSpecCanvas, reconcileCanvas } from "../shared/canvas";
import { HTML_MAX, HTML_MIN, HTML_SIZE_TAG_EXAMPLE, htmlRenderSize, parseHtmlSize, withinHtmlLimits } from "../shared/html";
import { isValidHandle, normalizeHandle, type NotificationCenter } from "./notifications";
import type { ObjectMirror } from "./persist";
import {
  deleteProjectFile,
  handleHyperframesExport,
  handleHyperframesUpload,
  listProjectFiles,
  previewOriginFor,
  readProjectFile,
  writeProjectFile,
  type HyperframesContext,
} from "./hyperframes";
import { hyperframesRenderSize } from "../shared/hyperframes";
import { handleKimiChat } from "./kimi";
import { colorFor } from "../shared/identity";
import {
  nowId,
  type Author,
  type DocComment,
  type MrkdwnDoc,
  type PageMeta,
  type PresenceMessage,
  type StatusPayload,
  type WorkspacePayload,
} from "../shared/types";

export interface ApiContext {
  config: ServerConfig;
  host: DocHost;
  notifications: NotificationCenter;
  persistence?: PersistWorker;
  /** object storage (hyperframes blob assets); shared with persist/images */
  mirror?: ObjectMirror;
}

const hfCtx = (ctx: ApiContext): HyperframesContext => ({
  config: ctx.config,
  host: ctx.host,
  ...(ctx.mirror ? { mirror: ctx.mirror } : {}),
});

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export async function handleApi(req: Request, url: URL, ctx: ApiContext): Promise<Response | undefined> {
  const path = url.pathname;
  if (!path.startsWith("/api/")) return undefined;
  const method = req.method.toUpperCase();

  try {
    // -- unauthenticated: UI badges + the public workspace (v1 permissions
    // are org-level, and the single public workspace is world-editable) --
    // note the `await`s: async handlers must resolve inside this try, or an
    // ApiError thrown after their first await would bypass the catch below
    if (path === "/api/status" && method === "GET") return getStatus(ctx);
    if (path === "/api/workspace" && method === "GET") return getWorkspace(ctx);
    if (path === "/api/pages" && method === "POST") return await postPage(ctx, await body(req));
    if (path === "/api/pages/fork" && method === "POST") return await postFork(ctx, url, await body(req));
    if (path === "/api/hyperframes/upload" && method === "POST")
      return await handleHyperframesUpload(req, url, hfCtx(ctx));
    if (path === "/api/hyperframes/export" && method === "GET")
      return await handleHyperframesExport(resolvePage(ctx, url), hfCtx(ctx));
    // the integrated Kimi agent — invoked from the web UI (public, like page
    // creation: v1 permissions are org-level and the token is world-visible)
    if (path === "/api/kimi/chat" && method === "POST")
      return await handleKimiChat(
        { kimi: ctx.config.kimi, notifications: ctx.notifications },
        resolvePage(ctx, url),
        await body(req)
      );

    requireAuth(req, url, ctx.config);
    const agent = agentHandle(req, url);
    if (agent) ctx.notifications.markSeen(agent, agentName(req));
    const page = resolvePage(ctx, url);

    if (path === "/api/doc" && method === "GET") return getDoc(ctx, page, url);
    if (path === "/api/doc" && method === "PUT") return await putDoc(ctx, page, await body(req), agent);
    if (path === "/api/doc/edits" && method === "POST") return await postEdits(ctx, page, await body(req), agent);
    if (path === "/api/doc/append" && method === "POST") return await postAppend(ctx, page, await body(req), agent);

    if (path === "/api/comments" && method === "GET") return getComments(page, url);
    if (path === "/api/comments" && method === "POST") return await postComment(ctx, page, await body(req), agent);
    const commentAction = path.match(/^\/api\/comments\/([\w-]+)\/(replies|resolve)$/);
    if (commentAction && method === "POST") {
      const [, id, action] = commentAction;
      if (action === "replies") return await postReply(ctx, page, id!, await body(req), agent);
      return postResolve(page, id!, agent);
    }

    if (path === "/api/hf/files" && method === "GET") return json(listProjectFiles(page));
    if (path === "/api/hf/file" && method === "GET") return getHfFile(page, url);
    if (path === "/api/hf/file" && method === "PUT") return await putHfFile(ctx, page, await body(req), agent);
    if (path === "/api/hf/file" && method === "DELETE") return await deleteHfFile(ctx, page, url, await bodyOrEmpty(req), agent);

    if (path === "/api/notifications" && method === "GET") return await getNotifications(ctx, url, agent);
    if (path === "/api/notifications/ack" && method === "POST") return postAck(ctx, await body(req), agent);
    if (path === "/api/presence" && method === "POST") return postPresence(ctx, page, agent);

    throw new ApiError(404, `no such endpoint: ${method} ${path} — see /skill.md for the API reference`);
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.message }, e.status);
    console.error("[mrkdwn] api error:", e);
    return json({ error: "internal error" }, 500);
  }
}

// ---------- auth & identity ----------

function requireAuth(req: Request, url: URL, config: ServerConfig): void {
  const header = req.headers.get("authorization");
  const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1] ?? url.searchParams.get("token");
  if (!tokenMatches(bearer ?? null, config.state.agentToken))
    throw new ApiError(401, "missing or invalid token — send `Authorization: Bearer <token>` from your invite snippet");
}

function agentHandle(req: Request, url: URL): string | null {
  const raw = req.headers.get("x-agent") ?? url.searchParams.get("agent");
  if (!raw) return null;
  const handle = normalizeHandle(raw);
  if (!isValidHandle(handle)) throw new ApiError(400, `invalid agent handle: ${raw}`);
  return handle;
}

/** Agents introduce themselves with `X-Agent-Name: <display name>`. */
function agentName(req: Request): string | undefined {
  const raw = req.headers.get("x-agent-name")?.trim();
  return raw ? raw.slice(0, 40) : undefined;
}

/** Tag server-applied changes with the acting agent — every agent shares the
 * server's Automerge actor, so attribution rides on the change message. */
function changeOptions(agent: string | null): { message?: string } {
  return agent ? { message: JSON.stringify({ agent }) } : {};
}

function requireAgent(agent: string | null): string {
  if (!agent)
    throw new ApiError(400, "identify yourself: send an `X-Agent: <handle>` header (e.g. X-Agent: claude)");
  return agent;
}

/** Like body(), but an absent/empty body is fine (DELETE with ?query). */
async function bodyOrEmpty(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    if (typeof data !== "object" || data === null) throw new Error();
    return data;
  } catch {
    throw new ApiError(400, "request body must be a JSON object (or empty)");
  }
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const data = (await req.json()) as Record<string, unknown>;
    if (typeof data !== "object" || data === null) throw new Error();
    return data;
  } catch {
    throw new ApiError(400, "request body must be a JSON object");
  }
}

function agentAuthor(handle: string, name?: string): Author {
  return { id: `agent:${handle}`, name: name ?? handle, color: colorFor(`agent:${handle}`), kind: "agent" };
}

// ---------- workspace & pages ----------

export function pageMeta(ctx: ApiContext, entry: PageEntry): PageMeta {
  return {
    id: entry.record.id,
    title: entry.record.title,
    slug: entry.record.slug,
    kind: entry.record.kind ?? "markdown",
    path: ctx.host.pagePath(entry),
    automergeUrl: entry.record.automergeUrl,
    updatedAt: entry.record.updatedAt,
    ...(entry.record.forkedFromId ? { forkedFromId: entry.record.forkedFromId } : {}),
  };
}

function getWorkspace(ctx: ApiContext): Response {
  const payload: WorkspacePayload = {
    workspace: { handle: ctx.host.workspace.handle, name: ctx.host.workspace.name },
    pages: ctx.host.pages().map(e => pageMeta(ctx, e)),
  };
  return json(payload);
}

async function postPage(ctx: ApiContext, data: Record<string, unknown>): Promise<Response> {
  const title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : "Untitled";
  const kinds = ["markdown", "canvas", "html", "hyperframes"] as const;
  if (data.kind !== undefined && !kinds.includes(data.kind as never))
    throw new ApiError(400, `kind must be "markdown", "canvas", "html", or "hyperframes"`);
  const kind = kinds.find(k => k === data.kind && k !== "markdown");
  const entry = await ctx.host.createPage(title, kind);
  return json({ ok: true, page: pageMeta(ctx, entry) }, 201);
}

/** Fork any page: a NEW document (fresh id, slug, collaborators) initialized
 * from the source's full history. Lineage is recorded; blob assets are
 * content-addressed so a hyperframes fork shares them without copying.
 * Public like POST /api/pages — v1 permissions are org-level. */
async function postFork(ctx: ApiContext, url: URL, data: Record<string, unknown>): Promise<Response> {
  const sourceId = typeof data.page === "string" ? data.page : url.searchParams.get("page");
  if (!sourceId) throw new ApiError(400, 'send { "page": "<id>" } — GET /api/workspace lists all pages');
  const source = ctx.host.page(sourceId);
  if (!source) throw new ApiError(404, `no page with id ${sourceId}`);
  if (data.title !== undefined && typeof data.title !== "string") throw new ApiError(400, "title must be a string");
  const fork = await ctx.host.forkPage(source, data.title as string | undefined);
  return json({ ok: true, page: pageMeta(ctx, fork), forkedFrom: { id: source.record.id, title: source.record.title } }, 201);
}

/** `?page=<id>` targets a specific page; the first page is the default. */
function resolvePage(ctx: ApiContext, url: URL): PageEntry {
  const id = url.searchParams.get("page");
  if (!id) return ctx.host.defaultPage;
  const entry = ctx.host.page(id);
  if (!entry) throw new ApiError(404, `no page with id ${id} — GET /api/workspace lists all pages`);
  return entry;
}

// ---------- doc ----------

function docPayload(ctx: ApiContext, entry: PageEntry) {
  const doc = entry.handle.doc();
  const comments = Object.values(doc.comments ?? {});
  const meta = pageMeta(ctx, entry);
  return {
    title: doc.title,
    ...(meta.kind === "canvas"
      ? { kind: "canvas" as const, canvas: canvasToSpec(doc.canvas) }
      : meta.kind === "html"
        ? { kind: "html" as const, html: doc.content, size: htmlRenderSize(doc.content) }
        : meta.kind === "hyperframes"
          ? {
              kind: "hyperframes" as const,
              ...listProjectFiles(entry),
              size: hyperframesRenderSize(doc.hyperframes),
              preview: `${apiPreviewOrigin(ctx)}/preview/${meta.id}/player`,
            }
          : { markdown: doc.content }),
    heads: A.getHeads(doc),
    automergeUrl: entry.handle.url,
    page: meta,
    openComments: comments.filter(c => !c.resolved).length,
    web: ctx.config.baseUrl,
  };
}

/** Preview origin as seen from API consumers (agents hold absolute URLs). */
function apiPreviewOrigin(ctx: ApiContext): string {
  try {
    return previewOriginFor(ctx.config, new URL(ctx.config.baseUrl));
  } catch {
    return ctx.config.baseUrl;
  }
}

function getDoc(ctx: ApiContext, page: PageEntry, url: URL): Response {
  const format = url.searchParams.get("format");
  if (format === "markdown" || format === "html") {
    const kind = page.record.kind ?? "markdown";
    if (kind === "canvas")
      throw new ApiError(400, "this page is a canvas — GET /api/doc (no format param) returns its JSON Canvas data");
    if (kind === "hyperframes")
      throw new ApiError(400, "this page is a hyperframes project — GET /api/hf/files lists its files, GET /api/hf/file?path=... reads one");
    if (format === "markdown" && kind === "html")
      throw new ApiError(400, "this page is html — use ?format=html for the raw source");
    if (format === "html" && kind === "markdown")
      throw new ApiError(400, "this page is markdown — use ?format=markdown for the raw source");
    // html source is served as text/plain on purpose: rendering user HTML on
    // the app origin would let a crafted page run scripts with app access
    return new Response(page.handle.doc().content, {
      headers: { "content-type": `text/${format === "html" ? "plain" : "markdown"}; charset=utf-8` },
    });
  }
  return json(docPayload(ctx, page));
}

async function putDoc(
  ctx: ApiContext,
  page: PageEntry,
  data: Record<string, unknown>,
  agent: string | null
): Promise<Response> {
  const { markdown, title, canvas, html } = data;
  const kind = page.record.kind ?? "markdown";
  const bodyHint =
    kind === "canvas"
      ? "send { canvas } and/or { title }"
      : kind === "html"
        ? "send { html } and/or { title }"
        : kind === "hyperframes"
          ? "this page is a hyperframes project — PUT /api/doc supports { title } only; edit files via PUT /api/hf/file { path, content }"
          : "send { markdown } and/or { title }";
  if (markdown === undefined && title === undefined && canvas === undefined && html === undefined)
    throw new ApiError(400, bodyHint);
  if (markdown !== undefined && typeof markdown !== "string") throw new ApiError(400, "markdown must be a string");
  if (html !== undefined && typeof html !== "string") throw new ApiError(400, "html must be a string");
  if (title !== undefined && typeof title !== "string") throw new ApiError(400, "title must be a string");
  if (markdown !== undefined && kind !== "markdown")
    throw new ApiError(
      400,
      kind === "canvas"
        ? "this page is a canvas — PUT { canvas: { nodes, edges } } (JSON Canvas 1.0) instead of markdown"
        : kind === "hyperframes"
          ? "this page is a hyperframes project — edit files via PUT /api/hf/file { path, content }"
          : "this page is html — PUT { html: \"<!doctype html>...\" } instead of markdown"
    );
  if (canvas !== undefined && kind !== "canvas")
    throw new ApiError(400, `this page is ${kind} — ${bodyHint}, or create a canvas page via POST /api/pages { kind: "canvas" }`);
  if (html !== undefined && kind !== "html")
    throw new ApiError(400, `this page is ${kind} — ${bodyHint}, or create an html page via POST /api/pages { kind: "html" }`);

  if (html !== undefined) {
    const declared = parseHtmlSize(html);
    if (!declared)
      throw new ApiError(
        400,
        `html pages must declare their render size — include ${HTML_SIZE_TAG_EXAMPLE} in <head> ` +
          `(min ${HTML_MIN.width}x${HTML_MIN.height}, max ${HTML_MAX.width}x${HTML_MAX.height})`
      );
    if (!withinHtmlLimits(declared))
      throw new ApiError(
        400,
        `declared size ${declared.width}x${declared.height} is out of range — ` +
          `min ${HTML_MIN.width}x${HTML_MIN.height}, max ${HTML_MAX.width}x${HTML_MAX.height}`
      );
    return enqueue(page.handle.url, async () => {
      page.handle.change(d => {
        if (typeof title === "string") A.updateText(d, ["title"], title);
        // updateText diffs old→new, so concurrent writes merge per-region;
        // no typewriter here — humans watch the rendered iframe, not source
        A.updateText(d, ["content"], html);
      }, changeOptions(agent));
      return json({ ok: true, ...docPayload(ctx, page) });
    });
  }

  if (canvas !== undefined) {
    let spec;
    try {
      spec = parseSpecCanvas(canvas);
    } catch (e) {
      if (e instanceof CanvasValidationError) throw new ApiError(400, `invalid canvas: ${e.message}`);
      throw e;
    }
    return enqueue(page.handle.url, async () => {
      page.handle.change(d => {
        if (typeof title === "string") A.updateText(d, ["title"], title);
        if (!d.canvas) d.canvas = emptyCanvas();
        reconcileCanvas(d.canvas, spec);
      }, changeOptions(agent));
      return json({ ok: true, ...docPayload(ctx, page) });
    });
  }

  return enqueue(page.handle.url, async () => {
    if (typeof title === "string") {
      page.handle.change(d => A.updateText(d, ["title"], title), changeOptions(agent));
    }
    if (typeof markdown === "string") {
      const typing = ctx.config.agentTyping;
      if (!typing || !agent) {
        page.handle.change(d => {
          // updateText diffs old→new into splices, preserving concurrent edits
          A.updateText(d, ["content"], markdown);
        }, changeOptions(agent));
      } else {
        // one contiguous typed splice covering the changed region
        const diff = singleSpliceDiff(page.handle.doc().content, markdown);
        if (diff) await applyAsAgent(ctx, page, agent, [diff]);
      }
    }
    return json({ ok: true, ...docPayload(ctx, page) });
  });
}

export { planEdits } from "./edits";

/** Animate splices in at human typing speed (when configured + an agent is
 * acting): per-doc queue keeps read-after-write for follow-up requests, and
 * the caret broadcast makes humans see the agent write. */
async function applyAsAgent(
  ctx: ApiContext,
  page: PageEntry,
  agent: string | null,
  splices: TypedSplice[]
): Promise<void> {
  const typing = ctx.config.agentTyping;
  const handle = page.handle;
  // html pages skip the typing animation: humans watch the rendered iframe,
  // and streaming half-written markup would just flicker broken documents
  if (!typing || !agent || page.record.kind === "html") {
    handle.change(d => {
      for (const s of splices) A.splice(d, ["content"], s.index, s.delText.length, s.ins);
    }, changeOptions(agent));
    return;
  }
  await typeSplices(handle, splices, changeOptions(agent), typing, index =>
    broadcastAgentPresence(ctx, agent, { index, typing: true }, page)
  );
  const last = splices[splices.length - 1];
  if (last) showAgentAtIndex(ctx, page, agent, Math.min(last.index + last.ins.length, handle.doc().content.length));
}

async function postEdits(
  ctx: ApiContext,
  page: PageEntry,
  data: Record<string, unknown>,
  agent: string | null
): Promise<Response> {
  const edits = data.edits;
  if (page.record.kind === "canvas")
    throw new ApiError(400, "this page is a canvas — GET /api/doc for its JSON, then PUT /api/doc { canvas } to edit");
  if (!Array.isArray(edits) || edits.length === 0)
    throw new ApiError(400, 'send { "edits": [{ "oldText": "...", "newText": "..." }] }');

  // hyperframes edits target one project file: { file: "index.html", edits }
  if (page.record.kind === "hyperframes") {
    const filePath = data.file;
    if (typeof filePath !== "string")
      throw new ApiError(400, 'this page is a hyperframes project — include "file": "<path>" (e.g. "index.html") alongside your edits');
    return enqueue(page.handle.url, async () => {
      const { path, file } = readProjectFile(page, filePath);
      if (file.kind !== "text") throw new ApiError(400, `${path} is a binary asset — text edits only`);
      const { splices } = planEditOps(file.content, edits as EditOp[]);
      // instant, like html pages: humans watch the rendered preview
      page.handle.change(d => {
        for (const s of splices) A.splice(d, ["hyperframes", "files", path, "content"], s.index, s.delText.length, s.ins);
      }, changeOptions(agent));
      return json({ ok: true, applied: splices.length, file: path, ...docPayload(ctx, page) });
    });
  }

  // plan inside the per-doc queue so a request that lands mid-animation
  // validates against the settled content, not a half-typed intermediate
  return enqueue(page.handle.url, async () => {
    const { splices, finalText } = planEditOps(page.handle.doc().content, edits as EditOp[]);
    if (page.record.kind === "html") {
      const size = parseHtmlSize(finalText);
      if (!size)
        throw new ApiError(
          400,
          `these edits would leave the page without a valid size declaration — keep ${HTML_SIZE_TAG_EXAMPLE} in <head>`
        );
      if (!withinHtmlLimits(size))
        throw new ApiError(
          400,
          `these edits would declare ${size.width}x${size.height} — min ${HTML_MIN.width}x${HTML_MIN.height}, max ${HTML_MAX.width}x${HTML_MAX.height}`
        );
    }
    await applyAsAgent(ctx, page, agent, splices);
    return json({ ok: true, applied: splices.length, ...docPayload(ctx, page) });
  });
}

async function postAppend(
  ctx: ApiContext,
  page: PageEntry,
  data: Record<string, unknown>,
  agent: string | null
): Promise<Response> {
  const { markdown } = data;
  if (page.record.kind === "canvas")
    throw new ApiError(400, "this page is a canvas — GET /api/doc for its JSON, then PUT /api/doc { canvas } to edit");
  if (page.record.kind === "html")
    throw new ApiError(400, "append doesn't apply to html pages (it would land after </html>) — use POST /api/doc/edits or PUT { html }");
  if (page.record.kind === "hyperframes")
    throw new ApiError(400, "append doesn't apply to hyperframes projects — use POST /api/doc/edits { file, edits } or PUT /api/hf/file");
  if (typeof markdown !== "string" || markdown.length === 0) throw new ApiError(400, "send { markdown } to append");

  return enqueue(page.handle.url, async () => {
    const current = page.handle.doc().content;
    const sep = current.length === 0 ? "" : current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    const at = current.length;
    await applyAsAgent(ctx, page, agent, [{ index: at, delText: "", ins: sep + markdown }]);
    return json({ ok: true, appendedAt: at, ...docPayload(ctx, page) });
  });
}

// ---------- comments ----------

interface CommentView {
  id: string;
  author: string;
  authorKind: string;
  body: string;
  createdAt: number;
  quote: string;
  resolved: boolean;
  /** current position of the anchored range; null when the text was deleted */
  range: { start: number; end: number } | null;
  replies: { id: string; author: string; body: string; createdAt: number }[];
}

function commentView(doc: A.Doc<MrkdwnDoc>, c: DocComment): CommentView {
  let range: CommentView["range"] = null;
  try {
    const start = A.getCursorPosition(doc, ["content"], c.anchorStart);
    const end = A.getCursorPosition(doc, ["content"], c.anchorEnd);
    if (end > start) range = { start, end };
  } catch {
    range = null;
  }
  return {
    id: c.id,
    author: c.author.name,
    authorKind: c.author.kind,
    body: c.body,
    createdAt: c.createdAt,
    quote: c.quote,
    resolved: c.resolved,
    range,
    replies: c.replies.map(r => ({ id: r.id, author: r.author.name, body: r.body, createdAt: r.createdAt })),
  };
}

function getComments(page: PageEntry, url: URL): Response {
  const doc = page.handle.doc();
  const includeResolved = url.searchParams.get("includeResolved") === "1";
  const comments = Object.values(doc.comments ?? {})
    .filter(c => includeResolved || !c.resolved)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(c => commentView(doc, c));
  return json({ comments });
}

function postComment(ctx: ApiContext, page: PageEntry, data: Record<string, unknown>, agentMaybe: string | null): Response {
  const agent = requireAgent(agentMaybe);
  const bodyText = data.body;
  if (typeof bodyText !== "string" || bodyText.trim().length === 0) throw new ApiError(400, "send { body }");

  const handle = page.handle;
  const doc = handle.doc();
  let anchorStart: string;
  let anchorEnd: string;
  let quote = "";

  const anchorText = data.anchorText;
  if (anchorText !== undefined) {
    if (typeof anchorText !== "string" || anchorText.length === 0)
      throw new ApiError(400, "anchorText must be a non-empty string");
    const indices = indicesOf(doc.content, anchorText);
    if (indices.length === 0)
      throw new ApiError(409, "anchorText not found in the document — GET /api/doc and quote the exact text");
    const occurrence = Number(data.occurrence ?? 1);
    if (indices.length > 1 && !data.occurrence)
      throw new ApiError(
        409,
        `anchorText matches ${indices.length} locations — pass "occurrence": <1-based index> to pick one`
      );
    const index = indices[occurrence - 1];
    if (index === undefined)
      throw new ApiError(409, `occurrence ${occurrence} out of range (only ${indices.length} matches)`);
    anchorStart = A.getCursor(doc, ["content"], index);
    anchorEnd = A.getCursor(doc, ["content"], Math.min(index + anchorText.length, doc.content.length));
    quote = anchorText;
  } else {
    // no anchor → a document-level comment pinned to the top
    anchorStart = A.getCursor(doc, ["content"], "start");
    anchorEnd = A.getCursor(doc, ["content"], "start");
  }

  const comment: DocComment = {
    id: nowId("c"),
    author: agentAuthor(agent, ctx.notifications.displayName(agent)),
    body: bodyText.trim(),
    createdAt: Date.now(),
    anchorStart,
    anchorEnd,
    quote,
    resolved: false,
    replies: [],
  };
  handle.change(d => {
    d.comments[comment.id] = comment;
  });
  return json({ ok: true, comment: commentView(handle.doc(), handle.doc().comments[comment.id]!) }, 201);
}

function postReply(ctx: ApiContext, page: PageEntry, id: string, data: Record<string, unknown>, agentMaybe: string | null): Response {
  const agent = requireAgent(agentMaybe);
  const bodyText = data.body;
  if (typeof bodyText !== "string" || bodyText.trim().length === 0) throw new ApiError(400, "send { body }");
  const handle = page.handle;
  if (!handle.doc().comments[id]) throw new ApiError(404, `no comment with id ${id}`);
  const reply = { id: nowId("r"), author: agentAuthor(agent, ctx.notifications.displayName(agent)), body: bodyText.trim(), createdAt: Date.now() };
  handle.change(d => {
    d.comments[id]!.replies.push(reply);
  });
  return json({ ok: true, comment: commentView(handle.doc(), handle.doc().comments[id]!) }, 201);
}

function postResolve(page: PageEntry, id: string, agentMaybe: string | null): Response {
  requireAgent(agentMaybe);
  const handle = page.handle;
  if (!handle.doc().comments[id]) throw new ApiError(404, `no comment with id ${id}`);
  handle.change(d => {
    d.comments[id]!.resolved = true;
  });
  return json({ ok: true });
}

// ---------- notifications & presence ----------

async function getNotifications(ctx: ApiContext, url: URL, agentMaybe: string | null): Promise<Response> {
  const agent = requireAgent(agentMaybe);
  const wait = Math.max(0, Number(url.searchParams.get("wait") ?? 0)) || 0;
  const notifications = await ctx.notifications.waitForNotifications(agent, wait);
  ctx.notifications.markSeen(agent); // long-polls keep the agent "online"
  return json({
    agent,
    notifications,
    hint:
      notifications.length > 0
        ? 'acknowledge with POST /api/notifications/ack {"ids": [...]} once handled'
        : `no mentions right now — poll again with ?wait=${wait || 25} to long-poll`,
  });
}

function postAck(ctx: ApiContext, data: Record<string, unknown>, agentMaybe: string | null): Response {
  const agent = requireAgent(agentMaybe);
  const ids = data.ids;
  if (!Array.isArray(ids) || ids.some(i => typeof i !== "string"))
    throw new ApiError(400, 'send { "ids": ["n_..."] }');
  const acked = ctx.notifications.ack(agent, ids as string[]);
  return json({ ok: true, acked });
}

function postPresence(ctx: ApiContext, page: PageEntry, agentMaybe: string | null): Response {
  const agent = requireAgent(agentMaybe);
  broadcastAgentPresence(ctx, agent, {}, page);
  return json({ ok: true, agent, hint: "you now show as online in the doc — heartbeat every ~30s while working" });
}

function getStatus(ctx: ApiContext): Response {
  const payload: StatusPayload = {
    title: ctx.host.defaultPage.handle.doc().title,
    docUrl: ctx.host.defaultPage.handle.url,
    agents: ctx.notifications.statuses(),
    persistence: ctx.persistence !== undefined,
    previewOrigin: apiPreviewOrigin(ctx),
    kimi: ctx.config.kimi !== undefined,
  };
  return json(payload);
}

// ---------- hyperframes project files ----------

function getHfFile(page: PageEntry, url: URL): Response {
  const rawPath = url.searchParams.get("path");
  if (!rawPath) throw new ApiError(400, "pass ?path=<project-relative path> — GET /api/hf/files lists them");
  const { path, file } = readProjectFile(page, rawPath);
  if (url.searchParams.get("format") === "json" || file.kind === "blob") {
    return json({
      path,
      kind: file.kind,
      mimeType: file.mimeType,
      ...(file.kind === "text" ? { content: file.content } : { sha256: file.sha256, byteSize: file.byteSize }),
    });
  }
  // raw text by default — agents diff/edit against exactly these bytes
  return new Response(file.content, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function putHfFile(
  ctx: ApiContext,
  page: PageEntry,
  data: Record<string, unknown>,
  agent: string | null
): Promise<Response> {
  const { path, content } = data;
  if (typeof path !== "string" || typeof content !== "string")
    throw new ApiError(400, 'send { "path": "styles.css", "content": "..." } — text files only');
  return enqueue(page.handle.url, async () => {
    const result = writeProjectFile(page, path, content, changeOptions(agent));
    return json({ ok: true, ...result, ...docPayload(ctx, page) }, result.created ? 201 : 200);
  });
}

async function deleteHfFile(
  ctx: ApiContext,
  page: PageEntry,
  url: URL,
  data: Record<string, unknown>,
  agent: string | null
): Promise<Response> {
  const raw = typeof data.path === "string" ? data.path : url.searchParams.get("path");
  if (!raw) throw new ApiError(400, 'send { "path": "..." } (or ?path=)');
  return enqueue(page.handle.url, async () => {
    const path = deleteProjectFile(page, raw, changeOptions(agent));
    return json({ ok: true, deleted: path, ...docPayload(ctx, page) });
  });
}

// ---------- agent presence in the live doc ----------

/** Flash the agent's cursor at a doc position so humans see where it edited. */
function showAgentAtIndex(ctx: ApiContext, page: PageEntry, agent: string, index: number): void {
  broadcastAgentPresence(ctx, agent, { index, typing: true }, page);
  setTimeout(() => broadcastAgentPresence(ctx, agent, { index, typing: false }, page), 2500);
}

export function broadcastAgentPresence(
  ctx: ApiContext,
  agent: string,
  opts: { index?: number; typing?: boolean },
  page?: PageEntry
): void {
  const entry = page ?? ctx.host.defaultPage;
  const doc = entry.handle.doc();
  let cursor: string | null = null;
  if (opts.index !== undefined) {
    try {
      cursor = A.getCursor(doc, ["content"], Math.max(0, Math.min(opts.index, doc.content.length)));
    } catch {
      cursor = null;
    }
  }
  const msg: PresenceMessage = {
    type: "presence",
    user: agentAuthor(agent, ctx.notifications.displayName(agent)),
    anchor: cursor,
    head: cursor,
    typing: opts.typing,
    ts: Date.now(),
  };
  entry.handle.broadcast(msg);
}
