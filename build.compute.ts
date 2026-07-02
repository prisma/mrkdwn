/**
 * Assemble a self-contained Prisma Compute artifact in dist/compute:
 * the server + shared sources (bun runs TS directly), the prebuilt web
 * bundle, and production node_modules. The platform copies this directory
 * verbatim and runs the entrypoint (see prisma.compute.ts).
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = import.meta.dir;
const out = join(root, "dist/compute");

async function run(cmd: string[], cwd = root): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(" ")} failed`);
}

// 1. frontend bundle → dist/web
await run(["bun", "build.ts"]);

// 2. fresh artifact dir
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// 3. sources + built frontend + manifest (no .env, no data/)
await cp(join(root, "src"), join(out, "src"), { recursive: true });
await cp(join(root, "dist/web"), join(out, "dist/web"), { recursive: true });
for (const f of ["package.json", "bun.lock", "bunfig.toml", "automerge.plugin.ts", "prisma-next.config.ts"]) {
  await cp(join(root, f), join(out, f));
}

// 4. production dependencies inside the artifact
await run(["bun", "install", "--production", "--no-save"], out);

console.log("compute artifact ready → dist/compute");
