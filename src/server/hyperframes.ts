/**
 * HyperFrames server surface:
 *
 *  - ZIP upload → a new "hyperframes" page (text files into the Automerge
 *    doc, binaries content-addressed into object storage as blobs/{sha256})
 *  - ZIP export (for local `hyperframes render`)
 *  - the preview virtual directory: /preview/{pageId}/live/{path} serves the
 *    project so the composition's relative asset paths just work, and
 *    /preview/{pageId}/player serves a shell page hosting @hyperframes/player
 *    (compositions are paused timelines — the player drives playback and
 *    needs same-origin access to the composition iframe)
 *  - file-level read/write used by the agent REST API and Kimi
 *
 * SECURITY: compositions are arbitrary user HTML+JS. They must never execute
 * on the app origin (same posture as the html kind's srcDoc sandbox), so
 * /preview/* redirects to the dedicated preview origin (prod:
 * MRKDWN_PREVIEW_ORIGIN; dev: the localhost ↔ 127.0.0.1 swap) and the app
 * embeds it cross-origin.
 */
import * as A from "@automerge/automerge";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import type { ServerConfig } from "./config";
import type { DocHost, PageEntry } from "./repo";
import type { ObjectMirror } from "./persist";
import { ApiError } from "./errors";
import {
  HF_MAX_BLOB_BYTES,
  HF_MAX_FILES,
  HF_MAX_TEXT_BYTES,
  HF_MAX_ZIP_BYTES,
  cleanProjectPath,
  isJunkPath,
  isTextPath,
  mimeFor,
  pickEntrypoint,
  type HyperframesFile,
  type HyperframesProject,
} from "../shared/hyperframes";

export interface HyperframesContext {
  config: ServerConfig;
  host: DocHost;
  mirror?: ObjectMirror;
}

/** Content-addressed asset bytes. Global namespace on purpose: identical
 * bytes are identical everywhere, and forks share assets without copying. */
export function blobKey(sha256: string): string {
  return `blobs/${sha256}`;
}

const sha256hex = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

function requireProject(page: PageEntry): HyperframesProject {
  if (page.record.kind !== "hyperframes")
    throw new ApiError(400, `page ${page.record.id} is ${page.record.kind ?? "markdown"}, not hyperframes`);
  const project = page.handle.doc().hyperframes;
  if (!project) throw new ApiError(500, "hyperframes page has no project data");
  return project;
}

// ---------- preview origin ----------

/** The origin compositions execute on. Never the app origin in production
 * (MRKDWN_PREVIEW_ORIGIN); in dev we swap localhost ↔ 127.0.0.1 — a different
 * host is a different origin, served by the same process. */
export function previewOriginFor(config: ServerConfig, requestUrl: URL): string {
  if (config.previewOrigin) return config.previewOrigin;
  if (requestUrl.hostname === "localhost")
    return `${requestUrl.protocol}//127.0.0.1${requestUrl.port ? `:${requestUrl.port}` : ""}`;
  return requestUrl.origin;
}

// ---------- upload ----------

export interface UploadResult {
  page: PageEntry;
  filesImported: number;
  blobsStored: number;
  skipped: string[];
}

