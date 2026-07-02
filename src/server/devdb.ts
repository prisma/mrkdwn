/**
 * Local development database: a Prisma Postgres instance via `@prisma/dev`
 * (pglite under the hood), started programmatically when no DATABASE_URL is
 * set, plus a `prisma-next db init` pass so the schema always matches the
 * emitted contract. Stateful named instance — data survives restarts.
 */
import { startPrismaDevServer, type Server } from "@prisma/dev";

export interface DevDatabase {
  url: string;
  close(): Promise<void>;
}

export async function ensureDevDatabase(name = "mrkdwn"): Promise<DevDatabase> {
  // Ports must be explicit: @prisma/dev falls back to the PORT env var, which
  // is the app server's own port — the instance would then persist that port
  // for its database/shadow/http listeners and collide forever after.
  const basePort = Number(process.env.MRKDWN_DEVDB_PORT ?? 45451);
  const server: Server = await startPrismaDevServer({
    name,
    persistenceMode: "stateful",
    port: basePort,
    databasePort: basePort + 1,
    shadowDatabasePort: basePort + 2,
    streamsPort: basePort + 3,
  });
  const url = server.database.connectionString;
  await applySchema(url);
  return {
    url,
    close: () => server.close(),
  };
}

/** `prisma-next db init` is idempotent against an up-to-date DB; contract
 * changes during development go through `prisma-next db update` / migrations. */
export async function applySchema(url: string): Promise<void> {
  const proc = Bun.spawn(["bun", "prisma-next", "db", "init", "-y", "--json"], {
    cwd: import.meta.dir + "/../..",
    env: { ...process.env, DATABASE_URL: url },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exit = await proc.exited;
  if (exit !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`prisma-next db init failed (exit ${exit}): ${err.slice(0, 500)}`);
  }
}
