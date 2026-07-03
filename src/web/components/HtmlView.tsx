import { useEffect, useRef, useState } from "react";
import { useDocument } from "@automerge/automerge-repo-react-hooks";
import type { DocHandle } from "@automerge/automerge-repo/slim";
import type { MrkdwnDoc } from "../../shared/types";
import { HTML_SANDBOX, htmlRenderSize } from "../../shared/html";

/**
 * Human-facing view of an HTML page: the doc's content rendered live in a
 * sandboxed iframe at its declared mrkdwn-size, scaled down when the
 * viewport is narrower. Agents write the source over the API; the sandbox
 * (no allow-same-origin) keeps their scripts in an opaque origin with no
 * access to the app's storage or credentials.
 */
export function HtmlView(p: { handle: DocHandle<MrkdwnDoc>; chromeless?: boolean }) {
  const [doc] = useDocument<MrkdwnDoc>(p.handle.url, { suspense: false });
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  // srcdoc swaps reset the embedded document (timers, state, scroll) — settle
  // bursts of agent edits before re-rendering
  const html = doc?.content ?? "";
  const [srcdoc, setSrcdoc] = useState(html);
  useEffect(() => {
    const t = setTimeout(() => setSrcdoc(html), 300);
    return () => clearTimeout(t);
  }, [html]);

  const size = htmlRenderSize(srcdoc);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // fit both dimensions: the declared size is always fully visible
    const metaSpace = p.chromeless ? 4 : 32;
    const compute = () => {
      if (el.clientWidth < 40 || el.clientHeight < 40) return; // hidden/collapsing — keep the last scale
      setScale(Math.min(1, (el.clientWidth - 4) / size.width, (el.clientHeight - metaSpace) / size.height));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [size.width, size.height, p.chromeless]);

  if (!doc) return null;
  return (
    <div ref={wrapRef} className={"html-view" + (p.chromeless ? " html-view--chromeless" : "")}>
      <div className="html-frame-box" style={{ width: Math.round(size.width * scale), height: Math.round(size.height * scale) }}>
        <iframe
          className="html-frame"
          sandbox={HTML_SANDBOX}
          srcDoc={srcdoc}
          style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}
          title={doc.title || "HTML page"}
        />
      </div>
      {!p.chromeless && (
        <div className="html-view-meta">
          {size.width}×{size.height} · sandboxed · updates live as agents write the source
        </div>
      )}
    </div>
  );
}
