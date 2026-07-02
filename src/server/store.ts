/**
 * Workspace/document registry. Automerge remains the content store; this is
 * the metadata layer: which workspaces exist, which documents live in them,
 * and how titles map to slugs.
 *
 * Two implementations behind one seam:
 *  - PrismaStore — Prisma Next (`db.orm.public.*`) against Prisma Postgres
 *    (`@prisma/dev` locally). The default whenever DATABASE_URL is set.
 *  - MemoryStore — tests and DB-less fallback.
 */
import postgres from "@prisma-next/postgres/runtime";
import type { Contract } from "../prisma/contract.d";
import contractJson from "../prisma/contract.json" with { type: "json" };

export interface WorkspaceRecord {
  id: string;
  handle: string;
  name: string;
  isPublic: boolean;
}

export type DocumentKind = "markdown" | "canvas";

export interface DocumentRecord {
  id: string;
  workspaceId: string;
  title: string;
  slug: string;
  /** absent/"markdown" = markdown page; "canvas" = JSON Canvas board */
  kind?: DocumentKind;
  automergeUrl: string;
  /** last completed S3 write (persist worker), if any */
  persistedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ImageRecord {
  id: string;
  workspaceId: string;
  contentType: string;
  width: number;
  height: number;
  byteSize: number;
  createdAt: number;
}

export interface DocStore {
  /** Find-or-create the single public workspace. */
  ensurePublicWorkspace(handle: string, name: string): Promise<WorkspaceRecord>;
  listDocuments(workspaceId: string): Promise<DocumentRecord[]>;
  createDocument(rec: Omit<DocumentRecord, "createdAt" | "updatedAt" | "persistedAt">): Promise<DocumentRecord>;
  updateDocument(id: string, patch: { title: string; slug: string }): Promise<void>;
  /** Record a completed S3 write. Called by the persist worker only — never
   * on the edit hot path. */
  markPersisted(id: string, when: Date): Promise<void>;
  createImage(rec: Omit<ImageRecord, "createdAt">): Promise<ImageRecord>;
  getImage(id: string): Promise<ImageRecord | null>;
  close(): Promise<void>;
}

// ---------- Prisma Next ----------

type Db = ReturnType<typeof postgres<Contract>>;

export class PrismaStore implements DocStore {
  private db: Db;

  constructor(url: string) {
    this.db = postgres<Contract>({ contractJson: contractJson as never, url });
  }

  private get orm() {
    return this.db.orm.public;
  }

  async ensurePublicWorkspace(handle: string, name: string): Promise<WorkspaceRecord> {
    const existing = await this.orm.Workspace.where({ handle }).first();
    if (existing) return existing;
    return await this.orm.Workspace.create({ id: `ws_${handle}`, handle, name, isPublic: true });
  }

  async listDocuments(workspaceId: string): Promise<DocumentRecord[]> {
    const rows = await this.orm.Document.where({ workspaceId })
      .orderBy(d => d.createdAt.asc())
      .all();
    return rows.map(rowToDoc);
  }

  async createDocument(rec: Omit<DocumentRecord, "createdAt" | "updatedAt" | "persistedAt">): Promise<DocumentRecord> {
    const row = await this.orm.Document.create({ ...rec, kind: rec.kind ?? null, updatedAt: new Date() });
    return rowToDoc(row);
  }

  async updateDocument(id: string, patch: { title: string; slug: string }): Promise<void> {
    await this.orm.Document.where({ id }).update({ ...patch, updatedAt: new Date() });
  }

  async markPersisted(id: string, when: Date): Promise<void> {
    await this.orm.Document.where({ id }).update({ persistedAt: when });
  }

  async createImage(rec: Omit<ImageRecord, "createdAt">): Promise<ImageRecord> {
    const row = await this.orm.Image.create(rec);
    return { ...rec, createdAt: row.createdAt.getTime() };
  }

  async getImage(id: string): Promise<ImageRecord | null> {
    const row = await this.orm.Image.where({ id }).first();
    return row ? { ...row, createdAt: row.createdAt.getTime() } : null;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

function rowToDoc(row: {
  id: string;
  workspaceId: string;
  title: string;
  slug: string;
  kind?: string | null;
  automergeUrl: string;
  persistedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): DocumentRecord {
  return {
    ...row,
    kind: row.kind === "canvas" ? "canvas" : undefined,
    persistedAt: row.persistedAt ? row.persistedAt.getTime() : undefined,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

// ---------- in-memory (tests / DB-less) ----------

export class MemoryStore implements DocStore {
  private workspaces = new Map<string, WorkspaceRecord>();
  private documents = new Map<string, DocumentRecord>();
  private images = new Map<string, ImageRecord>();

  async ensurePublicWorkspace(handle: string, name: string): Promise<WorkspaceRecord> {
    let ws = [...this.workspaces.values()].find(w => w.handle === handle);
    if (!ws) {
      ws = { id: `ws_${handle}`, handle, name, isPublic: true };
      this.workspaces.set(ws.id, ws);
    }
    return ws;
  }

  async listDocuments(workspaceId: string): Promise<DocumentRecord[]> {
    return [...this.documents.values()]
      .filter(d => d.workspaceId === workspaceId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async createDocument(rec: Omit<DocumentRecord, "createdAt" | "updatedAt" | "persistedAt">): Promise<DocumentRecord> {
    const now = Date.now();
    const doc: DocumentRecord = { ...rec, createdAt: now, updatedAt: now };
    this.documents.set(doc.id, doc);
    return doc;
  }

  async updateDocument(id: string, patch: { title: string; slug: string }): Promise<void> {
    const doc = this.documents.get(id);
    if (doc) Object.assign(doc, patch, { updatedAt: Date.now() });
  }

  async markPersisted(id: string, when: Date): Promise<void> {
    const doc = this.documents.get(id);
    if (doc) doc.persistedAt = when.getTime();
  }

  async createImage(rec: Omit<ImageRecord, "createdAt">): Promise<ImageRecord> {
    const image: ImageRecord = { ...rec, createdAt: Date.now() };
    this.images.set(image.id, image);
    return image;
  }

  async getImage(id: string): Promise<ImageRecord | null> {
    return this.images.get(id) ?? null;
  }

  async close(): Promise<void> {}
}

export function createStore(databaseUrl: string | undefined): DocStore {
  if (databaseUrl) return new PrismaStore(databaseUrl);
  return new MemoryStore();
}
