import type Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertSupportedNodeVersion, loadConfig } from "../config.js";
import { enforceDatabaseFileModes, openDatabase } from "./connection.js";

interface MigrationFile {
  version: number;
  filename: string;
  sql: string;
}

const migrationName = /^(\d+)-[a-z0-9][a-z0-9-]*\.sql$/;

export const defaultMigrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));

function loadMigrations(directory: string): MigrationFile[] {
  const migrations = readdirSync(directory)
    .map((filename) => {
      const match = migrationName.exec(filename);
      if (!match) return undefined;
      const version = Number(match[1]);
      if (!Number.isSafeInteger(version) || version < 1) throw new Error(`Invalid migration version in ${filename}`);
      return { version, filename, sql: readFileSync(new URL(filename, `file://${directory}/`), "utf8") };
    })
    .filter((migration): migration is MigrationFile => migration !== undefined)
    .sort((left, right) => left.version - right.version);
  if (migrations.length === 0) throw new Error(`No migrations found in ${directory}`);
  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index - 1]!.version === migrations[index]!.version) {
      throw new Error(`Duplicate migration version ${migrations[index]!.version}`);
    }
  }
  return migrations;
}

export function migrateDatabase(database: Database.Database, directory = defaultMigrationsDirectory): void {
  const migrations = loadMigrations(directory);
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
  const available = new Set(migrations.map(({ version }) => version));
  for (const { version } of applied) {
    if (!available.has(version)) throw new Error(`Applied migration ${version} is missing from ${directory}`);
  }
  const isApplied = new Set(applied.map(({ version }) => version));
  const recordApplied = database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");
  for (const migration of migrations) {
    if (isApplied.has(migration.version)) continue;
    database.transaction(() => {
      database.exec(migration.sql);
      recordApplied.run(migration.version, Date.now());
    })();
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  assertSupportedNodeVersion();
  const config = loadConfig();
  const database = openDatabase(config.databasePath);
  try {
    migrateDatabase(database);
    enforceDatabaseFileModes(config.databasePath);
  } finally {
    database.close();
  }
}
