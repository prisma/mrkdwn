/**
 * HTML pages: agent-authored, self-contained HTML documents (markup, CSS,
 * and JS) that humans view rendered in a sandboxed iframe. The source lives
 * in the doc's `content` field like markdown does, so the same Automerge
 * text merging (and the same surgical-edit API) applies.
 *
 * Every HTML page declares its own render size with a standard meta tag:
 *
 *   <meta name="mrkdwn-size" content="960x600">
 *
 * Width and height are CSS pixels. The API refuses writes that omit the tag
 * or fall outside HTML_MIN..HTML_MAX; renderers clamp defensively and fall
 * back to HTML_DEFAULT when the tag is missing (e.g. mid-edit).
 */

export interface HtmlSize {
  width: number;
  height: number;
}

export const HTML_MIN: HtmlSize = { width: 240, height: 160 };
export const HTML_MAX: HtmlSize = { width: 1600, height: 1200 };
export const HTML_DEFAULT: HtmlSize = { width: 800, height: 600 };

export const HTML_SIZE_TAG_EXAMPLE = '<meta name="mrkdwn-size" content="960x600">';

/** The iframe sandbox HTML pages render in — scripts run in an opaque
 * origin with no access to the app's origin, storage, or credentials. */
export const HTML_SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";

/** Strict parse of the declared size; null when the tag is missing or the
 * content isn't `WxH`. Attribute order inside the tag doesn't matter. */
export function parseHtmlSize(html: string): HtmlSize | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = tag.match(/name\s*=\s*["']([^"']*)["']/i)?.[1];
    if (name?.trim().toLowerCase() !== "mrkdwn-size") continue;
    const content = tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    const m = content.trim().match(/^(\d+)\s*[x×]\s*(\d+)$/i);
    if (!m) return null;
    return { width: Number(m[1]), height: Number(m[2]) };
  }
  return null;
}

export function withinHtmlLimits(size: HtmlSize): boolean {
  return (
    size.width >= HTML_MIN.width &&
    size.height >= HTML_MIN.height &&
    size.width <= HTML_MAX.width &&
    size.height <= HTML_MAX.height
  );
}

/** What renderers should use: the declared size clamped into range, or the
 * default when undeclared (a document mid-edit shouldn't collapse to 0). */
export function htmlRenderSize(html: string): HtmlSize {
  const declared = parseHtmlSize(html);
  if (!declared) return { ...HTML_DEFAULT };
  return {
    width: Math.min(HTML_MAX.width, Math.max(HTML_MIN.width, declared.width)),
    height: Math.min(HTML_MAX.height, Math.max(HTML_MIN.height, declared.height)),
  };
}

/** Seed for a fresh HTML page — valid, sized, and self-explanatory. */
export function starterHtml(title: string): string {
  const safe = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="mrkdwn-size" content="800x600">
<title>${safe}</title>
<style>
  body { margin: 0; height: 100vh; display: grid; place-items: center;
         font: 15px/1.6 -apple-system, system-ui, sans-serif; color: #6f6e69; background: #fffefc; }
  p { max-width: 32em; text-align: center; padding: 0 2em; }
</style>
</head>
<body>
<p>This is an HTML page. Invite an agent and ask it to build something here —
it writes the source, you watch it render live.</p>
</body>
</html>
`;
}