export async function importZipProject(
  ctx: HyperframesContext,
  zipBytes: Uint8Array,
  title: string
): Promise<UploadResult> {
  if (zipBytes.byteLength > HF_MAX_ZIP_BYTES)
    throw new ApiError(413, `zip exceeds ${Math.round(HF_MAX_ZIP_BYTES / 1e6)}MB`);

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes);
  } catch {
    throw new ApiError(400, "not a valid zip archive");
  }

  const skipped: string[] = [];
  const kept: { path: string; bytes: Uint8Array }[] = [];
  for (const [rawPath, bytes] of Object.entries(entries)) {
    if (rawPath.endsWith("/")) continue; // directory entries
    const cleaned = cleanProjectPath(rawPath);
    if (!cleaned || isJunkPath(cleaned)) {
      skipped.push(rawPath);
      continue;
    }
    kept.push({ path: cleaned, bytes });
  }
  if (kept.length === 0) throw new ApiError(400, "zip contains no usable files");

  // zips usually wrap everything in a single top-level folder — strip it
  const firstSegment = (p: string) => p.split("/")[0]!;
  const wrapper = firstSegment(kept[0]!.path);
  if (kept.every(f => f.path.includes("/") && firstSegment(f.path) === wrapper)) {
    for (const f of kept) f.path = f.path.slice(wrapper.length + 1);
  }

  if (kept.length > HF_MAX_FILES)
    throw new ApiError(413, `project has ${kept.length} files — max ${HF_MAX_FILES} (node_modules and .git are already excluded)`);

  const files: HyperframesProject["files"] = {};
  let blobsStored = 0;
  for (const { path, bytes } of kept) {
    if (isTextPath(path)) {
      if (bytes.byteLength > HF_MAX_TEXT_BYTES) {
        skipped.push(`${path} (text file over ${Math.round(HF_MAX_TEXT_BYTES / 1e6)}MB)`);
        continue;
      }
      files[path] = { kind: "text", mimeType: mimeFor(path), content: new TextDecoder().decode(bytes) };
    } else {
      if (bytes.byteLength > HF_MAX_BLOB_BYTES) {
        skipped.push(`${path} (asset over ${Math.round(HF_MAX_BLOB_BYTES / 1e6)}MB)`);
        continue;
      }
      if (!ctx.mirror)
        throw new ApiError(503, "this server has no object storage configured — binary assets can't be stored (text-only projects work)");
      const sha256 = sha256hex(bytes);
      await ctx.mirror.write(blobKey(sha256), bytes);
      files[path] = { kind: "blob", sha256, mimeType: mimeFor(path), byteSize: bytes.byteLength };
      blobsStored++;
    }
  }

  const entrypoint = pickEntrypoint(Object.keys(files));
  if (!entrypoint)
    throw new ApiError(400, "no .html entrypoint found in the zip — a HyperFrames project needs a composition html (usually index.html)");

  const page = await ctx.host.createPage(title, "hyperframes", {
    title,
    content: "",
    comments: {},
    hyperframes: { entrypoint, files },
  });
  return { page, filesImported: Object.keys(files).length, blobsStored, skipped };
}

export async function handleHyperframesUpload(req: Request, url: URL, ctx: HyperframesContext): Promise<Response> {
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength === 0) throw new ApiError(400, "send the project zip as the raw request body (Content-Type: application/zip)");
  const title = url.searchParams.get("title")?.trim() || "Untitled video";
  const result = await importZipProject(ctx, buf, title);
  const record = result.page.record;
  return Response.json(
    {
      ok: true,
      // full PageMeta shape — the web client patches it into its page list
      page: {
        id: record.id,
        title: record.title,
        slug: record.slug,
        kind: "hyperframes",
        path: ctx.host.pagePath(result.page),
        automergeUrl: record.automergeUrl,
        updatedAt: record.updatedAt,
      },
      filesImported: result.filesImported,
      blobsStored: result.blobsStored,
      skipped: result.skipped,
    },
    { status: 201 }
  );
}

// ---------- export ----------

