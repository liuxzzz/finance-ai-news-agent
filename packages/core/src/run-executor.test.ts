import type {
  DeliveryContext,
  DeliveryReceipt,
  OutputPlugin,
  PluginManifest,
  RenderedArtifact,
} from "@finance-ai-news-agent/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  InMemoryRuntimeStore,
  RunExecutionError,
  RunExecutor,
  RuntimeStage,
  type AgentGraphStateValue,
  type AgentWorkflow,
  type ExecuteRunRequest,
} from "./index.js";

const request: ExecuteRunRequest = {
  tenantId: "default",
  reportDate: "2026-08-04",
  edition: "daily",
  topic: "Finance & AI",
  maxRevisions: 1,
};

describe("run executor", () => {
  it("persists an approved run and reuses it on a duplicate trigger", async () => {
    const store = new InMemoryRuntimeStore();
    const workflow: AgentWorkflow = {
      start: vi.fn(async (input) => approvedState(input.runId)),
      resume: vi.fn(async (input) => approvedState(input.runId)),
    };
    const output = new RecordingOutput();
    const executor = createExecutor(store, workflow, output);

    const first = await executor.execute(request);
    const duplicate = await executor.execute(request);

    expect(first.disposition).toBe("executed");
    expect(first.run.status).toBe("succeeded");
    expect(first.artifact?.content).toContain("approved draft");
    expect(first.delivery?.status).toBe("succeeded");
    expect(duplicate.disposition).toBe("reused");
    expect(duplicate.run.id).toBe(first.run.id);
    expect(workflow.start).toHaveBeenCalledTimes(1);
    expect(workflow.resume).not.toHaveBeenCalled();
    expect(output.calls).toHaveLength(1);
    expect(await store.listStages(first.run.id)).toHaveLength(3);
  });

  it("returns in_progress when the same run is already locked", async () => {
    const store = new InMemoryRuntimeStore();
    const started = deferred<void>();
    const continueRun = deferred<void>();
    const workflow: AgentWorkflow = {
      start: async (input) => {
        started.resolve();
        await continueRun.promise;
        return approvedState(input.runId);
      },
      resume: async (input) => approvedState(input.runId),
    };
    const executor = createExecutor(store, workflow);

    const firstPromise = executor.execute({ ...request, dryRun: true });
    await started.promise;
    const duplicate = await executor.execute({ ...request, dryRun: true });
    continueRun.resolve();
    const first = await firstPromise;

    expect(duplicate.disposition).toBe("in_progress");
    expect(duplicate.run.id).toBe(first.run.id);
    expect(first.run.status).toBe("succeeded");
  });

  it("resumes the same run after a graph failure and records a new stage attempt", async () => {
    const store = new InMemoryRuntimeStore();
    const workflow: AgentWorkflow = {
      start: vi.fn(async () => {
        throw new Error("model unavailable");
      }),
      resume: vi.fn(async (input) => approvedState(input.runId)),
    };
    const executor = createExecutor(store, workflow);

    await expect(executor.execute({ ...request, dryRun: true })).rejects.toBeInstanceOf(
      RunExecutionError,
    );
    const recovered = await executor.execute({ ...request, dryRun: true });
    const stages = await store.listStages(recovered.run.id);
    const graphStages = stages.filter((stage) => stage.stage === RuntimeStage.AgentGraph);

    expect(recovered.disposition).toBe("resumed");
    expect(recovered.run.status).toBe("succeeded");
    expect(recovered.run.attemptCount).toBe(2);
    expect(workflow.start).toHaveBeenCalledTimes(1);
    expect(workflow.resume).toHaveBeenCalledTimes(1);
    expect(graphStages.map((stage) => stage.status)).toEqual(["failed", "succeeded"]);
    expect(graphStages.map((stage) => stage.attempt)).toEqual([1, 2]);
  });

  it("rejects an unapproved graph result without creating or delivering an artifact", async () => {
    const store = new InMemoryRuntimeStore();
    const workflow: AgentWorkflow = {
      start: async (input) => rejectedState(input.runId),
      resume: async (input) => rejectedState(input.runId),
    };
    const output = new RecordingOutput();
    const executor = createExecutor(store, workflow, output);

    const result = await executor.execute(request);

    expect(result.run.status).toBe("rejected");
    expect(result.artifact).toBeNull();
    expect(result.delivery).toBeNull();
    expect(output.calls).toHaveLength(0);
    expect(await store.listStages(result.run.id)).toHaveLength(1);
  });

  it("reuses graph and artifact stages while retrying delivery with the same key", async () => {
    const store = new InMemoryRuntimeStore();
    const workflow: AgentWorkflow = {
      start: vi.fn(async (input) => approvedState(input.runId)),
      resume: vi.fn(async (input) => approvedState(input.runId)),
    };
    const output = new RecordingOutput(1);
    const executor = createExecutor(store, workflow, output);

    await expect(executor.execute(request)).rejects.toBeInstanceOf(RunExecutionError);
    const recovered = await executor.execute(request);
    const stages = await store.listStages(recovered.run.id);

    expect(recovered.run.status).toBe("succeeded");
    expect(workflow.start).toHaveBeenCalledTimes(1);
    expect(workflow.resume).not.toHaveBeenCalled();
    expect(output.calls).toHaveLength(2);
    expect(output.calls[0]?.deliveryKey).toBe(output.calls[1]?.deliveryKey);
    expect(stages.filter((stage) => stage.stage === RuntimeStage.PersistArtifact)).toHaveLength(1);
    expect(stages.filter((stage) => stage.stage === RuntimeStage.Deliver)).toHaveLength(2);
  });

  it("can publish an existing dry-run artifact without regenerating the run", async () => {
    const store = new InMemoryRuntimeStore();
    const workflow: AgentWorkflow = {
      start: vi.fn(async (input) => approvedState(input.runId)),
      resume: vi.fn(async (input) => approvedState(input.runId)),
    };
    const output = new RecordingOutput();
    const executor = createExecutor(store, workflow, output);

    const preview = await executor.execute({ ...request, dryRun: true });
    const published = await executor.execute(request);
    const duplicate = await executor.execute(request);
    const deliveryStages = (await store.listStages(preview.run.id)).filter(
      (stage) => stage.stage === RuntimeStage.Deliver,
    );

    expect(preview.delivery).toBeNull();
    expect(published.run.id).toBe(preview.run.id);
    expect(published.disposition).toBe("resumed");
    expect(published.delivery?.status).toBe("succeeded");
    expect(duplicate.disposition).toBe("reused");
    expect(workflow.start).toHaveBeenCalledTimes(1);
    expect(workflow.resume).not.toHaveBeenCalled();
    expect(output.calls).toHaveLength(1);
    expect(deliveryStages.map((stage) => stage.status)).toEqual(["skipped", "succeeded"]);
  });

  it("persists approved story memory once before rendering the artifact", async () => {
    const store = new InMemoryRuntimeStore();
    const workflow: AgentWorkflow = {
      start: vi.fn(async (input) => approvedState(input.runId)),
      resume: vi.fn(async (input) => approvedState(input.runId)),
    };
    const persistMemory = vi.fn(async () => ({ events: 1 }));
    const executor = createExecutor(store, workflow, undefined, persistMemory);

    const first = await executor.execute({ ...request, dryRun: true });
    await executor.execute({ ...request, dryRun: true });
    const stages = await store.listStages(first.run.id);

    expect(persistMemory).toHaveBeenCalledTimes(1);
    expect(stages.find((stage) => stage.stage === RuntimeStage.PersistMemory)?.status).toBe(
      "succeeded",
    );
    expect(stages.findIndex((stage) => stage.stage === RuntimeStage.PersistMemory)).toBeLessThan(
      stages.findIndex((stage) => stage.stage === RuntimeStage.PersistArtifact),
    );
  });
});

