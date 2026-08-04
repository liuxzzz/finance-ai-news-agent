import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { FeishuWebhookOutputPlugin } from "@finance-ai-news-agent/output-feishu";
import { createPostgresPool } from "@finance-ai-news-agent/storage-postgres";

import { resolveLiveResearchConfig, resolveOutputChannel } from "./live-runtime-command.js";
import { projectRoot, requireDatabaseUrl } from "./runtime-command.js";

const MIGRATION_FILE_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;

export async function showOperationalHealth(): Promise<void> {
  const pool = createPostgresPool({ connectionString: requireDatabaseUrl() });

  try {
    await pool.query("SELECT 1 AS healthy");
    const applied = await pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version ASC",
    );
    const expected = (await readdir(resolve(projectRoot(), "db/migrations")))
      .filter((file) => MIGRATION_FILE_PATTERN.test(file))
      .sort();
    const appliedVersions = applied.rows.map((row) => row.version);
    const migrationsCurrent = JSON.stringify(appliedVersions) === JSON.stringify(expected);
    const rss = resolveLiveResearchConfig(process.env);
    const outputChannel = resolveOutputChannel(process.env);
    const modelConfigured = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
    const deliveryConfigured =
      outputChannel === "file" || Boolean(process.env.FEISHU_BOT_WEBHOOK_URL?.trim());
    const ready = migrationsCurrent && modelConfigured && deliveryConfigured;

    process.stdout.write(
      [
        `Database: healthy`,
        `Migrations: ${migrationsCurrent ? "current" : "out-of-date"} (${appliedVersions.length}/${expected.length})`,
        `DeepSeek: ${modelConfigured ? "configured" : "missing"}`,
        `RSS feeds: ${rss.feedUrls.length}`,
        `Output: ${outputChannel} (${deliveryConfigured ? "configured" : "missing"})`,
        `Ready: ${ready ? "yes" : "no"}`,
        "",
      ].join("\n"),
    );

    if (!ready) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

export async function showOperationalMetrics(args: string[]): Promise<void> {
  const days = parseMetricsDays(args);
  const pool = createPostgresPool({ connectionString: requireDatabaseUrl() });

  try {
    const [runs, model, sources, deliveries] = await Promise.all([
      pool.query<{ status: string; count: number; average_duration_seconds: number | null }>(
        `
          SELECT
            status,
            count(*)::integer AS count,
            avg(EXTRACT(EPOCH FROM (finished_at - started_at)))::double precision
              AS average_duration_seconds
          FROM runs
          WHERE created_at >= now() - ($1::integer * interval '1 day')
          GROUP BY status
          ORDER BY status
        `,
        [days],
      ),
      pool.query<{ requests: number; tokens: number }>(
        `
          SELECT
            count(*)::integer AS requests,
            coalesce(sum(total_tokens), 0)::integer AS tokens
          FROM model_calls
          WHERE created_at >= now() - ($1::integer * interval '1 day')
        `,
        [days],
      ),
      pool.query<{ status: string; calls: number; items: number }>(
        `
          SELECT
            status,
            count(*)::integer AS calls,
            coalesce(sum(item_count), 0)::integer AS items
          FROM source_runs
          WHERE created_at >= now() - ($1::integer * interval '1 day')
          GROUP BY status
          ORDER BY status
        `,
        [days],
      ),
      pool.query<{ status: string; count: number }>(
        `
          SELECT status, count(*)::integer AS count
          FROM deliveries
          WHERE created_at >= now() - ($1::integer * interval '1 day')
          GROUP BY status
          ORDER BY status
        `,
        [days],
      ),
    ]);

    process.stdout.write(
      `${JSON.stringify(
        {
          windowDays: days,
          runs: runs.rows,
          model: model.rows[0] ?? { requests: 0, tokens: 0 },
          sources: sources.rows,
          deliveries: deliveries.rows,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await pool.end();
  }
}

export async function notifyScheduledFailure(args: string[]): Promise<void> {
  const edition = optionValue(args, "--edition") ?? "daily";
  const webhookUrl = process.env.FEISHU_BOT_WEBHOOK_URL?.trim();

  if (webhookUrl === undefined || webhookUrl.length === 0) {
    throw new Error("Cannot send a scheduler alert without FEISHU_BOT_WEBHOOK_URL.");
  }

  const timezone = process.env.AGENT_TIMEZONE ?? "Asia/Shanghai";
  const reportDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const output = new FeishuWebhookOutputPlugin({
    webhookUrl,
    ...(process.env.FEISHU_BOT_SIGNING_SECRET === undefined
      ? {}
      : { signingSecret: process.env.FEISHU_BOT_SIGNING_SECRET }),
  });
  const deliveryKey = createHash("sha256")
    .update(`scheduled-failure\u0000${reportDate}\u0000${edition}`)
    .digest("hex");

  await output.deliver(
    {
      id: `scheduled-failure:${reportDate}:${edition}`,
      mediaType: "text/plain",
      content: renderScheduledFailureAlert(reportDate, edition),
    },
    { deliveryKey },
  );
  process.stdout.write("Scheduler failure alert sent to Feishu.\n");
}

export function renderScheduledFailureAlert(reportDate: string, edition: string): string {
  return [
    "每日简报任务失败",
    "",
    `日期：${reportDate}`,
    `版本：${edition}`,
    "自动重试次数已耗尽，本期没有发送新闻简报。",
    "请检查 scheduler.stderr.log，并运行 pnpm health。",
  ].join("\n");
}

export function parseMetricsDays(args: string[]): number {
  const index = args.indexOf("--days");
  const text = index === -1 ? "7" : args[index + 1];

  if (text === undefined || !/^\d+$/.test(text)) {
    throw new Error("--days requires an integer from 1 to 90.");
  }

  const days = Number(text);

  if (!Number.isSafeInteger(days) || days < 1 || days > 90) {
    throw new Error("--days requires an integer from 1 to 90.");
  }

  return days;
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);

  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1]?.trim();

  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }

  return value;
}
