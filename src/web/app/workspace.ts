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

export async function createPageRequest(title?: string, kind?: PageMeta["kind"]): Promise<PageMeta | null> {
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

/** Fork a page: a new page initialized from the source's full history. */
export async function forkPageRequest(pageId: string, title?: string): Promise<PageMeta | null> {
  try {
    const res = await fetch("/api/pages/fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page: pageId, ...(title ? { title } : {}) }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { page: PageMeta };
    return data.page;
  } catch {
    return null;
  }
}

/** Upload a HyperFrames project zip → a new hyperframes page. */
export async function uploadHyperframesRequest(file: File): Promise<{ page: PageMeta } | { error: string }> {
  const title = file.name.replace(/\.zip$/i, "").trim() || "Untitled video";
  try {
    const res = await fetch(`/api/hyperframes/upload?title=${encodeURIComponent(title)}`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: file,
    });
    const data = (await res.json()) as { page?: PageMeta; error?: string };
    if (!res.ok || !data.page) return { error: data.error ?? `upload failed (${res.status})` };
    return { page: data.page };
  } catch (e) {
    return { error: String(e) };
  }
}
