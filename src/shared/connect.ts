import type { Repo } from "@automerge/automerge-repo/slim";

/**
 * Resolve once the repo has an actual sync peer (the join/peer handshake is
 * done). `networkSubsystem.whenReady()` resolves at socket-open — calling
 * `find()` in that window can cache a permanent "unavailable" state because
 * the repo asks zero peers.
 */
export function whenPeered(repo: Repo, timeoutMs = 10_000): Promise<void> {
  if (repo.peers.length > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`no sync peer connected within ${timeoutMs}ms`));
    }, timeoutMs);
    repo.networkSubsystem.once("peer", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
