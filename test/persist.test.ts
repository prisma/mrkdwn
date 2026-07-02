/** The S3 persist worker: dirty-tracking, ≥interval coalescing, object
 * naming, persistedAt bookkeeping, retries. Uses a fake object writer —
 * no real bucket is ever touched from tests. */
import { describe, expect, test } from "bun:test";
import * as A from "@automerge/automerge";
import { Repo } from "@automerge/automerge-repo";
import { PersistWorker, sameHeads, type ObjectWriter } from "../src/server/persist";
import { MemoryStore } from "../src/server/store";
import type { PageEntry } from "../src/server/repo";
import type { MrkdwnDoc } from "../src/shared/types";

const INTERVAL = 40;

class FakeS3 implements ObjectWriter {
  writes: { key: string; bytes: Uint8Array; at: number }[] = [];
  failNext = 0;
  async write(key: string, bytes: Uint8Array): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("simulated s3 outage");
    }
    this.writes.push({ key, bytes, at: Date.now() });
  }
}

async function makePage(id = "p1"): Promise<{ entry: PageEntry; repo: Repo; store: MemoryStore }> {
  const repo = new Repo({ network: [] });
  const handle = repo.create<MrkdwnDoc>({ title: "T", content: "hello", comments: {} });
  const store = new MemoryStore();
  const ws = await store.ensurePublicWorkspace("public", "Public");
  const record = await store.createDocument({
    id,
    workspaceId: ws.id,
    title: "T",
    slug: "t",
    automergeUrl: handle.url,
  });
  return { entry: { record, handle }, repo, store };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("PersistWorker", () => {
  test("baseline write on watch, correct object key, loadable bytes", async () => {
    const { entry, store } = await makePage();
    const s3 = new FakeS3();
    const worker = new PersistWorker(s3, store, "ws_public", { intervalMs: INTERVAL });
    worker.watch(entry);
    await worker.settle();

    expect(s3.writes.length).toBe(1);
    expect(s3.writes[0]!.key).toBe("ws_public/p1.automerge");
    // the object is a complete automerge file — restore is one A.load
    const restored = A.load<MrkdwnDoc>(s3.writes[0]!.bytes);
    expect(restored.content).toBe("hello");
    expect((await store.listDocuments("ws_public"))[0]!.persistedAt).toBeGreaterThan(0);
    worker.dispose();
  });

  test("a burst of changes coalesces into a single write", async () => {
    const { entry, store } = await makePage();
    const s3 = new FakeS3();
    const worker = new PersistWorker(s3, store, "ws_public", { intervalMs: INTERVAL });
    worker.watch(entry);
    await worker.settle();
    expect(s3.writes.length).toBe(1);

    // ten rapid edits inside one interval
    for (let i = 0; i < 10; i++) {
      entry.handle.change(d => A.splice(d, ["content"], d.content.length, 0, `${i}`));
    }
    await worker.settle();
    expect(s3.writes.length).toBe(2); // one baseline + one coalesced write
    const restored = A.load<MrkdwnDoc>(s3.writes[1]!.bytes);
    expect(restored.content).toBe("hello0123456789");
    worker.dispose();
  });

  test("writes are spaced at least intervalMs apart", async () => {
    const { entry, store } = await makePage();
    const s3 = new FakeS3();
    const worker = new PersistWorker(s3, store, "ws_public", { intervalMs: INTERVAL });
    worker.watch(entry);
    await worker.settle();

    entry.handle.change(d => A.splice(d, ["content"], 0, 0, "a"));
    await worker.settle();
    entry.handle.change(d => A.splice(d, ["content"], 0, 0, "b"));
    await worker.settle();

    expect(s3.writes.length).toBe(3);
    for (let i = 1; i < s3.writes.length; i++) {
      expect(s3.writes[i]!.at - s3.writes[i - 1]!.at).toBeGreaterThanOrEqual(INTERVAL - 5);
    }
    worker.dispose();
  });

  test("no writes when nothing changed", async () => {
    const { entry, store } = await makePage();
    const s3 = new FakeS3();
    const worker = new PersistWorker(s3, store, "ws_public", { intervalMs: INTERVAL });
    worker.watch(entry);
    await worker.settle();
    await sleep(INTERVAL * 3);
    expect(s3.writes.length).toBe(1); // only the baseline
    worker.dispose();
  });

  test("failed writes retry and eventually persist", async () => {
    const { entry, store } = await makePage();
    const s3 = new FakeS3();
    s3.failNext = 1;
    const worker = new PersistWorker(s3, store, "ws_public", { intervalMs: INTERVAL });
    worker.watch(entry);
    await worker.settle(15_000);
    expect(s3.writes.length).toBe(1);
    expect(worker.pendingCount()).toBe(0);
    worker.dispose();
  });
});

describe("sameHeads", () => {
  test("order-insensitive equality", () => {
    expect(sameHeads(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameHeads(["a"], ["a", "b"])).toBe(false);
    expect(sameHeads([], [])).toBe(true);
  });
});
