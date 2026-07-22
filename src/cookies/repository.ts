import type Database from "better-sqlite3";
import { toRfc3339, toUnixMilliseconds, type UtcInstant } from "../db/instants.js";

export interface CookieMetadata {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredCookie extends CookieMetadata {
  path: string;
}

export interface CreateCookieMetadataInput {
  id: string;
  name: string;
  path: string;
  now?: UtcInstant;
}

export type DeleteCookieResult = { outcome: "deleted" } | { outcome: "not_found" } | { outcome: "conflict" };

interface CookieRow {
  id: string;
  name: string;
  path: string;
  created_at: number;
  updated_at: number;
}

function mapStoredCookie(row: CookieRow): StoredCookie {
  return { id: row.id, name: row.name, path: row.path, createdAt: toRfc3339(row.created_at), updatedAt: toRfc3339(row.updated_at) };
}

function mapMetadata(row: CookieRow): CookieMetadata {
  const { path: _path, ...metadata } = mapStoredCookie(row);
  return metadata;
}

export class CookieRepository {
  constructor(private readonly database: Database.Database) {}

  createMetadata(input: CreateCookieMetadataInput): CookieMetadata {
    const now = toUnixMilliseconds(input.now ?? new Date(), "now");
    return this.database.transaction(() => {
      this.database.prepare("INSERT INTO cookies (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(input.id, input.name, input.path, now, now);
      return this.getRequired(input.id);
    })();
  }

  getById(id: string): CookieMetadata | undefined {
    const row = this.getRow(id);
    return row === undefined ? undefined : mapMetadata(row);
  }

  getStoredById(id: string): StoredCookie | undefined {
    const row = this.getRow(id);
    return row === undefined ? undefined : mapStoredCookie(row);
  }

  list(): CookieMetadata[] {
    return (this.database.prepare("SELECT id, name, path, created_at, updated_at FROM cookies ORDER BY created_at DESC").all() as CookieRow[]).map(mapMetadata);
  }

  deleteUnreferenced(id: string): DeleteCookieResult {
    return this.database.transaction((): DeleteCookieResult => {
      if (this.getRow(id) === undefined) return { outcome: "not_found" };
      const reference = this.database.prepare("SELECT 1 FROM recordings WHERE cookie_id = ? LIMIT 1").get(id);
      if (reference !== undefined) return { outcome: "conflict" };
      const result = this.database.prepare("DELETE FROM cookies WHERE id = ?").run(id);
      return result.changes === 1 ? { outcome: "deleted" } : { outcome: "conflict" };
    })();
  }

  private getRow(id: string): CookieRow | undefined {
    return this.database.prepare("SELECT id, name, path, created_at, updated_at FROM cookies WHERE id = ?").get(id) as CookieRow | undefined;
  }

  private getRequired(id: string): CookieMetadata {
    const cookie = this.getById(id);
    if (cookie === undefined) throw new Error(`Cookie ${id} disappeared during its transaction`);
    return cookie;
  }
}