export async function handleHyperframesExport(page: PageEntry, ctx: HyperframesContext): Promise<Response> {
  const project = requireProject(page);
  const out: Record<string, Uint8Array> = {};
  const missing: string[] = [];
  for (const [path, file] of Object.entries(project.files)) {
    if (file.kind === "text") {
      out[path] = new TextEncoder().encode(file.content);
    } else {
      const bytes = ctx.mirror ? await ctx.mirror.read(blobKey(file.sha256)) : null;
      if (bytes) out[path] = bytes;
      else missing.push(path);
    }
  }
  if (missing.length > 0)
    out["__mrkdwn-export-warnings.txt"] = new TextEncoder().encode(
      `These assets were referenced by the project but missing from object storage:\n${missing.join("\n")}\n`
    );
  const zipped = zipSync(out);
  const filename = `${page.record.slug || page.record.id}.zip`;
  return new Response(zipped.slice().buffer as ArrayBuffer, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

// ---------- file-level ops (agent REST API + Kimi) ----------

export interface HfFileInfo {
  path: string;
  kind: "text" | "blob";
  mimeType: string;
  byteSize: number;
}

export function listProjectFiles(page: PageEntry): { entrypoint: string; files: HfFileInfo[] } {
  const project = requireProject(page);
  const files = Object.entries(project.files)
    .map(([path, f]) => ({
      path,
      kind: f.kind,
      mimeType: f.mimeType,
      byteSize: f.kind === "text" ? new TextEncoder().encode(f.content).byteLength : f.byteSize,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { entrypoint: project.entrypoint, files };
}

export function readProjectFile(page: PageEntry, rawPath: string): { path: string; file: HyperframesFile } {
  const project = requireProject(page);
  const path = cleanProjectPath(rawPath);
  if (!path) throw new ApiError(400, `invalid path: ${rawPath}`);
  const file = project.files[path];
  if (!file) throw new ApiError(404, `no file at ${path} — GET /api/hf/files lists the project`);
  return { path, file };
}

/** Create or replace a text file. Existing text files update via
 * A.updateText so concurrent edits to the same file merge per-region. */
export function writeProjectFile(
  page: PageEntry,
  rawPath: string,
  content: string,
  changeOpts: { message?: string }
): { path: string; created: boolean } {
  const project = requireProject(page);
  const path = cleanProjectPath(rawPath);
  if (!path) throw new ApiError(400, `invalid path: ${rawPath}`);
  if (!isTextPath(path))
    throw new ApiError(400, `${path} is not a text file type — binary assets arrive via the zip upload`);
  if (new TextEncoder().encode(content).byteLength > HF_MAX_TEXT_BYTES)
    throw new ApiError(413, `file exceeds ${Math.round(HF_MAX_TEXT_BYTES / 1e6)}MB`);
  const existing = project.files[path];
  if (existing && existing.kind === "blob")
    throw new ApiError(409, `${path} is a binary asset — delete it first to replace it with a text file`);
  const created = !existing;
  page.handle.change(d => {
    const files = d.hyperframes!.files;
    if (files[path]?.kind === "text") {
      A.updateText(d, ["hyperframes", "files", path, "content"], content);
    } else {
      files[path] = { kind: "text", mimeType: mimeFor(path), content };
    }
  }, changeOpts);
  return { path, created };
}

export function deleteProjectFile(page: PageEntry, rawPath: string, changeOpts: { message?: string }): string {
  const project = requireProject(page);
  const path = cleanProjectPath(rawPath);
  if (!path || !project.files[path]) throw new ApiError(404, `no file at ${rawPath}`);
  if (path === project.entrypoint)
    throw new ApiError(400, `${path} is the project entrypoint — write a replacement first or change the entrypoint`);
  page.handle.change(d => {
    delete d.hyperframes!.files[path];
  }, changeOpts);
  return path;
}

// ---------- preview serving ----------

const PLAYER_DIST = join(import.meta.dir, "../../node_modules/@hyperframes/player/dist/hyperframes-player.global.js");

const previewHeaders = (contentType: string, cache: string): Record<string, string> => ({
  "content-type": contentType,
  "cache-control": cache,
  "x-content-type-options": "nosniff",
});

/** Everything under /preview/. Returns undefined for non-preview paths. */
export async function handlePreview(req: Request, url: URL, ctx: HyperframesContext): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/preview/")) return undefined;
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });

  // the player script is origin-agnostic (just JS for the shell page)
  if (url.pathname === "/preview/__assets__/player.js") {
    return new Response(Bun.file(PLAYER_DIST), {
      headers: previewHeaders("text/javascript; charset=utf-8", "public, max-age=86400"),
    });
  }

  // compositions execute on the preview origin only — bounce the app origin
  // (compare hosts, not origins: a TLS-terminating proxy hides the protocol)
  const previewOrigin = previewOriginFor(ctx.config, url);
  if (url.hostname !== new URL(previewOrigin).hostname) {
    return Response.redirect(`${previewOrigin}${url.pathname}${url.search}`, 302);
  }

  const shell = url.pathname.match(/^\/preview\/([A-Za-z0-9]+)\/player$/);
  if (shell) return servePlayerShell(shell[1]!, url, ctx);

  const live = url.pathname.match(/^\/preview\/([A-Za-z0-9]+)\/live\/(.*)$/);
  if (live) return serveProjectFile(req, live[1]!, decodeURIComponent(live[2]!), ctx);

  return new Response("not found", { status: 404 });
}

function hfPage(ctx: HyperframesContext, id: string): { page: PageEntry; project: HyperframesProject } | null {
  const page = ctx.host.page(id);
  if (!page || page.record.kind !== "hyperframes") return null;
  const project = page.handle.doc().hyperframes;
  return project ? { page, project } : null;
}

/** The shell hosts @hyperframes/player pointing at the live entrypoint. The
 * player needs same-origin access to the composition iframe (it polls
 * window.__timelines and injects the runtime), which both have here. */
function servePlayerShell(pageId: string, url: URL, ctx: HyperframesContext): Response {
  const found = hfPage(ctx, pageId);
  if (!found) return new Response("no such hyperframes page", { status: 404 });
  const { project } = found;
  const q = url.searchParams;
  const attrs = [
    `src="/preview/${pageId}/live/${project.entrypoint}${q.get("v") ? `?v=${encodeURIComponent(q.get("v")!)}` : ""}"`,
    q.get("controls") === "0" ? "" : "controls",
    q.get("autoplay") === "1" ? "autoplay muted" : "",
    q.get("loop") === "1" ? "loop" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; height: 100%; background: #000; }
  hyperframes-player { display: block; width: 100%; height: 100%; }
</style>
<script src="/preview/__assets__/player.js"></script>
</head>
<body><hyperframes-player ${attrs}></hyperframes-player></body>
</html>`;
  return new Response(html, { headers: previewHeaders("text/html; charset=utf-8", "no-store") });
}

async function serveProjectFile(req: Request, pageId: string, rest: string, ctx: HyperframesContext): Promise<Response> {
  const found = hfPage(ctx, pageId);
  if (!found) return new Response("no such hyperframes page", { status: 404 });
  const { project } = found;

  const path = rest === "" ? project.entrypoint : cleanProjectPath(rest);
  const file = path ? project.files[path] : undefined;
  if (!path || !file) return new Response("not found", { status: 404 });

  if (file.kind === "text") {
    // live content — always fresh (agents edit continuously)
    const body = req.method === "HEAD" ? null : file.content;
    return new Response(body, { headers: previewHeaders(`${file.mimeType}; charset=utf-8`, "no-store") });
  }

  const etag = `"${file.sha256}"`;
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304 });
  const bytes = ctx.mirror ? await ctx.mirror.read(blobKey(file.sha256)) : null;
  if (!bytes) return new Response("asset missing from object storage", { status: 404 });

  const base = {
    ...previewHeaders(file.mimeType, "public, max-age=300"),
    etag,
    "accept-ranges": "bytes",
  };

  // <video>/<audio> seek with Range requests
  const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    const size = bytes.byteLength;
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] ? (range[2] ? Number(range[2]) : size - 1) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end || start >= size)
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    const chunk = bytes.slice(start, end + 1);
    return new Response(req.method === "HEAD" ? null : (chunk.buffer as ArrayBuffer), {
      status: 206,
      headers: { ...base, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(chunk.byteLength) },
    });
  }

  return new Response(req.method === "HEAD" ? null : (bytes.slice().buffer as ArrayBuffer), { headers: base });
}
