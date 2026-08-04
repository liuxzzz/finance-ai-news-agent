import { createHash, randomUUID } from "node:crypto";

import type {
  ArtifactRecord,
  DeliveryRecord,
  JsonObject,
  JsonValue,
  OutputPlugin,
  RenderedArtifact,
  RunIdentity,
  RunRecord,
  RunStageRecord,
  RuntimeStore,
  SerializedError,
} from "@finance-ai-news-agent/plugin-sdk";

import { AgentGraphStateValueSchema, type AgentGraphStateValue } from "./agent-state.js";
import type { AgentWorkflow } from "./agent-workflow.js";

export const RuntimeStage = {
  AgentGraph: "agent_graph",
  PersistMemory: "persist_memory",
  PersistArtifact: "persist_artifact",
  Deliver: "deliver",
} as const;

export interface ExecuteRunRequest extends RunIdentity {
  topic: string;
  maxRevisions?: number;
  scheduledAt?: string;
  configSnapshot?: JsonObject;
  promptVersions?: JsonObject;
  modelSnapshot?: JsonObject;
  dryRun?: boolean;
}

export interface RenderedArtifactContent {
  mediaType: string;
  content: string;
}

export type ArtifactRenderer = (
  state: AgentGraphStateValue,
  run: RunRecord,
) => RenderedArtifactContent | Promise<RenderedArtifactContent>;

export type MemoryPersister = (
  state: AgentGraphStateValue,
  run: RunRecord,
) => JsonValue | Promise<JsonValue>;

export interface RunExecutorOptions {
  store: RuntimeStore;
  workflow: AgentWorkflow;
  renderArtifact: ArtifactRenderer;
  output?: OutputPlugin;
  deliveryTarget?: string;
  artifactKind?: string;
  artifactVersion?: string;
  persistMemory?: MemoryPersister;
  memoryVersion?: string;
  now?: () => Date;
  generateId?: () => string;
}

export type RunDisposition = "executed" | "resumed" | "reused" | "in_progress";

export interface RunExecutionResult {
  disposition: RunDisposition;
  run: RunRecord;
  state: AgentGraphStateValue | null;
  artifact: ArtifactRecord | null;
  delivery: DeliveryRecord | null;
}

export class RunRequestConflictError extends Error {
  constructor(
    readonly runId: string,
    message: string,
  ) {
    super(message);
    this.name = "RunRequestConflictError";
  }
}

export class RunExecutionError extends Error {
  constructor(
    readonly runId: string,
    cause: unknown,
  ) {
    super(`Run ${runId} failed: ${errorMessage(cause)}`, { cause });
    this.name = "RunExecutionError";
  }
}

/**
 * Deterministic outer runtime. LangGraph owns AI-node routing; this executor owns
 * run identity, persistence, recovery, publication gating, and delivery idempotency.
 */
export class RunExecutor {
  private readonly store: RuntimeStore;
  private readonly workflow: AgentWorkflow;
  private readonly renderArtifact: ArtifactRenderer;
  private readonly output: OutputPlugin | undefined;
  private readonly deliveryTarget: string;
  private readonly artifactKind: string;
  private readonly artifactVersion: string;
  private readonly persistMemory: MemoryPersister | undefined;
  private readonly memoryVersion: string;
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(options: RunExecutorOptions) {
    this.store = options.store;
    this.workflow = options.workflow;
    this.renderArtifact = options.renderArtifact;
    this.output = options.output;
    this.deliveryTarget = options.deliveryTarget ?? options.output?.manifest.id ?? "none";
    this.artifactKind = options.artifactKind ?? "digest";
    this.artifactVersion = options.artifactVersion ?? "v1";
    this.persistMemory = options.persistMemory;
    this.memoryVersion = options.memoryVersion ?? "v1";
    this.now = options.now ?? (() => new Date());
    this.generateId = options.generateId ?? randomUUID;
  }

