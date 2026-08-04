import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Pool, PoolClient } from "pg";

const MIGRATION_FILE_PATTERN = /^\d[^/]*\.sql$/;
const MIGRATION_LOCK_KEY = "finance-ai-news-agent:schema-migrations";

export interface RunPostgresMigrationsOptions {
  /** Defaults to `db/migrations` below the current working directory. */
  migrationsDirectory?: string;
}

/**
 * Applies immutable SQL migration files in lexical order.
 *
 * A session-level advisory lock serializes migrators across processes. Each
 * migration and its ledger entry commit atomically in their own transaction.
 */
export async function runPostgresMigrations(
  pool: Pool,
  options: RunPostgresMigrationsOptions = {},
): Promise<void> {
  const migrationsDirectory = resolve(
    options.migrationsDirectory ?? resolve(process.cwd(), "db/migrations"),
  );
  const files = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && MIGRATION_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [MIGRATION_LOCK_KEY]);
    lockAcquired = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const file of files) {
      const sql = await readFile(resolve(migrationsDirectory, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE version = $1",
        [file],
      );
      const applied = existing.rows[0];

      if (applied !== undefined) {
        if (applied.checksum !== checksum) {
          throw new Error(
            `Migration ${file} has changed since it was applied (expected ${applied.checksum}, received ${checksum}).`,
          );
        }

        continue;
      }

      await applyMigration(client, file, checksum, sql);
    }
  } finally {
    let releaseNormally = true;

    if (lockAcquired) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
          MIGRATION_LOCK_KEY,
        ]);
      } catch (error) {
        client.release(asError(error));
        releaseNormally = false;
      }
    }

    if (releaseNormally) {
      client.release();
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function applyMigration(
  client: PoolClient,
  version: string,
  checksum: string,
  sql: string,
): Promise<void> {
  await client.query("BEGIN");

  try {
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [
      version,
      checksum,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
