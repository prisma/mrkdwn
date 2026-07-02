/** Collaborator colors + anonymous human names. Deterministic per id so every
 * peer renders the same person in the same color. */

const PALETTE = [
  "#e8590c", // burnt orange
  "#5f3dc4", // violet
  "#0b7285", // teal
  "#c2255c", // raspberry
  "#2b8a3e", // forest
  "#1971c2", // blue
  "#9c36b5", // grape
  "#e67700", // amber
  "#3b5bdb", // indigo
  "#087f5b", // sea green
] as const;

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function colorFor(id: string): string {
  return PALETTE[hashCode(id) % PALETTE.length]!;
}

const ADJECTIVES = ["Amber", "Brisk", "Coral", "Dapper", "Eager", "Fuzzy", "Gentle", "Humming", "Ivory", "Jolly", "Keen", "Lively", "Mellow", "Nimble", "Opal", "Plucky", "Quiet", "Rosy", "Swift", "Tidy", "Umber", "Vivid", "Wandering", "Zesty"];
const ANIMALS = ["Fox", "Otter", "Heron", "Lynx", "Marmot", "Narwhal", "Puffin", "Quokka", "Raccoon", "Swift", "Tapir", "Urchin", "Vole", "Wombat", "Yak", "Zebra", "Badger", "Crane", "Dormouse", "Egret"];

export function anonName(id: string): string {
  const h = hashCode(id);
  return `${ADJECTIVES[h % ADJECTIVES.length]} ${ANIMALS[(h >> 5) % ANIMALS.length]}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]?.toUpperCase() ?? "").join("") || "?";
}
