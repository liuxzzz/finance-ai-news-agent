import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { runPostgresMigrations } from "./migrations.js";
import { PostgresTopicDeskStore } from "./topic-desk-store.js";

const adminUrl =
  process.env.TOPIC_DESK_ADMIN_URL ?? "postgresql://agent:agent@127.0.0.1:5432/postgres";
const postgresReady = await postgresReachable(adminUrl);

if (!postgresReady && process.env.TOPIC_DESK_REQUIRE_POSTGRES === "1") {
  throw new Error("PostgreSQL is required for the topic desk migration test.");
}

describe.skipIf(!postgresReady)("postgres topic desk store", () => {
  it("migrates forward and reads a committed briefing back", async () => {
    const database = await createIsolatedDatabase(adminUrl);
    const pool = new Pool({ connectionString: database.url });

    try {
      await runPostgresMigrations(pool, {
        migrationsDirectory: fileURLToPath(new URL("../../../db/migrations", import.meta.url)),
      });
      const versions = await pool.query<{ version: string }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      expect(versions.rows.map((row) => row.version)).toContain("008_topic_desk.sql");
      const store = new PostgresTopicDeskStore(pool);
      const topic = await store.createTopic({
        id: "topic-1",
        name: "利率",
        keywords: ["利率"],
        feeds: [{ id: "local", url: "http://127.0.0.1/feed.xml", name: "Local" }],
        windowHours: 48,
        lookbackDays: 7,
        enabled: true,
        createdAt: "2026-11-20T00:00:00.000Z",
      });
      const run = await store.beginRun({
        id: "run-1",
        topicId: topic.id,
        modelMode: "stub",
        query: "利率",
        startedAt: "2026-11-20T00:00:01.000Z",
      });
      await expect(
        store.beginRun({
          id: "run-2",
          topicId: topic.id,
          modelMode: "stub",
          query: "利率",
          startedAt: "2026-11-20T00:00:02.000Z",
        }),
      ).rejects.toThrow(/running briefing/);
      const committed = await store.commitRun({
        runId: run.id,
        outcome: "ready",
        modelLabel: "local-stub/topic-desk-stub@1",
        modelInvoked: true,
        sourceOutcomes: [
          { sourceId: "local", outcome: "available", received: 1, fresh: 1, error: null },
        ],
        evidence: [
          {
            id: "ev-1",
            title: "利率",
            url: "http://127.0.0.1/ev-1",
            excerpt: "摘录",
            fingerprint: "a".repeat(64),
            titleFingerprint: "b".repeat(64),
          },
        ],
        collectedCount: 1,
        keywordMissCount: 0,
        droppedDuplicateCount: 0,
        briefing: {
          id: "briefing-1",
          title: "利率",
          markdown: "# 利率\n\n本地测试适配器",
          exportPath: null,
        },
        seen: [
          {
            topicId: topic.id,
            fingerprint: "a".repeat(64),
            titleFingerprint: "b".repeat(64),
            evidenceId: "ev-1",
            runId: run.id,
            seenAt: "2026-11-20T00:00:03.000Z",
          },
        ],
        finishedAt: "2026-11-20T00:00:03.000Z",
      });
      expect(committed.run.status).toBe("succeeded");
      expect((await store.getBriefingByRun(run.id))?.markdown).toContain("本地测试适配器");
      expect(await store.listSeenEvidence(topic.id, "2026-11-13T00:00:00.000Z")).toHaveLength(1);

      const failed = await store.beginRun({
        id: "run-3",
        topicId: topic.id,
        modelMode: "stub",
        query: "利率",
        startedAt: "2026-11-20T00:00:04.000Z",
      });
      const failure = await store.failRun(
        failed.id,
        { name: "Error", message: "model failed" },
        [],
        { collectedCount: 0, keywordMissCount: 0, droppedDuplicateCount: 0 },
        "2026-11-20T00:00:05.000Z",
      );
      expect(failure.status).toBe("failed");
      expect(failure.error?.message).toBe("model failed");
      expect(await store.listRuns(topic.id)).toHaveLength(2);
    } finally {
      await pool.end();
      await database.drop();
    }
  });
});

async function postgresReachable(connectionString: string): Promise<boolean> {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 1_000 });

  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

async function createIsolatedDatabase(connectionString: string): Promise<{
  url: string;
  drop: () => Promise<void>;
}> {
  const name = `topic_desk_${randomBytes(8).toString("hex")}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async drop() {
      const pool = new Pool({ connectionString });
      await pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await pool.end();
    },
  };
}