  async execute(request: ExecuteRunRequest): Promise<RunExecutionResult> {
    const normalized = normalizeRequest(request);
    const configSnapshot: JsonObject = {
      ...normalized.configSnapshot,
      runtime: {
        artifactKind: this.artifactKind,
        artifactVersion: this.artifactVersion,
        memoryVersion: this.persistMemory === undefined ? null : this.memoryVersion,
        outputPluginId: this.output?.manifest.id ?? null,
        outputPluginVersion: this.output?.manifest.version ?? null,
        deliveryTarget: this.deliveryTarget,
      },
    };
    const requestHash = hashJson(
      toJsonValue({
        tenantId: normalized.tenantId,
        reportDate: normalized.reportDate,
        edition: normalized.edition,
        topic: normalized.topic,
        maxRevisions: normalized.maxRevisions,
        scheduledAt: normalized.scheduledAt,
        configSnapshot,
        promptVersions: normalized.promptVersions,
        modelSnapshot: normalized.modelSnapshot,
      }),
    );
    const createdAt = this.timestamp();
    const created = await this.store.createOrGetRun({
      id: this.generateId(),
      tenantId: normalized.tenantId,
      reportDate: normalized.reportDate,
      edition: normalized.edition,
      topic: normalized.topic,
      maxRevisions: normalized.maxRevisions,
      inputHash: requestHash,
      configSnapshot,
      promptVersions: normalized.promptVersions,
      modelSnapshot: normalized.modelSnapshot,
      scheduledAt: normalized.scheduledAt,
      createdAt,
    });

    if (created.run.inputHash !== requestHash) {
      throw new RunRequestConflictError(
        created.run.id,
        `Run identity ${normalized.tenantId}/${normalized.reportDate}/${normalized.edition} ` +
          "already exists with a different request.",
      );
    }

    const lock = await this.store.tryAcquireRunLock(created.run.id);

    if (lock === null) {
      const busyRun = (await this.store.getRun(created.run.id)) ?? created.run;
      return this.loadExistingResult(busyRun, "in_progress");
    }

    try {
      const current = (await this.store.getRun(created.run.id)) ?? created.run;

      if (isTerminal(current)) {
        if (current.status === "succeeded" && !normalized.dryRun && this.output !== undefined) {
          return this.deliverCompletedRun(current);
        }

        return this.loadExistingResult(current, "reused");
      }

      const run = await this.store.markRunRunning(current.id, this.timestamp());
      const disposition: RunDisposition = created.created ? "executed" : "resumed";

      try {
        const state = await this.executeStage({
          runId: run.id,
          stage: RuntimeStage.AgentGraph,
          inputHash: requestHash,
          execute: async () =>
            AgentGraphStateValueSchema.parse(
              await (created.created
                ? this.workflow.start({
                    runId: run.id,
                    topic: run.topic,
                    maxRevisions: run.maxRevisions,
                  })
                : this.workflow.resume({
                    runId: run.id,
                    topic: run.topic,
                    maxRevisions: run.maxRevisions,
                  })),
            ),
          serialize: (value) => toJsonValue(AgentGraphStateValueSchema.parse(value)),
          deserialize: (value) => AgentGraphStateValueSchema.parse(value),
          outputRefs: { checkpointThreadId: run.id },
        });

        if (!state.approved) {
          const rejected = await this.store.finishRun({
            runId: run.id,
            status: "rejected",
            error: null,
            finishedAt: this.timestamp(),
          });

          return {
            disposition,
            run: rejected,
            state,
            artifact: null,
            delivery: null,
          };
        }

        if (this.persistMemory !== undefined) {
          const memoryInputHash = hashJson(
            toJsonValue({
              stories: state.stories,
              evidence: state.evidence.map((item) => ({
                id: item.id,
                fingerprint: item.fingerprint ?? null,
                clusterId: item.clusterId ?? null,
              })),
              memoryVersion: this.memoryVersion,
            }),
          );
          await this.executeStage({
            runId: run.id,
            stage: RuntimeStage.PersistMemory,
            inputHash: memoryInputHash,
            execute: async () => this.persistMemory!(state, run),
            serialize: (value) => value,
            deserialize: (value) => value,
            outputRefs: { memoryVersion: this.memoryVersion },
          });
        }

        const artifactInputHash = hashJson(
          toJsonValue({
            state,
            artifactKind: this.artifactKind,
            artifactVersion: this.artifactVersion,
          }),
        );
        const artifact = await this.executeStage({
          runId: run.id,
          stage: RuntimeStage.PersistArtifact,
          inputHash: artifactInputHash,
          execute: async () => {
            const rendered = await this.renderArtifact(state, run);
            const record: ArtifactRecord = {
              id: `${run.id}:${this.artifactKind}`,
              runId: run.id,
              kind: this.artifactKind,
              mediaType: rendered.mediaType,
              content: rendered.content,
              contentHash: hashText(rendered.content),
              createdAt: this.timestamp(),
            };
            return this.store.saveArtifact(record);
          },
          serialize: (value) => ({ artifactId: value.id }),
          deserialize: async () => {
            const stored = await this.store.getArtifactForRun(run.id, this.artifactKind);

            if (stored === null) {
              throw new Error(`Artifact stage succeeded but no ${this.artifactKind} exists.`);
            }

            return stored;
          },
          outputRefs: {},
        });

        const delivery = await this.executeDeliveryStage(run, artifact, normalized.dryRun);
        const succeeded = await this.store.finishRun({
          runId: run.id,
          status: "succeeded",
          error: null,
          finishedAt: this.timestamp(),
        });

        return {
          disposition,
          run: succeeded,
          state,
          artifact,
          delivery,
        };
      } catch (error) {
        const failedAt = this.timestamp();
        const latest = await this.store.getRun(run.id);

        if (latest?.status === "running") {
          await this.store.finishRun({
            runId: run.id,
            status: "failed",
            error: serializeError(error),
            finishedAt: failedAt,
          });
        }

        throw new RunExecutionError(run.id, error);
      }
    } finally {
      await lock.release();
    }
  }

