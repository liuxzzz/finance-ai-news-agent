import { randomUUID } from "node:crypto";

import type {
  ArtifactRecord,
  CompleteDeliveryInput,
  CompleteModelCallInput,
  CompleteRunStageInput,
  CreateRunInput,
  CreateRunResult,
  DeliveryRecord,
  DeliveryStatus,
  FailDeliveryInput,
  FailModelCallInput,
  FailRunStageInput,
  FinishRunInput,
  JsonObject,
  JsonValue,
  ModelCallRecord,
  ModelCallStatus,
  RunIdentity,
  RunLock,
  RunRecord,
  RunStageRecord,
  RunStageStatus,
  RunStatus,
  RuntimeStore,
  SaveArtifactInput,
  SerializedError,
  SkipRunStageInput,
  StartDeliveryInput,
  StartDeliveryResult,
  StartModelCallInput,
  StartModelCallResult,
  StartRunStageInput,
} from "@finance-ai-news-agent/plugin-sdk";
import type { Pool, PoolClient, QueryResultRow } from "pg";

const RUN_COLUMNS = `
  id, tenant_id, report_date, edition, topic, max_revisions, input_hash,
  config_snapshot, prompt_versions, model_snapshot, scheduled_at, status,
  attempt_count, started_at, finished_at, error, created_at, updated_at
`;

const STAGE_COLUMNS = `
  id, run_id, stage, attempt, status, input_hash, output, output_refs,
  error, started_at, finished_at, created_at
`;

const ARTIFACT_COLUMNS = `
  id, run_id, kind, media_type, content, content_hash, created_at
`;

const DELIVERY_COLUMNS = `
  id, run_id, artifact_id, delivery_key, plugin_id, target, status, attempt,
  receipt, error, started_at, finished_at, created_at, updated_at
`;

const MODEL_CALL_COLUMNS = `
  id, run_id, ordinal, role, provider_id, request_hash, status, model,
  finish_reason, input_tokens, output_tokens, total_tokens, error,
  started_at, finished_at, created_at, updated_at
`;

/** PostgreSQL implementation of the deterministic runtime persistence boundary. */
export class PostgresRuntimeStore implements RuntimeStore {
  constructor(private readonly pool: Pool) {}

