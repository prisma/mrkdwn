/** The real data layer: PrismaStore against a live Prisma Postgres
 * (@prisma/dev, pglite) with the schema applied via `prisma-next db init`.
 * Exercises the same store contract the server uses. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startPrismaDevServer, type Server } from "@prisma/dev";
import { applySchema } from "../src/server/devdb";
import { PrismaStore } from "../src/server/store";

let server: Server;
let store: PrismaStore;

beforeAll(async () => {
  server = await startPrismaDevServer({
    name: `mrkdwn-test-${Date.now().toString(36)}`,
    persistenceMode: "stateless",
    port: 0,
    databasePort: 0,
    shadowDatabasePort: 0,
    streamsPort: 0,
  });
  await applySchema(server.database.connectionString);
  store = new PrismaStore(server.database.connectionString);
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.close();
});

test("ensurePublicWorkspace is idempotent", async () => {
  const a = await store.ensurePublicWorkspace("public", "Public");
  const b = await store.ensurePublicWorkspace("public", "Renamed later");
  expect(a.id).toBe(b.id);
  expect(b.name).toBe("Public"); // find-or-create: the original row wins
  expect(a.isPublic).toBe(true);
});

test("documents round-trip with title/slug updates", async () => {
  const ws = await store.ensurePublicWorkspace("public", "Public");
  const created = await store.createDocument({
    id: "doc1",
    workspaceId: ws.id,
    title: "Welcome",
    slug: "welcome",
    automergeUrl: "automerge:abc",
  });
  expect(created.createdAt).toBeGreaterThan(0);

  await store.createDocument({
    id: "doc2",
    workspaceId: ws.id,
    title: "Second",
    slug: "second",
    automergeUrl: "automerge:def",
  });

  await store.updateDocument("doc1", { title: "Hello", slug: "hello" });

  const docs = await store.listDocuments(ws.id);
  expect(docs.map(d => d.id)).toEqual(["doc1", "doc2"]); // createdAt order
  expect(docs[0]!.title).toBe("Hello");
  expect(docs[0]!.slug).toBe("hello");
  expect(docs[0]!.updatedAt).toBeGreaterThanOrEqual(docs[0]!.createdAt);
});
