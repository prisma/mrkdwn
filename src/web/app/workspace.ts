/** Workspace state: pages list (polled), current route, navigation. Routes
 * are `/{workspace}/{id}-{slug}` — the id does the lookup, the slug is
 * cosmetic and may drift after renames (the URL is canonicalized). */
import { useCallback, useEffect, useState } from "react";
import type { PageMeta, WorkspacePayload } from "../../shared/types";

export function parsePageId(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return parts[1]!.split("-")[0] || null;
}

export function useWorkspace(intervalMs = 5000) {
  const [workspace, setWorkspace] = useState<WorkspacePayload | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/workspace");
      if (res.ok) setWorkspace((await res.json()) as WorkspacePayload);
    } catch {}
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/workspace");
        if (res.ok && alive) setWorkspace((await res.json()) as WorkspacePayload);
      } catch {}
    };
    tick();
    const t = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [intervalMs]);

  return { workspace, refresh };
}

export async function createPageRequest(title?: string, kind?: "markdown" | "canvas"): Promise<PageMeta | null> {
  try {
    const res = await fetch("/api/pages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, ...(kind ? { kind } : {}) }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { page: PageMeta };
    return data.page;
  } catch {
    return null;
  }
}
