import { createHash, randomUUID } from "node:crypto";

import type {
  ArtifactRecord,
  CompleteDeliveryInput,
  CompleteModelCallInput,
  CompleteRunStageInput,
  ContentStore,
  CreateRunInput,
  CreateRunResult,
  DeliveryRecord,
  DeliveryStatus,
  FailDeliveryInput,
  FailModelCallInput,
  FailRunStageInput,
  FindPreviouslySeenContentInput,
  FinishRunInput,
  JsonObject,
  JsonValue,
  ModelCallRecord,
  ModelCallStatus,
  NormalizedContentItemInput,
  NormalizedContentItemRecord,
  PreviouslySeenContentRecord,
  RunIdentity,
  RunLock,
  RunRecord,
  RunStageRecord,
  RunStageStatus,
  RunStatus,
  RuntimeStore,
  SourceAuditStore,
  SourceRunRecord,
  SourceRunStatus,
  RawSourceItemRecord,
  RecordSourceCollectionInput,
  SaveArtifactInput,
  SaveStoryEventUpdatesInput,
  SavedStoryEventUpdate,
  SerializedError,
  SkipRunStageInput,
  StartDeliveryInput,
  StartDeliveryResult,
  StartModelCallInput,
  StartModelCallResult,
  StartRunStageInput,
  StoryEventRecord,
  StoryEventUpdateRecord,
  StoryMemoryStore,
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

const SOURCE_RUN_COLUMNS = `
  id, run_id, source_id, source_url_fingerprint, attempt, status,
  item_count, error, started_at, finished_at, created_at
`;

const RAW_SOURCE_ITEM_COLUMNS = `
  id, run_id, source_run_id, source_id, external_id, url, title, excerpt,
  published_at, collected_at, content_hash, raw, created_at
`;

const NORMALIZED_CONTENT_COLUMNS = `
  id, run_id, evidence_id, source_id, source, url, canonical_url, title,
  excerpt, published_at, fingerprint, title_fingerprint, cluster_id, created_at
`;

const STORY_EVENT_COLUMNS = `
  id, tenant_id, topic, canonical_headline, normalized_headline,
  title_fingerprint, latest_headline, first_seen_date, last_seen_date,
  first_run_id, latest_run_id, update_count, created_at, updated_at
`;

const STORY_EVENT_UPDATE_COLUMNS = `
  id, event_id, run_id, story_id, headline, evidence_ids, observed_at, created_at
`;

/** PostgreSQL implementation of the deterministic runtime persistence boundary. */
export class PostgresRuntimeStore
  implements RuntimeStore, SourceAuditStore, ContentStore, StoryMemoryStore
{
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

  async recordSourceCollection(input: RecordSourceCollectionInput): Promise<SourceRunRecord> {
    if (input.status === "failed" && input.items.length > 0) {
      throw new Error("A failed source collection cannot persist successful items.");
    }

    if (
      input.items.some(
        (item) =>
          item.runId !== input.runId ||
          item.sourceRunId !== input.id ||
          item.sourceId !== input.sourceId,
      )
    ) {
      throw new Error("Raw source items must match their source collection identity.");
    }

    return withTransaction(this.pool, async (client) => {
      const run = await client.query<{ id: string }>(
        "SELECT id FROM runs WHERE id = $1 FOR UPDATE",
        [input.runId],
      );

      if (run.rows[0] === undefined) {
        throw new Error(`Run ${input.runId} does not exist.`);
      }

      const attempts = await client.query<{ next_attempt: number | string }>(
        `
          SELECT COALESCE(MAX(attempt), 0) + 1 AS next_attempt
          FROM source_runs
          WHERE run_id = $1 AND source_id = $2
        `,
        [input.runId, input.sourceId],
      );
      const attempt = Number(attempts.rows[0]?.next_attempt ?? 1);
      const inserted = await client.query<SourceRunRow>(
        `
          INSERT INTO source_runs (
            id, run_id, source_id, source_url_fingerprint, attempt, status,
            item_count, error, started_at, finished_at, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $9)
          RETURNING ${SOURCE_RUN_COLUMNS}
        `,
        [
          input.id,
          input.runId,
          input.sourceId,
          input.sourceUrlFingerprint,
          attempt,
          input.status,
          input.itemCount,
          input.error === null ? null : encodeJson(input.error),
          input.startedAt,
          input.finishedAt,
        ],
      );

      for (const item of input.items) {
        await client.query(
          `
            INSERT INTO raw_source_items (
              id, run_id, source_run_id, source_id, external_id, url, title,
              excerpt, published_at, collected_at, content_hash, raw, created_at
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7,
              $8, $9, $10, $11, $12::jsonb, $10
            )
            ON CONFLICT (run_id, url) DO NOTHING
          `,
          [
            item.id,
            item.runId,
            item.sourceRunId,
            item.sourceId,
            item.externalId,
            item.url,
            item.title,
            item.excerpt,
            item.publishedAt,
            item.collectedAt,
            item.contentHash,
            encodeJson(item.raw),
          ],
        );
      }

      return mapSourceRun(requireRow(inserted.rows[0], "Recorded source collection"));
    });
  }

  async listSourceRuns(runId: string): Promise<SourceRunRecord[]> {
    const result = await this.pool.query<SourceRunRow>(
      `
        SELECT ${SOURCE_RUN_COLUMNS}
        FROM source_runs
        WHERE run_id = $1
        ORDER BY created_at ASC, source_id ASC, attempt ASC
      `,
      [runId],
    );
    return result.rows.map(mapSourceRun);
  }

  async listRawSourceItems(runId: string): Promise<RawSourceItemRecord[]> {
    const result = await this.pool.query<RawSourceItemRow>(
      `
        SELECT ${RAW_SOURCE_ITEM_COLUMNS}
        FROM raw_source_items
        WHERE run_id = $1
        ORDER BY published_at DESC, source_id ASC, id ASC
      `,
      [runId],
    );
    return result.rows.map(mapRawSourceItem);
  }

  async saveNormalizedContentItems(
    items: readonly NormalizedContentItemInput[],
  ): Promise<NormalizedContentItemRecord[]> {
    if (items.length === 0) {
      return [];
    }

    const runId = items[0]!.runId;

    if (items.some((item) => item.runId !== runId)) {
      throw new Error("Normalized content items must belong to one run.");
    }

    return withTransaction(this.pool, async (client) => {
      const run = await client.query<{ id: string }>("SELECT id FROM runs WHERE id = $1", [runId]);

      if (run.rows[0] === undefined) {
        throw new Error(`Run ${runId} does not exist.`);
      }

      for (const item of items) {
        await client.query(
          `
            INSERT INTO normalized_content_items (
              id, run_id, evidence_id, source_id, source, url, canonical_url,
              title, excerpt, published_at, fingerprint, title_fingerprint, cluster_id, created_at
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7,
              $8, $9, $10, $11, $12, $13, $14
            )
            ON CONFLICT (run_id, evidence_id) DO NOTHING
          `,
          [
            item.id,
            item.runId,
            item.evidenceId,
            item.sourceId,
            item.source,
            item.url,
            item.canonicalUrl,
            item.title,
            item.excerpt,
            item.publishedAt,
            item.fingerprint,
            item.titleFingerprint,
            item.clusterId,
            item.createdAt,
          ],
        );
      }

      const stored = await client.query<NormalizedContentRow>(
        `
          SELECT ${NORMALIZED_CONTENT_COLUMNS}
          FROM normalized_content_items
          WHERE run_id = $1 AND evidence_id = ANY($2::text[])
          ORDER BY published_at DESC NULLS LAST, evidence_id ASC
        `,
        [runId, items.map((item) => item.evidenceId)],
      );
      const records = stored.rows.map(mapNormalizedContentItem);

      for (const item of items) {
        const existing = records.find((record) => record.evidenceId === item.evidenceId);

        if (existing === undefined || !normalizedContentMatches(existing, item)) {
          throw new Error(`Normalized content conflict for ${item.runId}/${item.evidenceId}.`);
        }
      }

      return records;
    });
  }

  async listNormalizedContentItems(runId: string): Promise<NormalizedContentItemRecord[]> {
    const result = await this.pool.query<NormalizedContentRow>(
      `
        SELECT ${NORMALIZED_CONTENT_COLUMNS}
        FROM normalized_content_items
        WHERE run_id = $1
        ORDER BY published_at DESC NULLS LAST, evidence_id ASC
      `,
      [runId],
    );
    return result.rows.map(mapNormalizedContentItem);
  }

  async findPreviouslySeenContent(
    input: FindPreviouslySeenContentInput,
  ): Promise<PreviouslySeenContentRecord[]> {
    if (
      !Number.isSafeInteger(input.lookbackDays) ||
      input.lookbackDays < 1 ||
      input.lookbackDays > 365
    ) {
      throw new Error("Historical content lookback must be an integer from 1 to 365 days.");
    }

    if (input.fingerprints.length === 0 && input.titleFingerprints.length === 0) {
      return [];
    }

    const result = await this.pool.query<PreviouslySeenContentRow>(
      `
        WITH current_run AS (
          SELECT tenant_id, report_date, topic
          FROM runs
          WHERE id = $1
        )
        SELECT DISTINCT
          content.run_id,
          content.evidence_id,
          prior.report_date,
          content.fingerprint,
          content.title_fingerprint
        FROM normalized_content_items AS content
        JOIN runs AS prior ON prior.id = content.run_id
        CROSS JOIN current_run AS current
        WHERE prior.tenant_id = current.tenant_id
          AND prior.topic = current.topic
          AND prior.report_date::date < current.report_date::date
          AND prior.report_date::date >= current.report_date::date - $2::integer
          AND prior.status IN ('succeeded', 'partial')
          AND (
            content.fingerprint = ANY($3::text[])
            OR content.title_fingerprint = ANY($4::text[])
          )
        ORDER BY prior.report_date DESC, content.run_id ASC, content.evidence_id ASC
      `,
      [input.runId, input.lookbackDays, input.fingerprints, input.titleFingerprints],
    );

    return result.rows.map((row) => ({
      runId: row.run_id,
      evidenceId: row.evidence_id,
      reportDate: dateText(row.report_date),
      fingerprint: row.fingerprint,
      titleFingerprint: row.title_fingerprint,
    }));
  }

  async saveStoryEventUpdates(input: SaveStoryEventUpdatesInput): Promise<SavedStoryEventUpdate[]> {
    if (
      !Number.isSafeInteger(input.lookbackDays) ||
      input.lookbackDays < 1 ||
      input.lookbackDays > 365
    ) {
      throw new Error("Story event lookback must be an integer from 1 to 365 days.");
    }

    if (input.stories.length === 0) {
      return [];
    }

    return withTransaction(this.pool, async (client) => {
      const runResult = await client.query<{
        tenant_id: string;
        report_date: string;
        topic: string;
      }>("SELECT tenant_id, report_date, topic FROM runs WHERE id = $1", [input.runId]);
      const run = requireRow(runResult.rows[0], "Story memory run lookup");
      const candidates = await client.query<StoryEventRow>(
        `
          SELECT ${STORY_EVENT_COLUMNS}
          FROM story_events
          WHERE tenant_id = $1
            AND topic = $2
            AND last_seen_date >= $3::date - $4::integer
          ORDER BY last_seen_date DESC, id ASC
          LIMIT 500
        `,
        [run.tenant_id, run.topic, run.report_date, input.lookbackDays],
      );
      const availableEvents = candidates.rows.map(mapStoryEvent);
      const saved: SavedStoryEventUpdate[] = [];

      for (const story of input.stories) {
        let event = bestStoryEventMatch(
          availableEvents,
          story.normalizedHeadline,
          story.titleFingerprint,
        );
        let isNewEvent = false;

        if (event === null) {
          const eventId = storyEventId(run.tenant_id, run.topic, story.titleFingerprint);
          const inserted = await client.query<StoryEventRow>(
            `
              INSERT INTO story_events (
                id, tenant_id, topic, canonical_headline, normalized_headline,
                title_fingerprint, latest_headline, first_seen_date, last_seen_date,
                first_run_id, latest_run_id, update_count, created_at, updated_at
              )
              VALUES (
                $1, $2, $3, $4, $5,
                $6, $4, $7::date, $7::date,
                $8, $8, 0, $9, $9
              )
              ON CONFLICT (tenant_id, topic, title_fingerprint) DO NOTHING
              RETURNING ${STORY_EVENT_COLUMNS}
            `,
            [
              eventId,
              run.tenant_id,
              run.topic,
              story.headline,
              story.normalizedHeadline,
              story.titleFingerprint,
              run.report_date,
              input.runId,
              input.observedAt,
            ],
          );

          if (inserted.rows[0] !== undefined) {
            event = mapStoryEvent(inserted.rows[0]);
            availableEvents.push(event);
            isNewEvent = true;
          } else {
            const existing = await client.query<StoryEventRow>(
              `
                SELECT ${STORY_EVENT_COLUMNS}
                FROM story_events
                WHERE tenant_id = $1 AND topic = $2 AND title_fingerprint = $3
              `,
              [run.tenant_id, run.topic, story.titleFingerprint],
            );
            event = mapStoryEvent(requireRow(existing.rows[0], "Story event conflict lookup"));
          }
        }

        const updateId = storyEventUpdateId(input.runId, story.storyId);
        const insertedUpdate = await client.query<StoryEventUpdateRow>(
          `
            INSERT INTO story_event_updates (
              id, event_id, run_id, story_id, headline, evidence_ids, observed_at, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $7)
            ON CONFLICT (run_id, story_id) DO NOTHING
            RETURNING ${STORY_EVENT_UPDATE_COLUMNS}
          `,
          [
            updateId,
            event.id,
            input.runId,
            story.storyId,
            story.headline,
            encodeJson([...story.evidenceIds]),
            input.observedAt,
          ],
        );
        const isNewUpdate = insertedUpdate.rows[0] !== undefined;
        let update: StoryEventUpdateRecord;

        if (isNewUpdate) {
          update = mapStoryEventUpdate(insertedUpdate.rows[0]!);
          const updatedEvent = await client.query<StoryEventRow>(
            `
              UPDATE story_events
              SET
                latest_headline = CASE WHEN $3::date >= last_seen_date THEN $2 ELSE latest_headline END,
                first_seen_date = LEAST(first_seen_date, $3::date),
                last_seen_date = GREATEST(last_seen_date, $3::date),
                first_run_id = CASE WHEN $3::date < first_seen_date THEN $4 ELSE first_run_id END,
                latest_run_id = CASE WHEN $3::date >= last_seen_date THEN $4 ELSE latest_run_id END,
                update_count = update_count + 1,
                updated_at = GREATEST(updated_at, $5::timestamptz)
              WHERE id = $1
              RETURNING ${STORY_EVENT_COLUMNS}
            `,
            [event.id, story.headline, run.report_date, input.runId, input.observedAt],
          );
          event = mapStoryEvent(requireRow(updatedEvent.rows[0], "Story event update"));
          const candidateIndex = availableEvents.findIndex(
            (candidate) => candidate.id === event!.id,
          );

          if (candidateIndex >= 0) {
            availableEvents[candidateIndex] = event;
          }
        } else {
          const existingUpdate = await client.query<StoryEventUpdateRow>(
            `
              SELECT ${STORY_EVENT_UPDATE_COLUMNS}
              FROM story_event_updates
              WHERE run_id = $1 AND story_id = $2
            `,
            [input.runId, story.storyId],
          );
          update = mapStoryEventUpdate(
            requireRow(existingUpdate.rows[0], "Story event update conflict lookup"),
          );
        }

        saved.push({ event, update, isNewEvent, isNewUpdate });
      }

      return saved;
    });
  }

  async listStoryEventUpdates(runId: string): Promise<StoryEventUpdateRecord[]> {
    const result = await this.pool.query<StoryEventUpdateRow>(
      `
        SELECT ${STORY_EVENT_UPDATE_COLUMNS}
        FROM story_event_updates
        WHERE run_id = $1
        ORDER BY observed_at ASC, story_id ASC
      `,
      [runId],
    );
    return result.rows.map(mapStoryEventUpdate);
  }

  async listStoryEventsForRun(runId: string): Promise<StoryEventRecord[]> {
    const result = await this.pool.query<StoryEventRow>(
      `
        SELECT DISTINCT ${STORY_EVENT_COLUMNS.split(",")
          .map((column) => `event.${column.trim()}`)
          .join(", ")}
        FROM story_events AS event
        JOIN story_event_updates AS update ON update.event_id = event.id
        WHERE update.run_id = $1
        ORDER BY event.last_seen_date DESC, event.id ASC
      `,
      [runId],
    );
    return result.rows.map(mapStoryEvent);
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

function mapSourceRun(row: SourceRunRow): SourceRunRecord {
  return {
    id: row.id,
    runId: row.run_id,
    sourceId: row.source_id,
    sourceUrlFingerprint: row.source_url_fingerprint,
    attempt: row.attempt,
    status: row.status,
    itemCount: row.item_count,
    error: row.error,
    startedAt: timestamp(row.started_at),
    finishedAt: timestamp(row.finished_at),
    createdAt: timestamp(row.created_at),
  };
}

function mapRawSourceItem(row: RawSourceItemRow): RawSourceItemRecord {
  return {
    id: row.id,
    runId: row.run_id,
    sourceRunId: row.source_run_id,
    sourceId: row.source_id,
    externalId: row.external_id,
    url: row.url,
    title: row.title,
    excerpt: row.excerpt,
    publishedAt: timestamp(row.published_at),
    collectedAt: timestamp(row.collected_at),
    contentHash: row.content_hash,
    raw: row.raw,
    createdAt: timestamp(row.created_at),
  };
}

function mapNormalizedContentItem(row: NormalizedContentRow): NormalizedContentItemRecord {
  return {
    id: row.id,
    runId: row.run_id,
    evidenceId: row.evidence_id,
    sourceId: row.source_id,
    source: row.source,
    url: row.url,
    canonicalUrl: row.canonical_url,
    title: row.title,
    excerpt: row.excerpt,
    publishedAt: nullableTimestamp(row.published_at),
    fingerprint: row.fingerprint,
    titleFingerprint: row.title_fingerprint,
    clusterId: row.cluster_id,
    createdAt: timestamp(row.created_at),
  };
}

function normalizedContentMatches(
  stored: NormalizedContentItemRecord,
  input: NormalizedContentItemInput,
): boolean {
  return (
    stored.id === input.id &&
    stored.sourceId === input.sourceId &&
    stored.source === input.source &&
    stored.url === input.url &&
    stored.canonicalUrl === input.canonicalUrl &&
    stored.title === input.title &&
    stored.excerpt === input.excerpt &&
    stored.publishedAt === input.publishedAt &&
    stored.fingerprint === input.fingerprint &&
    stored.titleFingerprint === input.titleFingerprint &&
    stored.clusterId === input.clusterId
  );
}

function mapStoryEvent(row: StoryEventRow): StoryEventRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    topic: row.topic,
    canonicalHeadline: row.canonical_headline,
    normalizedHeadline: row.normalized_headline,
    titleFingerprint: row.title_fingerprint,
    latestHeadline: row.latest_headline,
    firstSeenDate: dateText(row.first_seen_date),
    lastSeenDate: dateText(row.last_seen_date),
    firstRunId: row.first_run_id,
    latestRunId: row.latest_run_id,
    updateCount: row.update_count,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function mapStoryEventUpdate(row: StoryEventUpdateRow): StoryEventUpdateRecord {
  if (
    !Array.isArray(row.evidence_ids) ||
    row.evidence_ids.some((value) => typeof value !== "string")
  ) {
    throw new Error(`Story event update ${row.id} contains invalid evidence IDs.`);
  }

  return {
    id: row.id,
    eventId: row.event_id,
    runId: row.run_id,
    storyId: row.story_id,
    headline: row.headline,
    evidenceIds: row.evidence_ids,
    observedAt: timestamp(row.observed_at),
    createdAt: timestamp(row.created_at),
  };
}

function bestStoryEventMatch(
  candidates: readonly StoryEventRecord[],
  normalizedHeadline: string,
  titleFingerprint: string,
): StoryEventRecord | null {
  const exact = candidates.find((candidate) => candidate.titleFingerprint === titleFingerprint);

  if (exact !== undefined) {
    return exact;
  }

  let best: { event: StoryEventRecord; similarity: number } | null = null;

  for (const candidate of candidates) {
    const similarity = storyHeadlineSimilarity(candidate.normalizedHeadline, normalizedHeadline);

    if (similarity >= 0.62 && (best === null || similarity > best.similarity)) {
      best = { event: candidate, similarity };
    }
  }

  return best?.event ?? null;
}

export function storyHeadlineSimilarity(left: string, right: string): number {
  if (left === right) {
    return 1;
  }

  if (left.length < 8 || right.length < 8) {
    return 0;
  }

  const leftBigrams = textBigrams(left);
  const rightBigrams = textBigrams(right);
  let intersection = 0;

  for (const value of leftBigrams) {
    if (rightBigrams.has(value)) {
      intersection += 1;
    }
  }

  return (2 * intersection) / (leftBigrams.size + rightBigrams.size);
}

function textBigrams(value: string): Set<string> {
  const characters = [...value];
  const output = new Set<string>();

  for (let index = 0; index < characters.length - 1; index += 1) {
    output.add(`${characters[index]}${characters[index + 1]}`);
  }

  return output;
}

function storyEventId(tenantId: string, topic: string, titleFingerprint: string): string {
  return `event-${createHash("sha256")
    .update(`${tenantId}\u0000${topic}\u0000${titleFingerprint}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function storyEventUpdateId(runId: string, storyId: string): string {
  return `event-update-${createHash("sha256")
    .update(`${runId}\u0000${storyId}`)
    .digest("hex")
    .slice(0, 32)}`;
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

interface SourceRunRow extends QueryResultRow {
  id: string;
  run_id: string;
  source_id: string;
  source_url_fingerprint: string;
  attempt: number;
  status: SourceRunStatus;
  item_count: number;
  error: SerializedError | null;
  started_at: Date | string;
  finished_at: Date | string;
  created_at: Date | string;
}

interface RawSourceItemRow extends QueryResultRow {
  id: string;
  run_id: string;
  source_run_id: string;
  source_id: string;
  external_id: string | null;
  url: string;
  title: string;
  excerpt: string;
  published_at: Date | string;
  collected_at: Date | string;
  content_hash: string;
  raw: JsonObject;
  created_at: Date | string;
}

interface NormalizedContentRow extends QueryResultRow {
  id: string;
  run_id: string;
  evidence_id: string;
  source_id: string | null;
  source: string | null;
  url: string;
  canonical_url: string;
  title: string;
  excerpt: string;
  published_at: Date | string | null;
  fingerprint: string;
  title_fingerprint: string;
  cluster_id: string;
  created_at: Date | string;
}

interface PreviouslySeenContentRow extends QueryResultRow {
  run_id: string;
  evidence_id: string;
  report_date: Date | string;
  fingerprint: string;
  title_fingerprint: string;
}

interface StoryEventRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  topic: string;
  canonical_headline: string;
  normalized_headline: string;
  title_fingerprint: string;
  latest_headline: string;
  first_seen_date: Date | string;
  last_seen_date: Date | string;
  first_run_id: string;
  latest_run_id: string;
  update_count: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface StoryEventUpdateRow extends QueryResultRow {
  id: string;
  event_id: string;
  run_id: string;
  story_id: string;
  headline: string;
  evidence_ids: unknown;
  observed_at: Date | string;
  created_at: Date | string;
}