  private async executeDeliveryStage(
    run: RunRecord,
    artifact: ArtifactRecord,
    dryRun: boolean,
  ): Promise<DeliveryRecord | null> {
    const inputHash = hashJson(
      toJsonValue({
        artifactId: artifact.id,
        contentHash: artifact.contentHash,
        pluginId: this.output?.manifest.id ?? null,
        pluginVersion: this.output?.manifest.version ?? null,
        target: this.deliveryTarget,
        dryRun,
      }),
    );

    if (dryRun || this.output === undefined) {
      await this.skipStage(
        run.id,
        RuntimeStage.Deliver,
        inputHash,
        dryRun ? "dry_run" : "no_output_plugin",
      );
      return null;
    }

    const output = this.output;
    const deliveryKey = this.deliveryKey(artifact, output);

    return this.executeStage({
      runId: run.id,
      stage: RuntimeStage.Deliver,
      inputHash,
      execute: async () => {
        const started = await this.store.startDelivery({
          id: this.generateId(),
          runId: run.id,
          artifactId: artifact.id,
          deliveryKey,
          pluginId: output.manifest.id,
          target: this.deliveryTarget,
          startedAt: this.timestamp(),
        });

        if (!started.shouldDeliver) {
          return started.delivery;
        }

        const rendered: RenderedArtifact = {
          id: artifact.id,
          mediaType: artifact.mediaType,
          content: artifact.content,
        };
        let receipt;

        try {
          receipt = await output.deliver(rendered, { deliveryKey });
        } catch (error) {
          await this.store.failDelivery({
            deliveryId: started.delivery.id,
            error: serializeError(error),
            finishedAt: this.timestamp(),
          });
          throw error;
        }

        return this.store.completeDelivery({
          deliveryId: started.delivery.id,
          receipt: toJsonValue(receipt),
          finishedAt: this.timestamp(),
        });
      },
      serialize: (value) => ({ deliveryKey: value.deliveryKey }),
      deserialize: async () => {
        const stored = await this.store.getDeliveryByKey(deliveryKey);

        if (stored === null) {
          throw new Error("Delivery stage succeeded but no delivery record exists.");
        }

        return stored;
      },
      outputRefs: {},
    });
  }

  private async deliverCompletedRun(run: RunRecord): Promise<RunExecutionResult> {
    const artifact = await this.store.getArtifactForRun(run.id, this.artifactKind);

    if (artifact === null) {
      throw new RunExecutionError(
        run.id,
        new Error(`Succeeded run ${run.id} does not have a ${this.artifactKind} artifact.`),
      );
    }

    const output = this.output;

    if (output === undefined) {
      return this.loadExistingResult(run, "reused");
    }

    const existing = await this.store.getDeliveryByKey(this.deliveryKey(artifact, output));

    try {
      await this.executeDeliveryStage(run, artifact, false);
    } catch (error) {
      throw new RunExecutionError(run.id, error);
    }

    return this.loadExistingResult(run, existing?.status === "succeeded" ? "reused" : "resumed");
  }

  private deliveryKey(artifact: ArtifactRecord, output: OutputPlugin): string {
    return hashText(`${artifact.id}\u0000${output.manifest.id}\u0000${this.deliveryTarget}`);
  }

