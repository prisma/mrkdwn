/** The preview origin (where hyperframes compositions execute — never the
 * app origin; see server/hyperframes.ts). Fetched once from /api/status and
 * cached module-wide: embeds can be numerous and shouldn't each poll. */
import { useEffect, useState } from "react";

let cached: string | null = null;
let pending: Promise<string> | null = null;

async function fetchPreviewOrigin(): Promise<string> {
  if (!pending) {
    pending = fetch("/api/status")
      .then(r => r.json())
      .then(s => (cached = ((s as { previewOrigin?: string }).previewOrigin ?? location.origin).replace(/\/$/, "")))
      .catch(() => (cached = location.origin));
  }
  return pending;
}

export function usePreviewOrigin(): string | null {
  const [origin, setOrigin] = useState(cached);
  useEffect(() => {
    if (cached) return;
    let alive = true;
    void fetchPreviewOrigin().then(o => alive && setOrigin(o));
    return () => {
      alive = false;
    };
  }, []);
  return origin;
}
