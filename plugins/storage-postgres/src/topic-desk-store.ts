import type {
  BeginTopicRunInput,
  CommitTopicRunInput,
  CreateTopicInput,
  TopicBriefingRecord,
  TopicDeskStore,
  TopicEvidenceRecord,
  TopicFeed,
  TopicRecord,
  TopicRunOutcome,
  TopicRunRecord,
  TopicRunStatus,
  TopicSeenEvidenceRecord,
  TopicSourceOutcome,
  UpdateTopicInput,
} from "@finance-ai-news-agent/plugin-sdk";
import { TopicRunAlreadyActiveError } from "@finance-ai-news-agent/plugin-sdk";
import type { Pool, PoolClient, QueryResultRow } from "pg";

const TOPIC_COLUMNS = `
  id, name, keywords, feeds, window_hours, lookback_days, enabled, created_at, updated_at
`;

const RUN_COLUMNS = `
  id, topic_id, status, outcome, model_mode, model_label, model_invoked, query,
  source_outcomes, evidence, collected_count, keyword_miss_count, dropped_duplicate_count,
  error, started_at, finished_at
`;

export class PostgresTopicDeskStore implements TopicDeskStore {
  constructor(private readonly pool: Pool) {}

  async createTopic(input: CreateTopicInput): Promise<TopicRecord> {
    const result = await this.pool.query<TopicRow>(
      `INSERT INTO topics (
         id, name, keywords, feeds, window_hours, lookback_days, enabled, created_at, updated_at
       ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $8)
       RETURNING ${TOPIC_COLUMNS}`,
      [
        input.id,
        input.name,
        JSON.stringify(input.keywords),
        JSON.stringify(input.feeds),
        input.windowHours,
        input.lookbackDays,
        input.enabled,
        input.createdAt,
      ],
    );
    return mapTopic(requiredRow(result.rows[0], "topics"));
  }

