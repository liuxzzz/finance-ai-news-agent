import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { formatSourceRunSummary, resolvePersistentOutputPath } from "./runtime-command.js";

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

describe("source run summary", () => {
  it("appends a collection outcome without changing rows that have none", () => {
    expect(
      formatSourceRunSummary({ sourceId: "sec-press", status: "succeeded", disposition: null }),
    ).toBe("sec-press:succeeded");
    expect(
      formatSourceRunSummary({
        sourceId: "quiet",
        status: "succeeded",
        disposition: { outcome: "empty", received: 0, normalized: 0, fresh: 0 },
      }),
    ).toBe("quiet:succeeded:empty");
    expect(
      formatSourceRunSummary({
        sourceId: "down",
        status: "failed",
        disposition: { outcome: "" },
      }),
    ).toBe("down:failed");
  });
});