  private async executeStage<T>(options: {
    runId: string;
    stage: string;
    inputHash: string;
    execute: () => Promise<T>;
    serialize: (value: T) => JsonValue;
    deserialize: (value: JsonValue) => T | Promise<T>;
    outputRefs: JsonObject;
  }): Promise<T> {
    const latest = await this.store.getLatestStage(options.runId, options.stage);

    if (latest?.status === "succeeded") {
      ensureStageInputMatches(latest, options.inputHash);

      if (latest.output === null) {
        throw new Error(`Succeeded stage ${options.stage} has no output.`);
      }

      return options.deserialize(latest.output);
    }

    await this.failInterruptedStage(latest);
    const stage = await this.store.startStage({
      runId: options.runId,
      stage: options.stage,
      inputHash: options.inputHash,
      startedAt: this.timestamp(),
    });

    let value: T;

    try {
      value = await options.execute();
    } catch (error) {
      await this.store.failStage({
        stageId: stage.id,
        error: serializeError(error),
        finishedAt: this.timestamp(),
      });
      throw error;
    }

    await this.store.completeStage({
      stageId: stage.id,
      output: options.serialize(value),
      outputRefs: options.outputRefs,
      finishedAt: this.timestamp(),
    });
    return value;
  }

  private async skipStage(
    runId: string,
    stageName: string,
    inputHash: string,
    reason: string,
  ): Promise<void> {
    const latest = await this.store.getLatestStage(runId, stageName);

    if (latest?.status === "skipped" || latest?.status === "succeeded") {
      ensureStageInputMatches(latest, inputHash);
      return;
    }

    await this.failInterruptedStage(latest);
    const stage = await this.store.startStage({
      runId,
      stage: stageName,
      inputHash,
      startedAt: this.timestamp(),
    });
    await this.store.skipStage({
      stageId: stage.id,
      output: { reason },
      finishedAt: this.timestamp(),
    });
  }

  private async failInterruptedStage(stage: RunStageRecord | null): Promise<void> {
    if (stage?.status !== "running") {
      return;
    }

    await this.store.failStage({
      stageId: stage.id,
      error: {
        name: "InterruptedExecution",
        message: "The previous worker stopped before completing this stage.",
      },
      finishedAt: this.timestamp(),
    });
  }

  private async loadExistingResult(
    run: RunRecord,
    disposition: RunDisposition,
  ): Promise<RunExecutionResult> {
    const graphStage = await this.store.getLatestStage(run.id, RuntimeStage.AgentGraph);
    const state =
      graphStage?.status === "succeeded" && graphStage.output !== null
        ? AgentGraphStateValueSchema.parse(graphStage.output)
        : null;
    const artifact = await this.store.getArtifactForRun(run.id, this.artifactKind);
    const deliveries = await this.store.listDeliveries(run.id);
    const delivery = deliveries.find((candidate) => candidate.status === "succeeded") ?? null;

    return { disposition, run, state, artifact, delivery };
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

interface NormalizedRunRequest extends RunIdentity {
  topic: string;
  maxRevisions: number;
  scheduledAt: string | null;
  configSnapshot: JsonObject;
  promptVersions: JsonObject;
  modelSnapshot: JsonObject;
  dryRun: boolean;
}

function normalizeRequest(request: ExecuteRunRequest): NormalizedRunRequest {
  if (!isCalendarDate(request.reportDate)) {
    throw new Error(`Invalid report date: ${request.reportDate}. Expected YYYY-MM-DD.`);
  }

  const maxRevisions = request.maxRevisions ?? 1;

  if (!Number.isInteger(maxRevisions) || maxRevisions < 0) {
    throw new Error("maxRevisions must be a non-negative integer.");
  }

  return {
    tenantId: requireNonEmpty(request.tenantId, "tenantId"),
    reportDate: request.reportDate,
    edition: requireNonEmpty(request.edition, "edition"),
    topic: requireNonEmpty(request.topic, "topic"),
    maxRevisions,
    scheduledAt: request.scheduledAt ?? null,
    configSnapshot: request.configSnapshot ?? {},
    promptVersions: request.promptVersions ?? {},
    modelSnapshot: request.modelSnapshot ?? {},
    dryRun: request.dryRun ?? false,
  };
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function ensureStageInputMatches(stage: RunStageRecord, inputHash: string): void {
  if (stage.inputHash !== inputHash) {
    throw new RunRequestConflictError(
      stage.runId,
      `Stage ${stage.stage} already succeeded with a different input hash.`,
    );
  }
}

function isTerminal(run: RunRecord): boolean {
  return run.status !== "pending" && run.status !== "running" && run.status !== "failed";
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }

  return {
    name: "Error",
    message: errorMessage(error),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new Error(`${field} cannot be empty.`);
  }

  return normalized;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashJson(value: JsonValue): string {
  return hashText(JSON.stringify(value));
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot persist a non-finite number as JSON.");
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }

  if (typeof value === "object") {
    const result: JsonObject = {};

    for (const [key, item] of Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      if (item === undefined) {
        continue;
      }

      result[key] = toJsonValue(item);
    }

    return result;
  }

  throw new Error(`Cannot persist ${typeof value} as JSON.`);
}
