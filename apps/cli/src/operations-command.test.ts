import { describe, expect, it } from "vitest";

import { parseMetricsDays, renderScheduledFailureAlert } from "./operations-command.js";

describe("operations commands", () => {
  it("parses a bounded metrics window", () => {
    expect(parseMetricsDays([])).toBe(7);
    expect(parseMetricsDays(["--days", "30"])).toBe(30);
    expect(() => parseMetricsDays(["--days", "0"])).toThrow("integer from 1 to 90");
    expect(() => parseMetricsDays(["--days", "91"])).toThrow("integer from 1 to 90");
  });

  it("renders a concise scheduler failure alert without secrets", () => {
    const message = renderScheduledFailureAlert("2026-08-04", "daily");

    expect(message).toContain("每日简报任务失败");
    expect(message).toContain("2026-08-04");
    expect(message).toContain("daily");
    expect(message).not.toContain("WEBHOOK");
    expect(message).not.toContain("API_KEY");
  });
});
