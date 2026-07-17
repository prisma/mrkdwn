/**
 * HyperFrames pages: a multi-file video project (hyperframes.heygen.com)
 * stored as one Automerge doc. Text files (html/css/js/md/…) live as
 * independently-spliceable strings so concurrent edits to different files
 * merge cleanly; binary assets are content-addressed blobs in object storage
 * (`blobs/{sha256}`) so forks share every unchanged asset without copying.
 *
 * The project is served as a virtual directory (`/preview/{pageId}/live/…`)
 * so the composition's relative asset paths just work, and rendered through
 * `@hyperframes/player` (compositions are paused timelines — a bare iframe
 * would freeze on frame 0).
 */

export interface HyperframesTextFile {
  kind: "text";
  mimeType: string;
  content: string;
}

export interface HyperframesBlobFile {
  kind: "blob";
  /** content address — bytes live in object storage under blobs/{sha256} */
  sha256: string;
  mimeType: string;
  byteSize: number;
}

export type HyperframesFile = HyperframesTextFile | HyperframesBlobFile;

export interface HyperframesProject {
  /** project-relative path of the composition html the player loads */
  entrypoint: string;
  /** fileKey(path) → file. Automerge map: per-file edits merge.
   * KEYS ARE ESCAPED — Automerge's path APIs (updateText/splice) join path
   * arrays with "/", so a key containing "/" is unaddressable. We store "/"
   * as "\" (banned in project paths, so the mapping is bijective); always go
   * through fileKey()/pathFromKey()/getProjectFile()/projectPaths(). */
  files: { [key: string]: HyperframesFile };
}

/** Project path → Automerge map key ("/" ⇢ "\"). */
export function fileKey(path: string): string {
  return path.replaceAll("/", "\\");
}

/** Automerge map key → project path. Tolerates legacy unescaped keys (they
 * contain "/" and no "\"), which boot migration rewrites. */
export function pathFromKey(key: string): string {
  return key.replaceAll("\\", "/");
}

export function getProjectFile(project: HyperframesProject, path: string): HyperframesFile | undefined {
  // legacy fallback: docs written before key escaping used raw slash keys
  return project.files[fileKey(path)] ?? project.files[path];
}

/** All project paths (decoded), sorted. */
export function projectPaths(project: HyperframesProject): string[] {
  return Object.keys(project.files).map(pathFromKey).sort();
}

// ---------- limits ----------

export const HF_MAX_FILES = 500;
export const HF_MAX_TEXT_BYTES = 1_500_000; // per text file, inside Automerge
export const HF_MAX_BLOB_BYTES = 80_000_000; // per asset (renders can be chunky)
export const HF_MAX_ZIP_BYTES = 150_000_000;

/** Composition size fallback when the root declares none (player default). */
export const HF_DEFAULT_SIZE = { width: 1920, height: 1080 };

// ---------- paths & mime ----------

const TEXT_EXTS = new Set([
  "html", "htm", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "md",
  "txt", "svg", "xml", "csv", "yaml", "yml", "toml", "vtt", "srt",
]);

const MIME: Record<string, string> = {
  html: "text/html", htm: "text/html", css: "text/css",
  js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript",
  ts: "text/javascript", tsx: "text/javascript", jsx: "text/javascript",
  json: "application/json", md: "text/markdown", txt: "text/plain",
  svg: "image/svg+xml", xml: "application/xml", csv: "text/csv",
  yaml: "text/yaml", yml: "text/yaml", toml: "text/plain",
  vtt: "text/vtt", srt: "text/plain",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", ico: "image/x-icon",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
  aac: "audio/aac", flac: "audio/flac",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  pdf: "application/pdf", wasm: "application/wasm",
};

export function pathExt(path: string): string {
  const m = path.match(/\.([a-z0-9]+)$/i);
  return m ? m[1]!.toLowerCase() : "";
}

export function mimeFor(path: string): string {
  return MIME[pathExt(path)] ?? "application/octet-stream";
}

export function isTextPath(path: string): boolean {
  return TEXT_EXTS.has(pathExt(path));
}

/** Normalize a project-relative path; null = rejected. No "..", no absolute
 * paths, no backslashes, no control chars — these paths become URL segments
 * and Automerge map keys. */
