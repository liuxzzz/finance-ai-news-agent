#!/usr/bin/env node

import { runDemo } from "./demo.js";
import { migrateDatabase, runPersistentFixture, showRunStatus } from "./runtime-command.js";

const command = process.argv[2] ?? "help";

try {
  if (command === "demo") {
    await runDemo();
  } else if (command === "migrate") {
    await migrateDatabase();
  } else if (command === "run") {
    await runPersistentFixture(process.argv.slice(3));
  } else if (command === "status") {
    await showRunStatus(process.argv[3]);
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
      "  finance-ai-news-agent status <run-id>      Inspect a persisted run",
      "",
      "Run options:",
      "  --tenant <id>              Default: default",
      "  --report-date <YYYY-MM-DD> Default: today in AGENT_TIMEZONE",
      "  --edition <name>           Default: daily",
      "  --topic <topic>            Default: Finance & AI",
      "  --max-revisions <count>    Default: 1",
      "  --dry-run                  Persist the artifact without delivery",
      "",
    ].join("\n"),
  );
}
