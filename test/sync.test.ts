import { afterAll, beforeAll, expect, test } from "bun:test";
import * as A from "@automerge/automerge";
import type { DocHandle } from "@automerge/automerge-repo";
import { makeWorld, until, type TestWorld } from "./helpers";
import type { MrkdwnDoc, PresenceMessage } from "../src/shared/types";

let world: TestWorld;

beforeAll(async () => {
  world = await makeWorld();
});

afterAll(async () => {
  await world.stop();
});

test("browser-style client syncs the doc from the Bun server", async () => {
  const { handle } = await world.connect();
  const doc = (handle as DocHandle<MrkdwnDoc>).doc();
  expect(doc.title).toBe("Welcome to mrkdwn");
  expect(doc.content).toContain("humans and AI agents write together");
}, 15000);

test("client edits reach the server and a second client", async () => {
  const a = await world.connect();
  const b = await world.connect();
  const handleA = a.handle as DocHandle<MrkdwnDoc>;
  const handleB = b.handle as DocHandle<MrkdwnDoc>;

  handleA.change(d => A.splice(d, ["content"], 0, 0, "SYNC-MARKER "));

  await until(() => world.running.ctx.host.handle.doc().content, c => c.startsWith("SYNC-MARKER"));
  await until(() => handleB.doc().content, c => c.startsWith("SYNC-MARKER"));

  // concurrent edits from both clients merge without losing either
  handleA.change(d => A.splice(d, ["content"], d.content.length, 0, "\nfrom-a"));
  handleB.change(d => A.splice(d, ["content"], d.content.length, 0, "\nfrom-b"));
  await until(
    () => world.running.ctx.host.handle.doc().content,
    c => c.includes("from-a") && c.includes("from-b")
  );
}, 15000);

test("ephemeral presence messages relay between clients through the server", async () => {
  const a = await world.connect();
  const b = await world.connect();
  const handleA = a.handle as DocHandle<MrkdwnDoc>;
  const handleB = b.handle as DocHandle<MrkdwnDoc>;

  const received: PresenceMessage[] = [];
  handleB.on("ephemeral-message", p => received.push(p.message as PresenceMessage));

  const msg: PresenceMessage = {
    type: "presence",
    user: { id: "u1", name: "Test Human", color: "#123456", kind: "human" },
    anchor: null,
    head: null,
    ts: Date.now(),
  };
  // ephemeral channels need a beat to establish; rebroadcast until seen
  await until(
    () => {
      handleA.broadcast(msg);
      return received.length;
    },
    n => n > 0,
    8000,
    250
  );
  expect(received[0]!.user.name).toBe("Test Human");
}, 15000);

test("agent REST presence broadcast reaches websocket clients", async () => {
  const c = await world.connect();
  const handle = c.handle as DocHandle<MrkdwnDoc>;
  const received: PresenceMessage[] = [];
  handle.on("ephemeral-message", p => received.push(p.message as PresenceMessage));

  await until(
    async () => {
      const res = await world.authed("/api/presence", { method: "POST", agent: "claude" });
      expect(res.status).toBe(200);
      return received.filter(m => m.user.id === "agent:claude").length;
    },
    n => n > 0,
    8000,
    250
  );
  expect(received.find(m => m.user.id === "agent:claude")!.user.kind).toBe("agent");
}, 15000);

test("doc persists across server restarts", async () => {
  // separate world so we don't disturb the shared one
  const w = await makeWorld();
  const marker = `persist-${Date.now()}`;
  const res = await w.authed("/api/doc/append", {
    method: "POST",
    body: JSON.stringify({ markdown: marker }),
  });
  expect(res.status).toBe(200);
  await w.running.ctx.host.repo.flush();
  await w.running.stop();

  const { loadConfig } = await import("../src/server/config");
  const { startServer } = await import("../src/server/server");
  const config2 = loadConfig({ port: 0, dataDir: w.tmp });
  delete config2.s3; // same guard as makeWorld: never touch a real bucket
  const running2 = await startServer({ config: config2 });
  expect(running2.ctx.host.handle.doc().content).toContain(marker);
  await running2.stop();
}, 20000);
