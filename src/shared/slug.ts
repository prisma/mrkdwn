/** Page ids and slugs. Ids are fixed and do the lookups; slugs are cosmetic,
 * derived from the title, and must stay `@`-mentionable (start with a letter,
 * ≤ 32 chars — the mention scanner's charset). */
import { nowId } from "./types";

/** 10 hex chars — no dashes, so `/:ws/:id-slug` splits on the first dash. */
export function newPageId(): string {
  let id = "";
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  for (const b of bytes) id += b.toString(16).padStart(2, "0");
  return id;
}

export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "") // must start with a letter to be @-mentionable
    .slice(0, 32)
    .replace(/-+$/, "");
  return base || "untitled";
}

/** Slug for a title, unique within `taken` (suffixes -2, -3, …). */
export function uniqueSlug(title: string, taken: ReadonlySet<string>): string {
  const base = slugify(title);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 28)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export { nowId };