export function cleanProjectPath(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let p = raw.replace(/^\.?\//, "");
  if (p.length === 0 || p.length > 512) return null;
  if (p.includes("\\") || p.includes("\0")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) return null;
  const segments = p.split("/");
  if (segments.length > 24) return null;
  for (const s of segments) {
    if (s === "" || s === "." || s === "..") return null;
  }
  return segments.join("/");
}

/** Zip entries we silently drop on upload (OS junk, VCS, dependency dirs). */
export function isJunkPath(path: string): boolean {
  const segments = path.split("/");
  if (segments.some(s => s === "__MACOSX" || s === ".git" || s === "node_modules" || s === ".DS_Store")) return true;
  const base = segments[segments.length - 1]!;
  return base === "Thumbs.db" || base.endsWith(".map~");
}

/** index.html at the shallowest depth wins; otherwise the shallowest .html. */
export function pickEntrypoint(paths: string[]): string | undefined {
  const htmls = paths.filter(p => pathExt(p) === "html" || pathExt(p) === "htm");
  if (htmls.length === 0) return undefined;
  const depth = (p: string) => p.split("/").length;
  const byPreference = (a: string, b: string) => {
    const aIndex = /(^|\/)index\.html?$/.test(a) ? 0 : 1;
    const bIndex = /(^|\/)index\.html?$/.test(b) ? 0 : 1;
    return aIndex - bIndex || depth(a) - depth(b) || a.localeCompare(b);
  };
  return [...htmls].sort(byPreference)[0];
}

/** Parse the composition root's declared size out of the entrypoint html
 * (`data-width` / `data-height` on the `data-composition-id` element).
 * Best-effort — the player auto-detects at runtime; this feeds embed sizing. */
export function parseCompositionSize(html: string): { width: number; height: number } | null {
  const root = html.match(/<[^>]*data-composition-id=[^>]*>/i)?.[0] ?? html.match(/<[^>]*data-width=[^>]*data-height=[^>]*>/i)?.[0];
  if (!root) return null;
  const width = Number(root.match(/data-width\s*=\s*["']?(\d+)/i)?.[1]);
  const height = Number(root.match(/data-height\s*=\s*["']?(\d+)/i)?.[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

export function parseCompositionDuration(html: string): number | null {
  const root = html.match(/<[^>]*data-composition-id=[^>]*>/i)?.[0];
  const duration = Number(root?.match(/data-duration\s*=\s*["']?([\d.]+)/i)?.[1]);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

/** Size the embed/player box for a project (entry html may be absent mid-edit). */
export function hyperframesRenderSize(project: HyperframesProject | undefined): { width: number; height: number } {
  const entry = project ? getProjectFile(project, project.entrypoint) : undefined;
  if (entry?.kind === "text") {
    const declared = parseCompositionSize(entry.content);
    if (declared) return declared;
  }
  return HF_DEFAULT_SIZE;
}

// ---------- starter project ----------

/** A minimal valid composition (per the HyperFrames contract: standalone
 * sized root, one clip, one paused GSAP timeline on window.__timelines). */
export function starterHyperframes(title: string): HyperframesProject {
  const safe = (title || "Untitled").replace(/[<>&]/g, "");
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1280, height=720" />
    <title>${safe}</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      body { margin: 0; background: #0b0f14; color: white; font-family: Inter, system-ui, sans-serif; }
      #root { position: relative; width: 1280px; height: 720px; overflow: hidden; }
      .clip { position: absolute; inset: 0; display: grid; place-items: center; }
      h1 { margin: 0; font-size: 72px; letter-spacing: -0.02em; }
      p { margin: 12px 0 0; font-size: 28px; opacity: 0.7; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-width="1280" data-height="720" data-duration="5">
      <section id="title-card" class="clip" data-start="0" data-duration="5" data-track-index="1">
        <div style="text-align:center">
          <h1 id="title">${safe}</h1>
          <p id="subtitle">Edit index.html to build this video</p>
        </div>
      </section>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      tl.from("#title", { y: 48, opacity: 0, duration: 0.6, ease: "power3.out" }, 0.2);
      tl.from("#subtitle", { y: 24, opacity: 0, duration: 0.5, ease: "power3.out" }, 0.55);
      tl.set({}, {}, 5); // pad the timeline to the declared 5s duration
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
  return {
    entrypoint: "index.html",
    files: {
      "index.html": { kind: "text", mimeType: "text/html", content: html },
    },
  };
}
