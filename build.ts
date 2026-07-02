/** Production frontend build: `bun run build` → dist/web (served by the
 * server when NODE_ENV=production). */
import { rmSync } from "node:fs";
import automergePlugin from "./automerge.plugin";

rmSync("dist/web", { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/web/index.html"],
  outdir: "dist/web",
  target: "browser",
  minify: true,
  sourcemap: "linked",
  plugins: [automergePlugin],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Bun emits relative asset URLs ("./chunk-*.js") in index.html; deep links
// like /{ws}/{id}-{slug} serve the same shell from a nested path, where
// relative URLs 404. Root them.
const indexPath = "dist/web/index.html";
const html = await Bun.file(indexPath).text();
await Bun.write(indexPath, html.replaceAll('src="./', 'src="/').replaceAll('href="./', 'href="/'));

for (const out of result.outputs) {
  console.log(`  ${out.path.replace(process.cwd() + "/", "")}  ${(out.size / 1024).toFixed(1)} kB`);
}
console.log("web build ready → dist/web");
