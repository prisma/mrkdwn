/**
 * Prisma Compute deploy config. The build assembles a self-contained
 * artifact (sources + built frontend + production node_modules) in
 * dist/compute — see build.compute.ts — and the platform runs the Bun
 * entrypoint inside it. Secrets (DATABASE_URL, S3_*) are provided as
 * deploy env vars, never committed.
 */
export default {
  region: "us-east-1",
  app: {
    name: "mrkdwn",
    framework: "bun",
    httpPort: 4545,
    build: {
      command: "bun build.compute.ts",
      outputDirectory: "dist/compute",
      entrypoint: "src/server/main.ts",
    },
  },
} as const;
