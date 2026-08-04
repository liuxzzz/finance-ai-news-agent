import { resolve } from "node:path";

import { createAgentGraph, LangGraphAgentWorkflow, RunExecutor } from "@finance-ai-news-agent/core";
import { FileOutputPlugin } from "@finance-ai-news-agent/output-file";
import {
  createPostgresCheckpointer,
  createPostgresPool,
  PostgresRuntimeStore,
  runPostgresMigrations,
} from "@finance-ai-news-agent/storage-postgres";

import { renderDemoDigest } from "./demo.js";
import { fixtureHandlers } from "./fixture-handlers.js";

export async function migrateDatabase(): Promise<void> {
  const pool = createPostgresPool({ connectionString: requireDatabaseUrl() });

  try {
    await runPostgresMigrations(pool, {
      migrationsDirectory: resolve(projectRoot(), "db/migrations"),
    });
    process.stdout.write("Database migrations completed.\n");
  } finally {
    await pool.end();
  }
}

export async function runPersistentFixture(args: string[]): Promise<void> {
  const options = parseRunOptions(args);
  const pool = createPostgresPool({ connectionString: requireDatabaseUrl() });

  try {
    const checkpointer = await createPostgresCheckpointer(pool);
    const store = new PostgresRuntimeStore(pool);
    const graph = createAgentGraph(fixtureHandlers, { checkpointer });
    const outputPath = resolvePersistentOutputPath(
      projectRoot(),
      process.env.AGENT_OUTPUT_DIR ?? ".artifacts",
      options.tenantId,
      options.reportDate,
      options.edition,
    );
    const output = new FileOutputPlugin(outputPath);
    const runtime = new RunExecutor({
      store,
      workflow: new LangGraphAgentWorkflow(graph),
      renderArtifact: (state, run) => ({
        mediaType: "text/markdown",
        content: renderDemoDigest(state, run),
      }),
      output,
      deliveryTarget: outputPath,
    });
    const result = await runtime.execute({
      tenantId: options.tenantId,
      reportDate: options.reportDate,
      edition: options.edition,
      topic: options.topic,
      maxRevisions: options.maxRevisions,
      dryRun: options.dryRun,
      configSnapshot: {
        timezone: options.timezone,
        fixture: true,
      },
      promptVersions: { fixture: "v1" },
      modelSnapshot: { provider: "fixture" },
    });

    process.stdout.write(
      [
        `Run: ${result.run.id}`,
        `Status: ${result.run.status}`,
        `Disposition: ${result.disposition}`,
        `Attempts: ${result.run.attemptCount}`,
        `Artifact: ${result.artifact?.id ?? "none"}`,
        `Delivery: ${result.delivery?.status ?? (options.dryRun ? "skipped" : "none")}`,
        "",
      ].join("\n"),
    );
  } finally {
    await pool.end();
  }
}

