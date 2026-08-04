#!/usr/bin/env node

import { runPersistentAiReplay } from "./ai-runtime-command.js";
import { runDemo } from "./demo.js";
import { runPersistentAiLive } from "./live-runtime-command.js";
import {
  notifyScheduledFailure,
  showOperationalHealth,
  showOperationalMetrics,
} from "./operations-command.js";
import { migrateDatabase, runPersistentFixture, showRunStatus } from "./runtime-command.js";
import { manageDailySchedule } from "./scheduler-command.js";

const command = process.argv[2] ?? "help";

try {
  if (command === "demo") {
    await runDemo();
  } else if (command === "migrate") {
    await migrateDatabase();
  } else if (command === "run") {
    await runPersistentFixture(process.argv.slice(3));
  } else if (command === "run-ai") {
    await runPersistentAiReplay(process.argv.slice(3));
  } else if (command === "run-live") {
    await runPersistentAiLive(process.argv.slice(3));
  } else if (command === "status") {
    await showRunStatus(process.argv[3], { json: process.argv.slice(4).includes("--json") });
  } else if (command === "schedule") {
    await manageDailySchedule(process.argv.slice(3));
  } else if (command === "health") {
    await showOperationalHealth();
  } else if (command === "metrics") {
    await showOperationalMetrics(process.argv.slice(3));
  } else if (command === "notify-failure") {
    await notifyScheduledFailure(process.argv.slice(3));
  } else {
    printHelp();
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function printHelp(): void {
  process.stdout.write(
    [
      "Finance & AI News Agent",
      "",
      "Usage:",
      "  finance-ai-news-agent demo                 Run the in-memory fixture demo",
      "  finance-ai-news-agent migrate              Apply PostgreSQL migrations",
      "  finance-ai-news-agent run [options]        Run/resume the persistent fixture workflow",
      "  finance-ai-news-agent run-ai [options]     Run/resume DeepSeek with replay evidence",
      "  finance-ai-news-agent run-live [options]   Run/resume DeepSeek with live RSS evidence",
      "  finance-ai-news-agent status <run-id>      Inspect a persisted run (--json for details)",
      "  finance-ai-news-agent schedule <action>    Install, inspect, or remove the daily job",
      "  finance-ai-news-agent health               Check database and production configuration",
      "  finance-ai-news-agent metrics [--days 7]   Show recent operational metrics",
      "",
      "Run options:",
      "  --tenant <id>              Default: default",
      "  --report-date <YYYY-MM-DD> Default: today in AGENT_TIMEZONE",
      "  --edition <name>           Default: daily / ai-replay-v1",
      "  --topic <topic>            Default: Finance & AI",
      "  --max-revisions <count>    Default: 1",
      "  --dry-run                  Persist the artifact without delivery",
      "",
      "Schedule options:",
      "  schedule install [--hour 8] [--minute 0]",
      "  schedule status",
      "  schedule uninstall",
      "",
    ].join("\n"),
  );
}
