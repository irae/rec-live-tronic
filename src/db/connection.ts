import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export interface DatabaseConnectionOptions {
  readonly?: boolean;
  busyTimeoutMs?: number;
}

function pragmaValue(result: unknown, name: string): unknown {
  if (!Array.isArray(result) || result.length !== 1 || typeof result[0] !== "object" || result[0] === null) {
    throw new Error(`SQLite did not return a value for PRAGMA ${name}`);
  }
  return (result[0] as Record<string, unknown>)[name];
}

export function enforceDatabaseFileModes(databasePath: string): void {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(path)) chmodSync(path, 0o660);
  }
}

export function openDatabase(databasePath: string, options: DatabaseConnectionOptions = {}): Database.Database {
  const readonly = options.readonly ?? false;
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1) {
    throw new Error("SQLite busy timeout must be a positive integer");
  }

  if (!readonly) {
    process.umask(0o007);
    // The data directory is provisioned setgid (2770) by install-root.sh so
    // rec-media group members share ownership of files created inside it;
    // 0o770 here (without the setgid bit) would silently strip that on
    // every DB open, which install-root.sh's post-install verification
    // then catches as "incorrect data directory mode".
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o2770 });
    chmodSync(dirname(databasePath), 0o2770);
  }

  const database = new Database(databasePath, { readonly, fileMustExist: readonly });
  try {
    if (!readonly) {
      const journalMode = pragmaValue(database.pragma("journal_mode = WAL"), "journal_mode");
      if (String(journalMode).toLowerCase() !== "wal") throw new Error("SQLite WAL mode is unavailable");
    }
    database.pragma("foreign_keys = ON");
    if (Number(pragmaValue(database.pragma("foreign_keys"), "foreign_keys")) !== 1) {
      throw new Error("SQLite foreign key enforcement is unavailable");
    }
    database.pragma(`busy_timeout = ${busyTimeoutMs}`);
    if (Number(pragmaValue(database.pragma("busy_timeout"), "timeout")) !== busyTimeoutMs) {
      throw new Error("SQLite busy timeout could not be configured");
    }
    if (!readonly) enforceDatabaseFileModes(databasePath);
    return database;
  } catch (error) {
    console.error(`Failed to initialize database at ${databasePath}:`, error);
    database.close();
    throw error;
  }
}