  async updateTopic(id: string, input: UpdateTopicInput): Promise<TopicRecord | null> {
    const result = await this.pool.query<TopicRow>(
      `UPDATE topics
       SET name = $2,
           keywords = $3::jsonb,
           feeds = $4::jsonb,
           window_hours = $5,
           lookback_days = $6,
           enabled = $7,
           updated_at = $8
       WHERE id = $1
       RETURNING ${TOPIC_COLUMNS}`,
      [
        id,
        input.name,
        JSON.stringify(input.keywords),
        JSON.stringify(input.feeds),
        input.windowHours,
        input.lookbackDays,
        input.enabled,
        input.updatedAt,
      ],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapTopic(row);
  }

  async getTopic(id: string): Promise<TopicRecord | null> {
    const result = await this.pool.query<TopicRow>(
      `SELECT ${TOPIC_COLUMNS} FROM topics WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapTopic(row);
  }

  async listTopics(): Promise<TopicRecord[]> {
    const result = await this.pool.query<TopicRow>(
      `SELECT ${TOPIC_COLUMNS} FROM topics ORDER BY updated_at DESC, id`,
    );
    return result.rows.map(mapTopic);
  }

  async beginRun(input: BeginTopicRunInput): Promise<TopicRunRecord> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const topic = await client.query("SELECT id FROM topics WHERE id = $1 FOR UPDATE", [
        input.topicId,
      ]);

      if (topic.rows.length === 0) {
        throw new Error(`Topic ${input.topicId} does not exist.`);
      }

      const active = await client.query(
        "SELECT id FROM topic_runs WHERE topic_id = $1 AND status = 'running'",
        [input.topicId],
      );

      if (active.rows.length > 0) {
        throw new TopicRunAlreadyActiveError();
      }

      const inserted = await client.query<TopicRunRow>(
        `INSERT INTO topic_runs (
           id, topic_id, status, outcome, model_mode, model_label, model_invoked, query,
           source_outcomes, evidence, collected_count, keyword_miss_count,
           dropped_duplicate_count, error, started_at, finished_at, created_at
         ) VALUES (
           $1, $2, 'running', NULL, $3, NULL, false, $4, '[]'::jsonb, '[]'::jsonb,
           0, 0, 0, NULL, $5, NULL, $5
         )
         RETURNING ${RUN_COLUMNS}`,
        [input.id, input.topicId, input.modelMode, input.query, input.startedAt],
      );
      await client.query("COMMIT");
      return mapRun(requiredRow(inserted.rows[0], "topic_runs"));
    } catch (error) {
      await client.query("ROLLBACK");

      if (isRunningConflict(error)) {
        throw new TopicRunAlreadyActiveError();
      }

      throw error;
    } finally {
      client.release();
    }
  }

  async failRun(
    runId: string,
    error: { name: string; message: string },
    sourceOutcomes: TopicSourceOutcome[],
    counts: { collectedCount: number; keywordMissCount: number; droppedDuplicateCount: number },
    finishedAt: string,
  ): Promise<TopicRunRecord> {
    const result = await this.pool.query<TopicRunRow>(
      `UPDATE topic_runs
       SET status = 'failed',
           source_outcomes = $2::jsonb,
           collected_count = $3,
           keyword_miss_count = $4,
           dropped_duplicate_count = $5,
           error = $6::jsonb,
           finished_at = $7
       WHERE id = $1 AND status = 'running'
       RETURNING ${RUN_COLUMNS}`,
      [
        runId,
        JSON.stringify(sourceOutcomes),
        counts.collectedCount,
        counts.keywordMissCount,
        counts.droppedDuplicateCount,
        JSON.stringify(error),
        finishedAt,
      ],
    );
    return mapRun(requiredRow(result.rows[0], "topic_runs"));
  }

  async commitRun(input: CommitTopicRunInput): Promise<{
    run: TopicRunRecord;
    briefing: TopicBriefingRecord;
  }> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const updated = await client.query<TopicRunRow>(
        `UPDATE topic_runs
         SET status = 'succeeded',
             outcome = $2,
             model_label = $3,
             model_invoked = $4,
             source_outcomes = $5::jsonb,
             evidence = $6::jsonb,
             collected_count = $7,
             keyword_miss_count = $8,
             dropped_duplicate_count = $9,
             finished_at = $10
         WHERE id = $1 AND status = 'running'
         RETURNING ${RUN_COLUMNS}`,
        [
          input.runId,
          input.outcome,
          input.modelLabel,
          input.modelInvoked,
          JSON.stringify(input.sourceOutcomes),
          JSON.stringify(input.evidence),
          input.collectedCount,
          input.keywordMissCount,
          input.droppedDuplicateCount,
          input.finishedAt,
        ],
      );
      const run = mapRun(requiredRow(updated.rows[0], "topic_runs"));
      const briefingResult = await client.query<TopicBriefingRow>(
        `INSERT INTO topic_briefings (
           id, run_id, topic_id, title, markdown, evidence_count, export_path, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, run_id, topic_id, title, markdown, evidence_count, export_path, created_at`,
        [
          input.briefing.id,
          input.runId,
          run.topicId,
          input.briefing.title,
          input.briefing.markdown,
          input.evidence.length,
          input.briefing.exportPath,
          input.finishedAt,
        ],
      );

      for (const seen of input.seen) {
        await client.query(
          `INSERT INTO topic_seen_evidence (
             topic_id, fingerprint, title_fingerprint, evidence_id, run_id, seen_at
           ) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (topic_id, fingerprint) DO NOTHING`,
          [
            seen.topicId,
            seen.fingerprint,
            seen.titleFingerprint,
            seen.evidenceId,
            seen.runId,
            seen.seenAt,
          ],
        );
      }

      await client.query("COMMIT");
      return {
        run,
        briefing: mapBriefing(requiredRow(briefingResult.rows[0], "topic_briefings")),
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async getRun(id: string): Promise<TopicRunRecord | null> {
    const result = await this.pool.query<TopicRunRow>(
      `SELECT ${RUN_COLUMNS} FROM topic_runs WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRun(row);
  }

  async listRuns(topicId: string): Promise<TopicRunRecord[]> {
    const result = await this.pool.query<TopicRunRow>(
      `SELECT ${RUN_COLUMNS} FROM topic_runs WHERE topic_id = $1 ORDER BY created_at DESC, id`,
      [topicId],
    );
    return result.rows.map(mapRun);
  }

  async getBriefingByRun(runId: string): Promise<TopicBriefingRecord | null> {
    const result = await this.pool.query<TopicBriefingRow>(
      `SELECT id, run_id, topic_id, title, markdown, evidence_count, export_path, created_at
       FROM topic_briefings WHERE run_id = $1`,
      [runId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapBriefing(row);
  }

  async listSeenEvidence(topicId: string, seenSince: string): Promise<TopicSeenEvidenceRecord[]> {
    const result = await this.pool.query<TopicSeenRow>(
      `SELECT topic_id, fingerprint, title_fingerprint, evidence_id, run_id, seen_at
       FROM topic_seen_evidence
       WHERE topic_id = $1 AND seen_at >= $2`,
      [topicId, seenSince],
    );
    return result.rows.map(mapSeen);
  }
}

interface TopicRow extends QueryResultRow {
  id: string;
  name: string;
  keywords: unknown;
  feeds: unknown;
  window_hours: number;
  lookback_days: number;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

interface TopicRunRow extends QueryResultRow {
  id: string;
  topic_id: string;
  status: string;
  outcome: string | null;
  model_mode: string;
  model_label: string | null;
  model_invoked: boolean;
  query: string;
  source_outcomes: unknown;
  evidence: unknown;
  collected_count: number;
  keyword_miss_count: number;
  dropped_duplicate_count: number;
  error: unknown;
  started_at: Date;
  finished_at: Date | null;
}

interface TopicBriefingRow extends QueryResultRow {
  id: string;
  run_id: string;
  topic_id: string;
  title: string;
  markdown: string;
  evidence_count: number;
  export_path: string | null;
  created_at: Date;
}

interface TopicSeenRow extends QueryResultRow {
  topic_id: string;
  fingerprint: string;
  title_fingerprint: string;
  evidence_id: string;
  run_id: string;
  seen_at: Date;
}

function mapTopic(row: TopicRow): TopicRecord {
  return {
    id: row.id,
    name: row.name,
    keywords: stringArray(row.keywords, "keywords"),
    feeds: feedArray(row.feeds),
    windowHours: row.window_hours,
    lookbackDays: row.lookback_days,
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapRun(row: TopicRunRow): TopicRunRecord {
  return {
    id: row.id,
    topicId: row.topic_id,
    status: runStatus(row.status),
    outcome: row.outcome === null ? null : runOutcome(row.outcome),
    modelMode: modelMode(row.model_mode),
    modelLabel: row.model_label,
    modelInvoked: row.model_invoked,
    query: row.query,
    sourceOutcomes: sourceArray(row.source_outcomes),
    evidence: evidenceArray(row.evidence),
    collectedCount: row.collected_count,
    keywordMissCount: row.keyword_miss_count,
    droppedDuplicateCount: row.dropped_duplicate_count,
    error: errorObject(row.error),
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at === null ? null : row.finished_at.toISOString(),
  };
}

function mapBriefing(row: TopicBriefingRow): TopicBriefingRecord {
  return {
    id: row.id,
    runId: row.run_id,
    topicId: row.topic_id,
    title: row.title,
    markdown: row.markdown,
    evidenceCount: row.evidence_count,
    exportPath: row.export_path,
    createdAt: row.created_at.toISOString(),
  };
}

function mapSeen(row: TopicSeenRow): TopicSeenEvidenceRecord {
  return {
    topicId: row.topic_id,
    fingerprint: row.fingerprint,
    titleFingerprint: row.title_fingerprint,
    evidenceId: row.evidence_id,
    runId: row.run_id,
    seenAt: row.seen_at.toISOString(),
  };
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Stored topic ${label} is not a string array.`);
  }

  return value;
}

function feedArray(value: unknown): TopicFeed[] {
  if (!Array.isArray(value)) {
    throw new Error("Stored topic feeds are not an array.");
  }

  return value.map((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.url !== "string") {
      throw new Error("Stored topic feed is missing id or url.");
    }

    const name = typeof item.name === "string" ? item.name : undefined;
    return name === undefined
      ? { id: item.id, url: item.url }
      : { id: item.id, url: item.url, name };
  });
}

function sourceArray(value: unknown): TopicSourceOutcome[] {
  if (!Array.isArray(value)) {
    throw new Error("Stored source outcomes are not an array.");
  }

  return value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.sourceId !== "string" ||
      typeof item.outcome !== "string" ||
      typeof item.received !== "number" ||
      typeof item.fresh !== "number"
    ) {
      throw new Error("Stored source outcome is incomplete.");
    }

    return {
      sourceId: item.sourceId,
      outcome: sourceOutcome(item.outcome),
      received: item.received,
      fresh: item.fresh,
      error: errorObject(item.error),
    };
  });
}

function evidenceArray(value: unknown): TopicEvidenceRecord[] {
  if (!Array.isArray(value)) {
    throw new Error("Stored topic evidence is not an array.");
  }

  return value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.title !== "string" ||
      typeof item.url !== "string" ||
      typeof item.excerpt !== "string"
    ) {
      throw new Error("Stored topic evidence is incomplete.");
    }

    return {
      id: item.id,
      title: item.title,
      url: item.url,
      excerpt: item.excerpt,
      ...(typeof item.source === "string" ? { source: item.source } : {}),
      ...(typeof item.sourceId === "string" ? { sourceId: item.sourceId } : {}),
      ...(typeof item.publishedAt === "string" ? { publishedAt: item.publishedAt } : {}),
      ...(typeof item.canonicalUrl === "string" ? { canonicalUrl: item.canonicalUrl } : {}),
      ...(typeof item.fingerprint === "string" ? { fingerprint: item.fingerprint } : {}),
      ...(typeof item.titleFingerprint === "string"
        ? { titleFingerprint: item.titleFingerprint }
        : {}),
      ...(typeof item.clusterId === "string" ? { clusterId: item.clusterId } : {}),
    };
  });
}

function errorObject(value: unknown): { name: string; message: string } | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (!isRecord(value) || typeof value.name !== "string" || typeof value.message !== "string") {
    throw new Error("Stored error is not an object with name and message.");
  }

  return { name: value.name, message: value.message };
}

function modelMode(value: string): TopicRunRecord["modelMode"] {
  if (value === "stub" || value === "structured") {
    return value;
  }

  throw new Error(`Unknown topic model mode: ${value}.`);
}

function runStatus(value: string): TopicRunStatus {
  if (value === "running" || value === "succeeded" || value === "failed") {
    return value;
  }

  throw new Error(`Unknown topic run status: ${value}.`);
}

function runOutcome(value: string): TopicRunOutcome {
  if (value === "ready" || value === "empty" || value === "deduped") {
    return value;
  }

  throw new Error(`Unknown topic run outcome: ${value}.`);
}

function sourceOutcome(value: string): TopicSourceOutcome["outcome"] {
  if (
    value === "available" ||
    value === "empty" ||
    value === "filtered" ||
    value === "request_failed"
  ) {
    return value;
  }

  throw new Error(`Unknown source outcome: ${value}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRow<T>(row: T | undefined, table: string): T {
  if (row === undefined) {
    throw new Error(`Expected a row in ${table}.`);
  }

  return row;
}

function isRunningConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === "topic_runs_one_running_idx"
  );
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original error is the one the caller needs.
  }
}
