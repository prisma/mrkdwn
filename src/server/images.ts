/**
 * Pasted images. Bytes live in S3 (`images/{workspaceId}/{id}`), the
 * queryable record (dimensions, content type) lives in Postgres, and this
 * module serves them through the Bun process:
 *
 *   POST /api/images            raw body upload (content-type header)
 *   GET  /api/images/:id?w=640  original or Bun.Image-resized variant
 *
 * Image ids are immutable, so responses carry a one-year immutable
 * Cache-Control — resizes happen at most once per client per variant.
 */
import type { DocStore } from "./store";
import type { ObjectMirror } from "./persist";

export interface ImageContext {
  store: DocStore;
  mirror: ObjectMirror | undefined;
  workspaceId: string;
}

const MAX_BYTES = 12 * 1024 * 1024;
const TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MIN_W = 16;
const MAX_W = 2560;

export function imageKey(workspaceId: string, id: string): string {
  return `images/${workspaceId}/${id}`;
}

function newImageId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** Routes /api/images requests; returns undefined for other paths. */
export async function handleImages(req: Request, url: URL, ctx: ImageContext): Promise<Response | undefined> {
  if (url.pathname === "/api/images" && req.method === "POST") return uploadImage(req, ctx);
  const m = url.pathname.match(/^\/api\/images\/([0-9a-f]{16})$/);
  if (m && req.method === "GET") return serveImage(m[1]!, url, ctx);
  return undefined;
}

async function uploadImage(req: Request, ctx: ImageContext): Promise<Response> {
  if (!ctx.mirror) return json({ error: "image uploads need S3 configured (S3_* env vars)" }, 503);
  const contentType = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!TYPES[contentType]) return json({ error: `content-type must be one of: ${Object.keys(TYPES).join(", ")}` }, 415);

  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength === 0) return json({ error: "empty body — send the raw image bytes" }, 400);
  if (bytes.byteLength > MAX_BYTES) return json({ error: `image too large (max ${MAX_BYTES / 1024 / 1024}MB)` }, 413);

  // decode to validate it really is an image (and to record dimensions)
  let width: number, height: number;
  try {
    const meta = await new Bun.Image(bytes).metadata();
    width = meta.width;
    height = meta.height;
  } catch {
    return json({ error: "body is not a decodable image" }, 400);
  }

  const id = newImageId();
  await ctx.mirror.write(imageKey(ctx.workspaceId, id), bytes);
  const rec = await ctx.store.createImage({
    id,
    workspaceId: ctx.workspaceId,
    contentType,
    width,
    height,
    byteSize: bytes.byteLength,
  });
  return json({ ok: true, id, url: `/api/images/${id}`, width: rec.width, height: rec.height }, 201);
}

async function serveImage(id: string, url: URL, ctx: ImageContext): Promise<Response> {
  if (!ctx.mirror) return json({ error: "images unavailable without S3" }, 503);
  const rec = await ctx.store.getImage(id);
  if (!rec) return json({ error: "no such image" }, 404);
  const bytes = await ctx.mirror.read(imageKey(rec.workspaceId, rec.id));
  if (!bytes) return json({ error: "image bytes missing from storage" }, 404);

  const headers: Record<string, string> = {
    "content-type": rec.contentType,
    "cache-control": "public, max-age=31536000, immutable",
    etag: `"${rec.id}"`,
  };

  const wParam = url.searchParams.get("w");
  const w = wParam ? Math.min(MAX_W, Math.max(MIN_W, Math.round(Number(wParam)) || 0)) : null;
  // only downscale, and leave gifs alone (animation survives untouched)
  if (!w || w >= rec.width || rec.contentType === "image/gif") {
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers });
  }

  try {
    const pipeline = new Bun.Image(bytes).resize(w);
    const format = TYPES[rec.contentType]!;
    const resized =
      format === "jpeg" ? await pipeline.jpeg({ quality: 82 }).bytes()
      : format === "webp" ? await pipeline.webp({ quality: 82 }).bytes()
      : await pipeline.png().bytes();
    headers.etag = `"${rec.id}-w${w}"`;
    return new Response(resized as Uint8Array<ArrayBuffer>, { headers });
  } catch (err) {
    console.warn(`[mrkdwn] resize failed for image ${id} (w=${w}), serving original:`, err);
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers });
  }
}
