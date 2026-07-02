import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export interface PersistedState {
  /** legacy pointer from the pre-workspace single-doc era; kept so old data
   * dirs migrate their doc into the workspace registry on boot */
  docUrl?: string;
  /** bearer token agents use against /api — generated on first boot */
  agentToken: string;
  createdAt: string;
}

export interface S3Config {
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
}

export interface ServerConfig {
  port: number;
  dataDir: string;
  /** public base url used in agent snippets, e.g. http://localhost:4545 */
  baseUrl: string;
  /** Prisma Postgres connection; unset → in-memory registry (tests) */
  databaseUrl?: string;
  /** durable S3 mirror for automerge files; unset → persistence disabled */
  s3?: S3Config;
  /** agent edits are "typed" into docs at human speed; unset → instant */
  agentTyping?: { intervalMs: number; budgetMs: number };
  /** the single public workspace (v1: permissions are org-level only) */
  workspace: { handle: string; name: string };
  state: PersistedState;
  saveState(): void;
}

export function s3ConfigFromEnv(env: Record<string, string | undefined> = process.env): S3Config | undefined {
  const accessKeyId = env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return undefined;
  return {
    accessKeyId,
    secretAccessKey,
    bucket: env.S3_BUCKET ?? "mrkdwn",
    endpoint: env.S3_ENDPOINT ?? "https://t3.storage.dev",
  };
}

export function loadConfig(
  overrides: Partial<{ port: number; dataDir: string; baseUrl: string; databaseUrl: string }> = {}
): ServerConfig {
  const port = overrides.port ?? Number(process.env.PORT ?? 4545);
  const dataDir = resolve(overrides.dataDir ?? process.env.MRKDWN_DATA ?? "data");
  const baseUrl = (overrides.baseUrl ?? process.env.MRKDWN_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
  const databaseUrl = overrides.databaseUrl ?? process.env.DATABASE_URL ?? undefined;
  const workspace = {
    handle: process.env.MRKDWN_WORKSPACE ?? "public",
    name: process.env.MRKDWN_WORKSPACE_NAME ?? "Public",
  };

  mkdirSync(dataDir, { recursive: true });
  const stateFile = join(dataDir, "config.json");

  let state: PersistedState;
  if (existsSync(stateFile)) {
    state = JSON.parse(readFileSync(stateFile, "utf8")) as PersistedState;
    if (!state.agentToken) state.agentToken = newToken();
  } else {
    state = { agentToken: newToken(), createdAt: new Date().toISOString() };
  }
  // deployments with ephemeral disks set the token via env so agent invites
  // survive redeploys (the generated one rotates with every fresh data dir)
  if (process.env.MRKDWN_AGENT_TOKEN) state.agentToken = process.env.MRKDWN_AGENT_TOKEN;

  const s3 = s3ConfigFromEnv();
  // agent edits type in at human speed (set MRKDWN_AGENT_TYPING=off for instant)
  const agentTyping =
    process.env.MRKDWN_AGENT_TYPING === "off" ? undefined : { intervalMs: 35, budgetMs: 4000 };

  const config: ServerConfig = {
    port,
    dataDir,
    baseUrl,
    ...(databaseUrl ? { databaseUrl } : {}),
    ...(s3 ? { s3 } : {}),
    ...(agentTyping ? { agentTyping } : {}),
    workspace,
    state,
    saveState() {
      writeFileSync(stateFile, JSON.stringify(state, null, 2));
    },
  };
  config.saveState();
  return config;
}

function newToken(): string {
  return `mk_${randomBytes(24).toString("hex")}`;
}

/** Constant-time-ish token check (length leak is fine for random 48-hex tokens). */
export function tokenMatches(given: string | null, expected: string): boolean {
  if (!given || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
