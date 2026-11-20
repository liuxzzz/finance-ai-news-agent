import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
  LocalStubBriefingModel,
  TopicDesk,
  createStructuredTopicBriefingModel,
  type TopicBriefingExporter,
  type TopicBriefingModel,
} from "@finance-ai-news-agent/core";
import { createDeepSeekModelProvider } from "@finance-ai-news-agent/model-ai-sdk";
import { FileOutputPlugin } from "@finance-ai-news-agent/output-file";
import {
  createPostgresPool,
  PostgresTopicDeskStore,
  runPostgresMigrations,
} from "@finance-ai-news-agent/storage-postgres";

import { DEEPSEEK_THINKING_MODE, resolveDeepSeekRuntimeConfig } from "./ai-runtime-command.js";
import { FINANCE_AI_RSS_CATALOG } from "./rss-feed-catalog.js";
import { projectRoot } from "./runtime-command.js";
import { createRssTopicCollector } from "./topic-desk-collector.js";
import { assertLoopbackHost, startTopicDeskServer } from "./topic-desk-server.js";

export interface TopicDeskRuntime {
  mode: "e2e" | "live";
  model: TopicBriefingModel;
}

export function resolveTopicDeskRuntime(
  environment: Readonly<Record<string, string | undefined>>,
): TopicDeskRuntime {
  const mode = environment.TOPIC_DESK_MODE ?? "e2e";

  if (mode !== "e2e" && mode !== "live") {
    throw new Error("TOPIC_DESK_MODE must be e2e or live.");
  }

  if (mode === "e2e") {
    return { mode, model: new LocalStubBriefingModel(parseStubFailures(environment)) };
  }

  if (environment.TOPIC_DESK_STUB_FAILURES !== undefined) {
    throw new Error("TOPIC_DESK_STUB_FAILURES is only available in e2e mode.");
  }

  if (environment.TOPIC_DESK_ALLOW_LIVE_MODEL !== "1") {
    throw new Error(
      "Live topic desk mode requires TOPIC_DESK_ALLOW_LIVE_MODEL=1. The default e2e mode does not call a paid model or send notifications.",
    );
  }

  const config = resolveDeepSeekRuntimeConfig(environment);
  return {
    mode,
    model: createStructuredTopicBriefingModel(
      createDeepSeekModelProvider({ ...config, thinkingMode: DEEPSEEK_THINKING_MODE }),
    ),
  };
}

export async function serveTopicDesk(args: string[]): Promise<void> {
  const options = parseServeArgs(args);
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required to serve the topic desk.");
  }

  const runtime = resolveTopicDeskRuntime(process.env);
  const pool = createPostgresPool({ connectionString: databaseUrl });
  const exportDirectory = resolve(
    projectRoot(),
    process.env.TOPIC_DESK_EXPORT_DIR ?? ".artifacts/topic-desk",
  );

  try {
    await runPostgresMigrations(pool, {
      migrationsDirectory: resolve(projectRoot(), "db/migrations"),
    });
    const desk = new TopicDesk({
      store: new PostgresTopicDeskStore(pool),
      collector: createRssTopicCollector(),
      model: runtime.model,
      exporter: createFileExporter(exportDirectory),
    });
    const server = await startTopicDeskServer({
      desk,
      catalog: FINANCE_AI_RSS_CATALOG.map((feed) => ({
        id: feed.id,
        name: feed.name,
        url: feed.url,
        topic: feed.topic,
      })),
      mode: runtime.mode,
      modelLabel: runtime.model.label,
      host: options.host,
      port: options.port,
    });
    process.stdout.write(
      [
        `Topic desk: ${server.url}`,
        `Mode: ${runtime.mode}`,
        `Model: ${runtime.model.label}`,
        "Notifications: disabled",
        "Listening on loopback only.",
        "",
      ].join("\n"),
    );
    await new Promise<void>((resolvePromise) => {
      const stop = (): void => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolvePromise();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
    await server.close();
  } finally {
    await pool.end();
  }
}

function createFileExporter(directory: string): TopicBriefingExporter {
  return {
    async exportMarkdown(input) {
      const outputPath = resolve(directory, input.topicId, `${input.runId}.md`);
      await mkdir(resolve(directory, input.topicId), { recursive: true });
      const output = new FileOutputPlugin(outputPath);
      const receipt = await output.deliver({
        id: input.runId,
        mediaType: "text/markdown",
        content: input.markdown,
      });
      return receipt.target;
    },
  };
}

function parseStubFailures(environment: Readonly<Record<string, string | undefined>>): number {
  const text = environment.TOPIC_DESK_STUB_FAILURES ?? "0";

  if (!/^\d+$/.test(text)) {
    throw new Error("TOPIC_DESK_STUB_FAILURES must be a non-negative integer.");
  }

  return Number(text);
}

function parseServeArgs(args: string[]): { host: string; port: number } {
  let host = "127.0.0.1";
  let port = 4173;
  const command = args[0] === "serve" ? args.slice(1) : args;

  for (let index = 0; index < command.length; index += 1) {
    const argument = command[index];

    if (argument === "--host") {
      const value = command[index + 1];

      if (value === undefined) {
        throw new Error("Missing value for --host.");
      }

      host = value;
      index += 1;
      continue;
    }

    if (argument === "--port") {
      const value = command[index + 1];

      if (value === undefined || !/^\d+$/.test(value)) {
        throw new Error("--port must be an integer from 0 to 65535.");
      }

      port = Number(value);

      if (port > 65_535) {
        throw new Error("--port must be an integer from 0 to 65535.");
      }

      index += 1;
      continue;
    }

    throw new Error(`Unknown topic-desk argument: ${argument ?? ""}.`);
  }

  return { host: assertLoopbackHost(host), port };
}