  async createOrGetRun(input: CreateRunInput): Promise<CreateRunResult> {
    const inserted = await this.pool.query<RunRow>(
      `
        INSERT INTO runs (
          id, tenant_id, report_date, edition, topic, max_revisions, input_hash,
          config_snapshot, prompt_versions, model_snapshot, scheduled_at, status,
          attempt_count, started_at, finished_at, error, created_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8::jsonb, $9::jsonb, $10::jsonb, $11, 'pending',
          0, NULL, NULL, NULL, $12, $12
        )
        ON CONFLICT (tenant_id, report_date, edition) DO NOTHING
        RETURNING ${RUN_COLUMNS}
      `,
      [
        input.id,
        input.tenantId,
        input.reportDate,
        input.edition,
        input.topic,
        input.maxRevisions,
        input.inputHash,
        encodeJson(input.configSnapshot),
        encodeJson(input.promptVersions),
        encodeJson(input.modelSnapshot),
        input.scheduledAt,
        input.createdAt,
      ],
    );
    const created = inserted.rows[0];

    if (created !== undefined) {
      return { run: mapRun(created), created: true };
    }

    // This is deliberately a second statement: after waiting on a concurrent
    // unique-key insert, it receives a fresh snapshot that can see the winner.
    const existing = await this.findRun(input);

    if (existing === null) {
      throw new Error(
        `Run identity ${input.tenantId}/${input.reportDate}/${input.edition} was not available after a uniqueness conflict.`,
      );
    }

    return { run: existing, created: false };
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const result = await this.pool.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = $1`, [
      runId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : mapRun(row);
  }

  async findRun(identity: RunIdentity): Promise<RunRecord | null> {
    const result = await this.pool.query<RunRow>(
      `
        SELECT ${RUN_COLUMNS}
        FROM runs
        WHERE tenant_id = $1 AND report_date = $2 AND edition = $3
      `,
      [identity.tenantId, identity.reportDate, identity.edition],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRun(row);
  }

  async markRunRunning(runId: string, startedAt: string): Promise<RunRecord> {
    const result = await this.pool.query<RunRow>(
      `
        UPDATE runs
        SET status = 'running',
            attempt_count = attempt_count + 1,
            started_at = COALESCE(started_at, $2),
            finished_at = NULL,
            error = NULL,
            updated_at = $2
        WHERE id = $1 AND status IN ('pending', 'running', 'failed')
        RETURNING ${RUN_COLUMNS}
      `,
      [runId, startedAt],
    );
    const row = result.rows[0];

    if (row !== undefined) {
      return mapRun(row);
    }

    const run = await this.getRun(runId);

    if (run === null) {
      throw new Error(`Run ${runId} does not exist.`);
    }

    throw new Error(`Cannot start terminal run ${runId} with status ${run.status}.`);
  }

  async finishRun(input: FinishRunInput): Promise<RunRecord> {
    const result = await this.pool.query<RunRow>(
      `
        UPDATE runs
        SET status = $2,
            error = $3::jsonb,
            finished_at = $4,
            updated_at = $4
        WHERE id = $1 AND status = 'running'
        RETURNING ${RUN_COLUMNS}
      `,
      [
        input.runId,
        input.status,
        input.error === null ? null : encodeJson(input.error),
        input.finishedAt,
      ],
    );
    const row = result.rows[0];

    if (row !== undefined) {
      return mapRun(row);
    }

    const run = await this.getRun(input.runId);

    if (run === null) {
      throw new Error(`Run ${input.runId} does not exist.`);
    }

    throw new Error(`Cannot finish run ${run.id} from status ${run.status}.`);
  }

  async tryAcquireRunLock(runId: string): Promise<RunLock | null> {
    const client = await this.pool.connect();
    const lockKey = `finance-ai-news-agent:runtime:run:${runId}`;

    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [lockKey],
      );

      if (result.rows[0]?.acquired !== true) {
        client.release();
        return null;
      }
    } catch (error) {
      client.release();
      throw error;
    }

    let released = false;

    return {
      release: async () => {
        if (released) {
          return;
        }

        released = true;

        try {
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
          client.release();
        } catch (error) {
          // Session advisory locks must be unlocked and the exact same client
          // returned to the pool together. Destroy a connection when unlock
          // fails so a locked session is never reused by the pool.
          client.release(asError(error));
          throw error;
        }
      },
    };
  }

  async getLatestStage(runId: string, stage: string): Promise<RunStageRecord | null> {
    const result = await this.pool.query<StageRow>(
      `
        SELECT ${STAGE_COLUMNS}
        FROM run_stages
        WHERE run_id = $1 AND stage = $2
        ORDER BY attempt DESC
        LIMIT 1
      `,
      [runId, stage],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapStage(row);
  }

  async listStages(runId: string): Promise<RunStageRecord[]> {
    const result = await this.pool.query<StageRow>(
      `
        SELECT ${STAGE_COLUMNS}
        FROM run_stages
        WHERE run_id = $1
        ORDER BY created_at ASC, attempt ASC, id ASC
      `,
      [runId],
    );
    return result.rows.map(mapStage);
  }

  async startStage(input: StartRunStageInput): Promise<RunStageRecord> {
    return withTransaction(this.pool, async (client) => {
      const run = await client.query<{ id: string }>(
        "SELECT id FROM runs WHERE id = $1 FOR UPDATE",
        [input.runId],
      );

      if (run.rows[0] === undefined) {
        throw new Error(`Run ${input.runId} does not exist.`);
      }

      const running = await client.query<{ id: string }>(
        `
          SELECT id
          FROM run_stages
          WHERE run_id = $1 AND stage = $2 AND status = 'running'
          LIMIT 1
        `,
        [input.runId, input.stage],
      );

      if (running.rows[0] !== undefined) {
        throw new Error(`Stage ${input.stage} is already running for run ${input.runId}.`);
      }

      const attempts = await client.query<{ next_attempt: number | string }>(
        `
          SELECT COALESCE(MAX(attempt), 0) + 1 AS next_attempt
          FROM run_stages
          WHERE run_id = $1 AND stage = $2
        `,
        [input.runId, input.stage],
      );
      const attempt = Number(attempts.rows[0]?.next_attempt ?? 1);
      const inserted = await client.query<StageRow>(
        `
          INSERT INTO run_stages (
            id, run_id, stage, attempt, status, input_hash, output,
            output_refs, error, started_at, finished_at, created_at
          )
          VALUES ($1, $2, $3, $4, 'running', $5, NULL, '{}'::jsonb, NULL, $6, NULL, $6)
          RETURNING ${STAGE_COLUMNS}
        `,
        [randomUUID(), input.runId, input.stage, attempt, input.inputHash, input.startedAt],
      );

      return mapStage(requireRow(inserted.rows[0], "Started stage"));
    });
  }

  async completeStage(input: CompleteRunStageInput): Promise<RunStageRecord> {
    const result = await this.pool.query<StageRow>(
      `
        UPDATE run_stages
        SET status = 'succeeded',
            output = $2::jsonb,
            output_refs = $3::jsonb,
            error = NULL,
            finished_at = $4
        WHERE id = $1 AND status = 'running'
        RETURNING ${STAGE_COLUMNS}
      `,
      [input.stageId, encodeJson(input.output), encodeJson(input.outputRefs), input.finishedAt],
    );
    return this.requireUpdatedStage(input.stageId, result.rows[0]);
  }

  async failStage(input: FailRunStageInput): Promise<RunStageRecord> {
    const result = await this.pool.query<StageRow>(
      `
        UPDATE run_stages
        SET status = 'failed', error = $2::jsonb, finished_at = $3
        WHERE id = $1 AND status = 'running'
        RETURNING ${STAGE_COLUMNS}
      `,
      [input.stageId, encodeJson(input.error), input.finishedAt],
    );
    return this.requireUpdatedStage(input.stageId, result.rows[0]);
  }

  async skipStage(input: SkipRunStageInput): Promise<RunStageRecord> {
    const result = await this.pool.query<StageRow>(
      `
        UPDATE run_stages
        SET status = 'skipped', output = $2::jsonb, error = NULL, finished_at = $3
        WHERE id = $1 AND status = 'running'
        RETURNING ${STAGE_COLUMNS}
      `,
      [input.stageId, encodeJson(input.output), input.finishedAt],
    );
    return this.requireUpdatedStage(input.stageId, result.rows[0]);
  }

  async saveArtifact(input: SaveArtifactInput): Promise<ArtifactRecord> {
    const inserted = await this.pool.query<ArtifactRow>(
      `
        INSERT INTO artifacts (
          id, run_id, kind, media_type, content, content_hash, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (run_id, kind) DO NOTHING
        RETURNING ${ARTIFACT_COLUMNS}
      `,
      [
        input.id,
        input.runId,
        input.kind,
        input.mediaType,
        input.content,
        input.contentHash,
        input.createdAt,
      ],
    );
    const created = inserted.rows[0];

    if (created !== undefined) {
      return mapArtifact(created);
    }

    const existing = await this.getArtifactForRun(input.runId, input.kind);

    if (existing === null) {
      throw new Error(
        `Artifact ${input.runId}/${input.kind} was not available after a uniqueness conflict.`,
      );
    }

    if (
      existing.id !== input.id ||
      existing.contentHash !== input.contentHash ||
      existing.content !== input.content ||
      existing.mediaType !== input.mediaType
    ) {
      throw new Error(`Artifact conflict for run ${input.runId} and kind ${input.kind}.`);
    }

    return existing;
  }

  async getArtifactForRun(runId: string, kind: string): Promise<ArtifactRecord | null> {
    const result = await this.pool.query<ArtifactRow>(
      `
        SELECT ${ARTIFACT_COLUMNS}
        FROM artifacts
        WHERE run_id = $1 AND kind = $2
      `,
      [runId, kind],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapArtifact(row);
  }

  async startDelivery(input: StartDeliveryInput): Promise<StartDeliveryResult> {
    return withTransaction(this.pool, async (client) => {
      // A row lock cannot protect a delivery key that has not been inserted yet.
      // The transaction lock closes that gap for concurrent first attempts.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `finance-ai-news-agent:runtime:delivery:${input.deliveryKey}`,
      ]);
      const selected = await client.query<DeliveryRow>(
        `
          SELECT ${DELIVERY_COLUMNS}
          FROM deliveries
          WHERE delivery_key = $1
          FOR UPDATE
        `,
        [input.deliveryKey],
      );
      const existing = selected.rows[0];

      if (existing === undefined) {
        const inserted = await client.query<DeliveryRow>(
          `
            INSERT INTO deliveries (
              id, run_id, artifact_id, delivery_key, plugin_id, target, status,
              attempt, receipt, error, started_at, finished_at, created_at, updated_at
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, 'running',
              1, NULL, NULL, $7, NULL, $7, $7
            )
            RETURNING ${DELIVERY_COLUMNS}
          `,
          [
            input.id,
            input.runId,
            input.artifactId,
            input.deliveryKey,
            input.pluginId,
            input.target,
            input.startedAt,
          ],
        );

        return {
          delivery: mapDelivery(requireRow(inserted.rows[0], "Started delivery")),
          shouldDeliver: true,
        };
      }

      if (existing.status === "succeeded") {
        ensureDeliveryIdentity(existing, input);
        return { delivery: mapDelivery(existing), shouldDeliver: false };
      }

      ensureDeliveryIdentity(existing, input);

      const restarted = await client.query<DeliveryRow>(
        `
          UPDATE deliveries
          SET status = 'running',
              attempt = attempt + 1,
              receipt = NULL,
              error = NULL,
              started_at = $2,
              finished_at = NULL,
              updated_at = $2
          WHERE delivery_key = $1
          RETURNING ${DELIVERY_COLUMNS}
        `,
        [input.deliveryKey, input.startedAt],
      );

      return {
        delivery: mapDelivery(requireRow(restarted.rows[0], "Restarted delivery")),
        shouldDeliver: true,
      };
    });
  }

  async getDeliveryByKey(deliveryKey: string): Promise<DeliveryRecord | null> {
    const result = await this.pool.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM deliveries WHERE delivery_key = $1`,
      [deliveryKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapDelivery(row);
  }

  async listDeliveries(runId: string): Promise<DeliveryRecord[]> {
    const result = await this.pool.query<DeliveryRow>(
      `
        SELECT ${DELIVERY_COLUMNS}
        FROM deliveries
        WHERE run_id = $1
        ORDER BY created_at ASC, id ASC
      `,
      [runId],
    );
    return result.rows.map(mapDelivery);
  }

  async completeDelivery(input: CompleteDeliveryInput): Promise<DeliveryRecord> {
    const result = await this.pool.query<DeliveryRow>(
      `
        UPDATE deliveries
        SET status = 'succeeded',
            receipt = $2::jsonb,
            error = NULL,
            finished_at = $3,
            updated_at = $3
        WHERE id = $1 AND status = 'running'
        RETURNING ${DELIVERY_COLUMNS}
      `,
      [input.deliveryId, encodeJson(input.receipt), input.finishedAt],
    );
    return this.requireUpdatedDelivery(input.deliveryId, result.rows[0]);
  }

  async failDelivery(input: FailDeliveryInput): Promise<DeliveryRecord> {
    const result = await this.pool.query<DeliveryRow>(
      `
        UPDATE deliveries
        SET status = 'failed', error = $2::jsonb, finished_at = $3, updated_at = $3
        WHERE id = $1 AND status = 'running'
        RETURNING ${DELIVERY_COLUMNS}
      `,
      [input.deliveryId, encodeJson(input.error), input.finishedAt],
    );
    return this.requireUpdatedDelivery(input.deliveryId, result.rows[0]);
  }

  async startModelCall(input: StartModelCallInput): Promise<StartModelCallResult> {
    if (!Number.isSafeInteger(input.maxRequests) || input.maxRequests <= 0) {
      throw new Error("maxRequests must be a positive integer.");
    }

    return withTransaction(this.pool, async (client) => {
      const run = await client.query<{ id: string }>(
        "SELECT id FROM runs WHERE id = $1 FOR UPDATE",
        [input.runId],
      );

      if (run.rows[0] === undefined) {
        throw new Error(`Run ${input.runId} does not exist.`);
      }

      const usage = await client.query<{ used_requests: number | string }>(
        "SELECT COUNT(*) AS used_requests FROM model_calls WHERE run_id = $1",
        [input.runId],
      );
      const usedRequests = Number(usage.rows[0]?.used_requests ?? 0);

      if (usedRequests >= input.maxRequests) {
        return { accepted: false, call: null, usedRequests };
      }

      const inserted = await client.query<ModelCallRow>(
        `
          INSERT INTO model_calls (
            id, run_id, ordinal, role, provider_id, request_hash, status,
            model, finish_reason, input_tokens, output_tokens, total_tokens,
            error, started_at, finished_at, created_at, updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, 'running',
            NULL, NULL, 0, 0, 0,
            NULL, $7, NULL, $7, $7
          )
          RETURNING ${MODEL_CALL_COLUMNS}
        `,
        [
          input.id,
          input.runId,
          usedRequests + 1,
          input.role,
          input.providerId,
          input.requestHash,
          input.startedAt,
        ],
      );
      const call = mapModelCall(requireRow(inserted.rows[0], "Started model call"));
      return { accepted: true, call, usedRequests: usedRequests + 1 };
    });
  }

  async listModelCalls(runId: string): Promise<ModelCallRecord[]> {
    const result = await this.pool.query<ModelCallRow>(
      `
        SELECT ${MODEL_CALL_COLUMNS}
        FROM model_calls
        WHERE run_id = $1
        ORDER BY ordinal ASC
      `,
      [runId],
    );
    return result.rows.map(mapModelCall);
  }

  async completeModelCall(input: CompleteModelCallInput): Promise<ModelCallRecord> {
    const result = await this.pool.query<ModelCallRow>(
      `
        UPDATE model_calls
        SET status = 'succeeded',
            model = $2,
            finish_reason = $3,
            input_tokens = $4,
            output_tokens = $5,
            total_tokens = $6,
            error = NULL,
            finished_at = $7,
            updated_at = $7
        WHERE id = $1 AND status = 'running'
        RETURNING ${MODEL_CALL_COLUMNS}
      `,
      [
        input.callId,
        input.model,
        input.finishReason,
        input.inputTokens,
        input.outputTokens,
        input.totalTokens,
        input.finishedAt,
      ],
    );
    return this.requireUpdatedModelCall(input.callId, result.rows[0]);
  }

  async failModelCall(input: FailModelCallInput): Promise<ModelCallRecord> {
    const result = await this.pool.query<ModelCallRow>(
      `
        UPDATE model_calls
        SET status = 'failed',
            input_tokens = $2,
            output_tokens = $3,
            total_tokens = $4,
            error = $5::jsonb,
            finished_at = $6,
            updated_at = $6
        WHERE id = $1 AND status = 'running'
        RETURNING ${MODEL_CALL_COLUMNS}
      `,
      [
        input.callId,
        input.inputTokens,
        input.outputTokens,
        input.totalTokens,
        encodeJson(input.error),
        input.finishedAt,
      ],
    );
    return this.requireUpdatedModelCall(input.callId, result.rows[0]);
  }

  private async requireUpdatedStage(
    stageId: string,
    row: StageRow | undefined,
  ): Promise<RunStageRecord> {
    if (row !== undefined) {
      return mapStage(row);
    }

    const existing = await this.pool.query<{ status: RunStageStatus }>(
      "SELECT status FROM run_stages WHERE id = $1",
      [stageId],
    );

    if (existing.rows[0] === undefined) {
      throw new Error(`Stage ${stageId} does not exist.`);
    }

    throw new Error(`Stage ${stageId} is not running.`);
  }

  private async requireUpdatedDelivery(
    deliveryId: string,
    row: DeliveryRow | undefined,
  ): Promise<DeliveryRecord> {
    if (row !== undefined) {
      return mapDelivery(row);
    }

    const existing = await this.pool.query<{ status: DeliveryStatus }>(
      "SELECT status FROM deliveries WHERE id = $1",
      [deliveryId],
    );

    if (existing.rows[0] === undefined) {
      throw new Error(`Delivery ${deliveryId} does not exist.`);
    }

    throw new Error(`Delivery ${deliveryId} is not running.`);
  }

  private async requireUpdatedModelCall(
    callId: string,
    row: ModelCallRow | undefined,
  ): Promise<ModelCallRecord> {
    if (row !== undefined) {
      return mapModelCall(row);
    }

    const existing = await this.pool.query<{ status: ModelCallStatus }>(
      "SELECT status FROM model_calls WHERE id = $1",
      [callId],
    );

    if (existing.rows[0] === undefined) {
      throw new Error(`Model call ${callId} does not exist.`);
    }

    throw new Error(`Model call ${callId} is not running.`);
  }
}

async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function encodeJson(value: JsonValue | JsonObject | SerializedError): string {
  return JSON.stringify(value);
}

function requireRow<T>(row: T | undefined, operation: string): T {
  if (row === undefined) {
    throw new Error(`${operation} did not return a database row.`);
  }

  return row;
}

function ensureDeliveryIdentity(row: DeliveryRow, input: StartDeliveryInput): void {
  if (
    row.run_id !== input.runId ||
    row.artifact_id !== input.artifactId ||
    row.plugin_id !== input.pluginId ||
    row.target !== input.target
  ) {
    throw new Error(`Delivery key ${input.deliveryKey} is already bound to a different target.`);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function mapRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    reportDate: dateText(row.report_date),
    edition: row.edition,
    topic: row.topic,
    maxRevisions: row.max_revisions,
    inputHash: row.input_hash,
    configSnapshot: row.config_snapshot,
    promptVersions: row.prompt_versions,
    modelSnapshot: row.model_snapshot,
    scheduledAt: nullableTimestamp(row.scheduled_at),
    createdAt: timestamp(row.created_at),
    status: row.status,
    attemptCount: row.attempt_count,
    startedAt: nullableTimestamp(row.started_at),
    finishedAt: nullableTimestamp(row.finished_at),
    error: row.error,
    updatedAt: timestamp(row.updated_at),
  };
}

function mapStage(row: StageRow): RunStageRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stage: row.stage,
    attempt: row.attempt,
    status: row.status,
    inputHash: row.input_hash,
    output: row.output,
    outputRefs: row.output_refs,
    error: row.error,
    startedAt: nullableTimestamp(row.started_at),
    finishedAt: nullableTimestamp(row.finished_at),
    createdAt: timestamp(row.created_at),
  };
}

function mapArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    mediaType: row.media_type,
    content: row.content,
    contentHash: row.content_hash,
    createdAt: timestamp(row.created_at),
  };
}

function mapDelivery(row: DeliveryRow): DeliveryRecord {
  return {
    id: row.id,
    runId: row.run_id,
    artifactId: row.artifact_id,
    deliveryKey: row.delivery_key,
    pluginId: row.plugin_id,
    target: row.target,
    status: row.status,
    attempt: row.attempt,
    receipt: row.receipt,
    error: row.error,
    startedAt: timestamp(row.started_at),
    finishedAt: nullableTimestamp(row.finished_at),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function mapModelCall(row: ModelCallRow): ModelCallRecord {
  return {
    id: row.id,
    runId: row.run_id,
    ordinal: row.ordinal,
    role: row.role,
    providerId: row.provider_id,
    requestHash: row.request_hash,
    status: row.status,
    model: row.model,
    finishReason: row.finish_reason,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    error: row.error,
    startedAt: timestamp(row.started_at),
    finishedAt: nullableTimestamp(row.finished_at),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function dateText(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function nullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : timestamp(value);
}

interface RunRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  report_date: Date | string;
  edition: string;
  topic: string;
  max_revisions: number;
  input_hash: string;
  config_snapshot: JsonObject;
  prompt_versions: JsonObject;
  model_snapshot: JsonObject;
  scheduled_at: Date | string | null;
  status: RunStatus;
  attempt_count: number;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  error: SerializedError | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface StageRow extends QueryResultRow {
  id: string;
  run_id: string;
  stage: string;
  attempt: number;
  status: RunStageStatus;
  input_hash: string;
  output: JsonValue | null;
  output_refs: JsonObject;
  error: SerializedError | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  created_at: Date | string;
}

interface ArtifactRow extends QueryResultRow {
  id: string;
  run_id: string;
  kind: string;
  media_type: string;
  content: string;
  content_hash: string;
  created_at: Date | string;
}

interface DeliveryRow extends QueryResultRow {
  id: string;
  run_id: string;
  artifact_id: string;
  delivery_key: string;
  plugin_id: string;
  target: string;
  status: DeliveryStatus;
  attempt: number;
  receipt: JsonValue | null;
  error: SerializedError | null;
  started_at: Date | string;
  finished_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ModelCallRow extends QueryResultRow {
  id: string;
  run_id: string;
  ordinal: number;
  role: string;
  provider_id: string;
  request_hash: string;
  status: ModelCallStatus;
  model: string | null;
  finish_reason: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  error: SerializedError | null;
  started_at: Date | string;
  finished_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}
