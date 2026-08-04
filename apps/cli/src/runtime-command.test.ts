import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePersistentOutputPath } from "./runtime-command.js";

describe("persistent runtime output path", () => {
  it("isolates artifacts from tenants sharing a report date and edition", () => {
    const first = resolvePersistentOutputPath(
      "/workspace",
      ".artifacts",
      "tenant-a",
      "2026-08-04",
      "daily",
    );
    const second = resolvePersistentOutputPath(
      "/workspace",
      ".artifacts",
      "tenant-b",
      "2026-08-04",
      "daily",
    );

    expect(first).toBe(resolve("/workspace/.artifacts/tenant-a/2026-08-04-daily.md"));
    expect(second).toBe(resolve("/workspace/.artifacts/tenant-b/2026-08-04-daily.md"));
    expect(first).not.toBe(second);
  });
});
