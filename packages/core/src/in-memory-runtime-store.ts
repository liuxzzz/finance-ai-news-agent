import type {
  ArtifactRecord,
  CompleteDeliveryInput,
  CompleteModelCallInput,
  CompleteRunStageInput,
  CreateRunInput,
  CreateRunResult,
  DeliveryRecord,
  FailDeliveryInput,
  FailModelCallInput,
  FailRunStageInput,
  FinishRunInput,
  ModelCallRecord,
  RunIdentity,
  RunLock,
  RunRecord,
  RunStageRecord,
  RuntimeStore,
  SaveArtifactInput,
  SkipRunStageInput,
  StartDeliveryInput,
  StartDeliveryResult,
  StartModelCallInput,
  StartModelCallResult,
  StartRunStageInput,
} from "@finance-ai-news-agent/plugin-sdk";

/** In-process adapter for the fixture demo and deterministic runtime tests. */
export class InMemoryRuntimeStore implements RuntimeStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly runIdsByIdentity = new Map<string, string>();
  private readonly stages = new Map<string, RunStageRecord[]>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly deliveries = new Map<string, DeliveryRecord>();
  private readonly modelCalls = new Map<string, ModelCallRecord>();
  private readonly lockedRunIds = new Set<string>();
  private sequence = 0;

  async createOrGetRun(input: CreateRunInput): Promise<CreateRunResult> {
    const identityKey = runIdentityKey(input);
    const existingId = this.runIdsByIdentity.get(identityKey);

    if (existingId !== undefined) {
      return {
        run: clone(this.requireRun(existingId)),
        created: false,
      };
    }

    const run: RunRecord = {
      ...clone(input),
      status: "pending",
      attemptCount: 0,
      startedAt: null,
      finishedAt: null,
      error: null,
      updatedAt: input.createdAt,
    };
    this.runs.set(run.id, run);
    this.runIdsByIdentity.set(identityKey, run.id);

    return { run: clone(run), created: true };
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const run = this.runs.get(runId);
    return run === undefined ? null : clone(run);
  }

  async findRun(identity: RunIdentity): Promise<RunRecord | null> {
    const runId = this.runIdsByIdentity.get(runIdentityKey(identity));
    return runId === undefined ? null : clone(this.requireRun(runId));
  }

  async markRunRunning(runId: string, startedAt: string): Promise<RunRecord> {
    const run = this.requireRun(runId);

    if (isTerminal(run.status)) {
      throw new Error(`Cannot start terminal run ${runId} with status ${run.status}.`);
    }

    const updated: RunRecord = {
      ...run,
      status: "running",
      attemptCount: run.attemptCount + 1,
      startedAt: run.startedAt ?? startedAt,
      finishedAt: null,
      error: null,
      updatedAt: startedAt,
    };
    this.runs.set(runId, updated);
    return clone(updated);
  }

  async finishRun(input: FinishRunInput): Promise<RunRecord> {
    const run = this.requireRun(input.runId);

    if (run.status !== "running") {
      throw new Error(`Cannot finish run ${run.id} from status ${run.status}.`);
    }

    const updated: RunRecord = {
      ...run,
      status: input.status,
      error: clone(input.error),
      finishedAt: input.finishedAt,
      updatedAt: input.finishedAt,
    };
    this.runs.set(run.id, updated);
    return clone(updated);
  }

  async tryAcquireRunLock(runId: string): Promise<RunLock | null> {
    if (this.lockedRunIds.has(runId)) {
      return null;
    }

    this.lockedRunIds.add(runId);
    let released = false;

    return {
      release: async () => {
        if (!released) {
          released = true;
          this.lockedRunIds.delete(runId);
        }
      },
    };
  }

  async getLatestStage(runId: string, stage: string): Promise<RunStageRecord | null> {
    const records = this.stages.get(runId) ?? [];
    const found = records.filter((record) => record.stage === stage).at(-1);
    return found === undefined ? null : clone(found);
  }

  async listStages(runId: string): Promise<RunStageRecord[]> {
    return clone(this.stages.get(runId) ?? []);
  }

  async startStage(input: StartRunStageInput): Promise<RunStageRecord> {
    this.requireRun(input.runId);
    const records = this.stages.get(input.runId) ?? [];

    if (records.some((record) => record.stage === input.stage && record.status === "running")) {
      throw new Error(`Stage ${input.stage} is already running for run ${input.runId}.`);
    }

    const attempt =
      Math.max(
        0,
        ...records.filter((record) => record.stage === input.stage).map((record) => record.attempt),
      ) + 1;
    const stage: RunStageRecord = {
      id: this.nextId("stage"),
      runId: input.runId,
      stage: input.stage,
      attempt,
      status: "running",
      inputHash: input.inputHash,
      output: null,
      outputRefs: {},
      error: null,
      startedAt: input.startedAt,
      finishedAt: null,
      createdAt: input.startedAt,
    };
    records.push(stage);
    this.stages.set(input.runId, records);
    return clone(stage);
  }

  async completeStage(input: CompleteRunStageInput): Promise<RunStageRecord> {
    return this.updateRunningStage(input.stageId, (stage) => ({
      ...stage,
      status: "succeeded",
      output: clone(input.output),
      outputRefs: clone(input.outputRefs),
      finishedAt: input.finishedAt,
    }));
  }

  async failStage(input: FailRunStageInput): Promise<RunStageRecord> {
    return this.updateRunningStage(input.stageId, (stage) => ({
      ...stage,
      status: "failed",
      error: clone(input.error),
      finishedAt: input.finishedAt,
    }));
  }

  async skipStage(input: SkipRunStageInput): Promise<RunStageRecord> {
    return this.updateRunningStage(input.stageId, (stage) => ({
      ...stage,
      status: "skipped",
      output: clone(input.output),
      finishedAt: input.finishedAt,
    }));
  }

  async saveArtifact(input: SaveArtifactInput): Promise<ArtifactRecord> {
    this.requireRun(input.runId);
    const key = artifactKey(input.runId, input.kind);
    const existing = this.artifacts.get(key);

    if (existing !== undefined) {
      if (
        existing.id !== input.id ||
        existing.contentHash !== input.contentHash ||
        existing.content !== input.content ||
        existing.mediaType !== input.mediaType
      ) {
        throw new Error(`Artifact conflict for run ${input.runId} and kind ${input.kind}.`);
      }

      return clone(existing);
    }

    const artifact = clone(input);
    this.artifacts.set(key, artifact);
    return clone(artifact);
  }

  async getArtifactForRun(runId: string, kind: string): Promise<ArtifactRecord | null> {
    const artifact = this.artifacts.get(artifactKey(runId, kind));
    return artifact === undefined ? null : clone(artifact);
  }

  async startDelivery(input: StartDeliveryInput): Promise<StartDeliveryResult> {
    const existing = this.deliveries.get(input.deliveryKey);

    if (existing?.status === "succeeded") {
      return { delivery: clone(existing), shouldDeliver: false };
    }

    const delivery: DeliveryRecord =
      existing === undefined
        ? {
            ...clone(input),
            status: "running",
            attempt: 1,
            receipt: null,
            error: null,
            finishedAt: null,
            createdAt: input.startedAt,
            updatedAt: input.startedAt,
          }
        : {
            ...existing,
            status: "running",
            attempt: existing.attempt + 1,
            receipt: null,
            error: null,
            startedAt: input.startedAt,
            finishedAt: null,
            updatedAt: input.startedAt,
          };

    this.deliveries.set(input.deliveryKey, delivery);
    return { delivery: clone(delivery), shouldDeliver: true };
  }

  async getDeliveryByKey(deliveryKey: string): Promise<DeliveryRecord | null> {
    const delivery = this.deliveries.get(deliveryKey);
    return delivery === undefined ? null : clone(delivery);
  }

  async listDeliveries(runId: string): Promise<DeliveryRecord[]> {
    return clone([...this.deliveries.values()].filter((delivery) => delivery.runId === runId));
  }

  async completeDelivery(input: CompleteDeliveryInput): Promise<DeliveryRecord> {
    return this.updateRunningDelivery(input.deliveryId, (delivery) => ({
      ...delivery,
      status: "succeeded",
      receipt: clone(input.receipt),
      finishedAt: input.finishedAt,
      updatedAt: input.finishedAt,
    }));
  }

  async failDelivery(input: FailDeliveryInput): Promise<DeliveryRecord> {
    return this.updateRunningDelivery(input.deliveryId, (delivery) => ({
      ...delivery,
      status: "failed",
      error: clone(input.error),
      finishedAt: input.finishedAt,
      updatedAt: input.finishedAt,
    }));
  }

  async startModelCall(input: StartModelCallInput): Promise<StartModelCallResult> {
    this.requireRun(input.runId);

    if (!Number.isSafeInteger(input.maxRequests) || input.maxRequests <= 0) {
      throw new Error("maxRequests must be a positive integer.");
    }

    if (this.modelCalls.has(input.id)) {
      throw new Error(`Model call ${input.id} already exists.`);
    }

    const usedRequests = [...this.modelCalls.values()].filter(
      (call) => call.runId === input.runId,
    ).length;

    if (usedRequests >= input.maxRequests) {
      return { accepted: false, call: null, usedRequests };
    }

    const call: ModelCallRecord = {
      id: input.id,
      runId: input.runId,
      ordinal: usedRequests + 1,
      role: input.role,
      providerId: input.providerId,
      requestHash: input.requestHash,
      status: "running",
      model: null,
      finishReason: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      error: null,
      startedAt: input.startedAt,
      finishedAt: null,
      createdAt: input.startedAt,
      updatedAt: input.startedAt,
    };
    this.modelCalls.set(call.id, call);
    return { accepted: true, call: clone(call), usedRequests: usedRequests + 1 };
  }

  async listModelCalls(runId: string): Promise<ModelCallRecord[]> {
    return clone(
      [...this.modelCalls.values()]
        .filter((call) => call.runId === runId)
        .sort((left, right) => left.ordinal - right.ordinal),
    );
  }

  async completeModelCall(input: CompleteModelCallInput): Promise<ModelCallRecord> {
    return this.updateRunningModelCall(input.callId, (call) => ({
      ...call,
      status: "succeeded",
      model: input.model,
      finishReason: input.finishReason,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.totalTokens,
      error: null,
      finishedAt: input.finishedAt,
      updatedAt: input.finishedAt,
    }));
  }

  async failModelCall(input: FailModelCallInput): Promise<ModelCallRecord> {
    return this.updateRunningModelCall(input.callId, (call) => ({
      ...call,
      status: "failed",
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.totalTokens,
      error: clone(input.error),
      finishedAt: input.finishedAt,
      updatedAt: input.finishedAt,
    }));
  }

  private requireRun(runId: string): RunRecord {
    const run = this.runs.get(runId);

    if (run === undefined) {
      throw new Error(`Run ${runId} does not exist.`);
    }

    return run;
  }

  private updateRunningStage(
    stageId: string,
    update: (stage: RunStageRecord) => RunStageRecord,
  ): RunStageRecord {
    for (const records of this.stages.values()) {
      const index = records.findIndex((stage) => stage.id === stageId);

      if (index === -1) {
        continue;
      }

      const stage = records[index];

      if (stage?.status !== "running") {
        throw new Error(`Stage ${stageId} is not running.`);
      }

      const updated = update(stage);
      records[index] = updated;
      return clone(updated);
    }

    throw new Error(`Stage ${stageId} does not exist.`);
  }

  private updateRunningDelivery(
    deliveryId: string,
    update: (delivery: DeliveryRecord) => DeliveryRecord,
  ): DeliveryRecord {
    const entry = [...this.deliveries.entries()].find(([, delivery]) => delivery.id === deliveryId);

    if (entry === undefined) {
      throw new Error(`Delivery ${deliveryId} does not exist.`);
    }

    const [key, delivery] = entry;

    if (delivery.status !== "running") {
      throw new Error(`Delivery ${deliveryId} is not running.`);
    }

    const updated = update(delivery);
    this.deliveries.set(key, updated);
    return clone(updated);
  }

  private updateRunningModelCall(
    callId: string,
    update: (call: ModelCallRecord) => ModelCallRecord,
  ): ModelCallRecord {
    const call = this.modelCalls.get(callId);

    if (call === undefined) {
      throw new Error(`Model call ${callId} does not exist.`);
    }

    if (call.status !== "running") {
      throw new Error(`Model call ${callId} is not running.`);
    }

    const updated = update(call);
    this.modelCalls.set(callId, updated);
    return clone(updated);
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }
}

function runIdentityKey(identity: RunIdentity): string {
  return `${identity.tenantId}\u0000${identity.reportDate}\u0000${identity.edition}`;
}

function artifactKey(runId: string, kind: string): string {
  return `${runId}\u0000${kind}`;
}

function isTerminal(status: RunRecord["status"]): boolean {
  return status !== "pending" && status !== "running" && status !== "failed";
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
