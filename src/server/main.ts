import { existsSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "./server";
import { ensureDevDatabase, type DevDatabase } from "./devdb";

const isProd = process.env.NODE_ENV === "production";

let web: unknown;
let webDist: string | undefined;
if (isProd) {
  webDist = join(import.meta.dir, "../../dist/web");
  if (!existsSync(join(webDist, "index.html"))) {
    console.error("dist/web/index.html not found — run `bun run build` before starting in production");
    process.exit(1);
  }
} else {
  // dev: Bun's fullstack server bundles + HMRs the frontend on the fly
  web = (await import("../web/index.html")).default;
}

// The workspace registry lives in Prisma Postgres. Locally, spin one up via
// @prisma/dev (stateful named instance — survives restarts) unless a real
// DATABASE_URL is configured.
let devDb: DevDatabase | undefined;
if (!process.env.DATABASE_URL) {
  if (isProd) {
    console.warn("DATABASE_URL not set — falling back to the in-memory workspace registry");
  } else {
    devDb = await ensureDevDatabase();
    process.env.DATABASE_URL = devDb.url;
    console.log(`prisma dev database ready (${devDb.url.replace(/:[^:@/]+@/, ":…@")})`);
  }
}

const running = await startServer({ web, webDist });

process.on("SIGINT", async () => {
  await running.stop();
  await devDb?.close();
  process.exit(0);
});