export async function showRunStatus(
  runId: string | undefined,
  options: { json?: boolean } = {},
): Promise<void> {
  if (runId === undefined || runId.trim().length === 0) {
    throw new Error("Usage: finance-ai-news-agent status <run-id>");
  }

  const pool = createPostgresPool({ connectionString: requireDatabaseUrl() });

  try {
    const store = new PostgresRuntimeStore(pool);
    const run = await store.getRun(runId);

    if (run === null) {
      throw new Error(`Run ${runId} was not found.`);
    }

    const [stages, deliveries, modelCalls, sourceRuns, rawSourceItems, normalizedContentItems] =
      await Promise.all([
        store.listStages(run.id),
        store.listDeliveries(run.id),
        store.listModelCalls(run.id),
        store.listSourceRuns(run.id),
        store.listRawSourceItems(run.id),
        store.listNormalizedContentItems(run.id),
      ]);
    const detail = {
      run,
      stages,
      sourceRuns,
      rawSourceItems,
      normalizedContentItems,
      modelCalls,
      deliveries,
    };

    if (options.json) {
      process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
      return;
    }

    const sourceCounts = new Map<string, number>();

    for (const item of normalizedContentItems) {
      const source = item.source ?? item.sourceId ?? "unknown";
      sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
    }

    process.stdout.write(
      [
        `Run: ${run.id}`,
        `Status: ${run.status}`,
        `Identity: ${run.tenantId}/${run.reportDate}/${run.edition}`,
        `Attempts: ${run.attemptCount}`,
        `Stages: ${stages.map((stage) => `${stage.stage}#${stage.attempt}:${stage.status}`).join(", ") || "none"}`,
        `Sources: ${sourceRuns.map((source) => `${source.sourceId}:${source.status}`).join(", ") || "none"}`,
        `Raw items: ${rawSourceItems.length}`,
        `Normalized evidence: ${normalizedContentItems.length}`,
        `Evidence by source: ${[...sourceCounts.entries()].map(([source, count]) => `${source}=${count}`).join(", ") || "none"}`,
        `Model calls: ${modelCalls.length}`,
        `Model tokens: ${modelCalls.reduce((total, call) => total + call.totalTokens, 0)}`,
        `Deliveries: ${deliveries.map((delivery) => `${delivery.pluginId}:${delivery.status}#${delivery.attempt}`).join(", ") || "none"}`,
        "",
      ].join("\n"),
    );
  } finally {
    await pool.end();
  }
}

export interface RunCommandOptions {
  tenantId: string;
  reportDate: string;
  edition: string;
  topic: string;
  maxRevisions: number;
  timezone: string;
  dryRun: boolean;
}

export interface RunOptionDefaults {
  edition?: string;
}

export function parseRunOptions(
  args: string[],
  defaults: RunOptionDefaults = {},
): RunCommandOptions {
  const timezone = process.env.AGENT_TIMEZONE ?? "Asia/Shanghai";
  const values = new Map<string, string>();
  const valueOptions = new Set([
    "--tenant",
    "--report-date",
    "--edition",
    "--topic",
    "--max-revisions",
  ]);
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--") {
      continue;
    }

    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (argument === undefined || !argument.startsWith("--")) {
      throw new Error(`Unknown run argument: ${argument ?? ""}`);
    }

    if (!valueOptions.has(argument)) {
      throw new Error(`Unknown run option: ${argument}.`);
    }

    const value = args[index + 1];

    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}.`);
    }

    values.set(argument, value);
    index += 1;
  }

  const maxRevisionsText = values.get("--max-revisions") ?? "1";
  const maxRevisions = Number(maxRevisionsText);

  if (!/^\d+$/.test(maxRevisionsText) || !Number.isSafeInteger(maxRevisions)) {
    throw new Error("--max-revisions must be a non-negative integer.");
  }

  return {
    tenantId: values.get("--tenant") ?? "default",
    reportDate: values.get("--report-date") ?? currentDateInTimezone(timezone),
    edition: values.get("--edition") ?? defaults.edition ?? "daily",
    topic: values.get("--topic") ?? "Finance & AI",
    maxRevisions,
    timezone,
    dryRun,
  };
}

function currentDateInTimezone(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Could not resolve the current date in timezone ${timezone}.`);
  }

  return `${year}-${month}-${day}`;
}

export function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error(
      "DATABASE_URL is required for migrate, run, run-ai, run-live, and status commands.",
    );
  }

  return databaseUrl;
}

export function projectRoot(): string {
  return resolve(process.env.INIT_CWD ?? process.cwd());
}

export function resolvePersistentOutputPath(
  root: string,
  outputDirectory: string,
  tenantId: string,
  reportDate: string,
  edition: string,
): string {
  return resolve(
    root,
    outputDirectory,
    safeFilePart(tenantId),
    `${safeFilePart(reportDate)}-${safeFilePart(edition)}.md`,
  );
}

function safeFilePart(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
}
