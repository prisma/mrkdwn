/** Deterministic PRNG (mulberry32) so every generated test case reproduces
 * exactly from its seed — a failing case number is a repro, not a shrug. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(r: () => number, arr: readonly T[]): T {
  return arr[Math.floor(r() * arr.length)]!;
}

export function int(r: () => number, min: number, max: number): number {
  return min + Math.floor(r() * (max - min + 1));
}

export const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "omega", "kappa", "sigma", "tau"] as const;

export function words(r: () => number, min = 1, max = 3): string {
  return Array.from({ length: int(r, min, max) }, () => pick(r, WORDS)).join(" ");
}
