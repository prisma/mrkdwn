import { anonName, colorFor } from "../../shared/identity";
import { nowId, type Author } from "../../shared/types";

const KEY = "mrkdwn:identity";

export function loadIdentity(): Author {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as { id: string; name: string };
      if (saved.id && saved.name) return withColor(saved);
    }
  } catch {}
  const fresh = { id: nowId("u"), name: "" };
  fresh.name = anonName(fresh.id);
  localStorage.setItem(KEY, JSON.stringify(fresh));
  return withColor(fresh);
}

export function renameIdentity(current: Author, name: string): Author {
  const next = { id: current.id, name: name.trim() || anonName(current.id) };
  localStorage.setItem(KEY, JSON.stringify(next));
  return withColor(next);
}

function withColor(u: { id: string; name: string }): Author {
  return { ...u, color: colorFor(u.id), kind: "human" };
}
