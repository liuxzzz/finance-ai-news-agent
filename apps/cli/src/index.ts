#!/usr/bin/env node

import { runDemo } from "./demo.js";

const command = process.argv[2] ?? "help";

if (command === "demo") {
  await runDemo();
} else {
  process.stdout.write(
    [
      "Finance & AI News Agent",
      "",
      "Usage:",
      "  finance-ai-news-agent demo    Run the offline fixture demo",
      "",
    ].join("\n"),
  );
}
