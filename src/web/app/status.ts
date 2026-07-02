import { useEffect, useState } from "react";
import type { StatusPayload } from "../../shared/types";

/** Poll /api/status for agent badges (online, pending mentions). */
export function useAgentStatus(intervalMs = 5000): StatusPayload | null {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/status");
        if (res.ok && alive) setStatus((await res.json()) as StatusPayload);
      } catch {}
    };
    tick();
    const t = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [intervalMs]);
  return status;
}

/** Track sync connection through the network adapter's peer events. */
export function useConnected(adapter: {
  on(e: "peer-candidate", f: () => void): unknown;
  on(e: "peer-disconnected", f: () => void): unknown;
  off(e: "peer-candidate", f: () => void): unknown;
  off(e: "peer-disconnected", f: () => void): unknown;
}): boolean {
  const [connected, setConnected] = useState(true);
  useEffect(() => {
    const up = () => setConnected(true);
    const down = () => setConnected(false);
    adapter.on("peer-candidate", up);
    adapter.on("peer-disconnected", down);
    return () => {
      adapter.off("peer-candidate", up);
      adapter.off("peer-disconnected", down);
    };
  }, [adapter]);
  return connected;
}