function createExecutor(
  store: InMemoryRuntimeStore,
  workflow: AgentWorkflow,
  output?: OutputPlugin,
  persistMemory?: NonNullable<ConstructorParameters<typeof RunExecutor>[0]["persistMemory"]>,
): RunExecutor {
  let id = 0;

  return new RunExecutor({
    store,
    workflow,
    renderArtifact: (state) => ({
      mediaType: "text/markdown",
      content: `# Digest\n\n${state.draft}`,
    }),
    ...(output === undefined ? {} : { output }),
    ...(persistMemory === undefined ? {} : { persistMemory }),
    deliveryTarget: ".artifacts/test.md",
    now: () => new Date("2026-08-04T00:00:00.000Z"),
    generateId: () => `id-${++id}`,
  });
}

function approvedState(runId: string): AgentGraphStateValue {
  return graphState(runId, true);
}

function rejectedState(runId: string): AgentGraphStateValue {
  return graphState(runId, false);
}

function graphState(runId: string, approved: boolean): AgentGraphStateValue {
  return {
    runId,
    topic: "Finance & AI",
    maxRevisions: 1,
    plan: ["research"],
    evidence: [],
    stories: [],
    draft: approved ? "approved draft" : "rejected draft",
    critique: approved ? "ok" : "missing evidence",
    approved,
    reviewRoute: "revise",
    revisionCount: 1,
    trace: ["research", "curate_write", "review"],
  };
}

class RecordingOutput implements OutputPlugin {
  readonly deliverySemantics = "idempotent-by-key" as const;

  readonly manifest: PluginManifest = {
    id: "recording-output",
    name: "Recording Output",
    version: "0.0.0",
    kind: "output",
    coreCompatibility: ">=0.0.0",
  };

  readonly calls: DeliveryContext[] = [];

  constructor(private failuresRemaining = 0) {}

  async deliver(_artifact: RenderedArtifact, context: DeliveryContext): Promise<DeliveryReceipt> {
    this.calls.push(context);

    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("delivery unavailable");
    }

    return {
      deliveryId: context.deliveryKey,
      target: ".artifacts/test.md",
      deliveredAt: "2026-08-04T00:00:00.000Z",
    };
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}
