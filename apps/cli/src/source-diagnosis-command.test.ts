import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createSourceDiagnosisReport,
  diagnoseSourceExitCode,
  diagnoseSources,
  parseDiagnoseSourceArgs,
  parseSourceDiagnosisFixture,
} from "./source-diagnosis-command.js";

const MIXED_FIXTURE = fileURLToPath(
  new URL("../../../fixtures/source-diagnosis/mixed.json", import.meta.url),
);
const ALTERNATE_DATE_FIXTURE = fileURLToPath(
  new URL("../../../fixtures/source-diagnosis/alternate-dates.json", import.meta.url),
);

describe("source diagnosis command", () => {
  it("requires one local fixture and accepts strict mode", () => {
    expect(parseDiagnoseSourceArgs(["--fixture", "feeds.json"])).toEqual({
      fixturePath: "feeds.json",
      strict: false,
    });
    expect(parseDiagnoseSourceArgs(["--strict", "--fixture", "feeds.json"])).toEqual({
      fixturePath: "feeds.json",
      strict: true,
    });
    expect(() => parseDiagnoseSourceArgs([])).toThrow("does not fetch remote feeds");
    expect(() => parseDiagnoseSourceArgs(["--fixture"])).toThrow("--fixture requires a path");
    expect(() => parseDiagnoseSourceArgs(["--days", "7"])).toThrow("Unknown diagnose-sources");
  });

  it("rejects fixture fields the current collector would ignore", () => {
    expect(() =>
      parseSourceDiagnosisFixture(
        JSON.stringify({
          feeds: [
            {
              id: "dates",
              url: "https://dates.invalid/feed",
              feed: {
                items: [
                  {
                    title: "Author only",
                    link: "https://dates.invalid/item",
                    author: "Wire Desk",
                  },
                ],
              },
            },
          ],
        }),
      ),
    ).toThrow("unknown field author");
    expect(() =>
      parseSourceDiagnosisFixture(
        JSON.stringify({
          feeds: [
            {
              id: "both",
              url: "https://both.invalid/feed",
              error: "down",
              feed: { items: [] },
            },
          ],
        }),
      ),
    ).toThrow("exactly one of error or feed");
    expect(() => parseSourceDiagnosisFixture("{")).toThrow("must be JSON");
    expect(() => parseSourceDiagnosisFixture(JSON.stringify({ feeds: [] }))).toThrow(
      "1 to 16 entries",
    );
  });

  it("classifies the committed fixture without using configured feed URLs", async () => {
    const previousFeeds = process.env.RSS_FEED_URLS;
    process.env.RSS_FEED_URLS = "https://not-used.example/feed";
    const startedAt = Date.now();

    try {
      const fixture = parseSourceDiagnosisFixture(await readFile(MIXED_FIXTURE, "utf8"));
      const report = await createSourceDiagnosisReport(fixture);

      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(report.feeds.map((feed) => [feed.sourceId, feed.outcome])).toEqual([
        ["open-wire", "available"],
        ["quiet-wire", "empty"],
        ["filtered-wire", "filtered"],
        ["future-wire", "filtered"],
        ["down-wire", "request_failed"],
      ]);
      expect(report.feeds[0]).toMatchObject({
        received: 2,
        normalized: 2,
        fresh: 1,
        dropped: { invalid: 0, stale: 1, future: 0 },
      });
      expect(report.feeds[2]).toMatchObject({
        received: 2,
        normalized: 1,
        fresh: 0,
        dropped: { invalid: 1, stale: 1, future: 0 },
      });
      expect(report.feeds[3]?.dropped).toEqual({ invalid: 0, stale: 0, future: 1 });
      expect(report.feeds[4]?.error).toEqual({ name: "Error", message: "Status code 404" });
      expect(report.summary).toEqual({
        feedCount: 5,
        available: 1,
        empty: 1,
        filtered: 2,
        requestFailed: 1,
        freshItems: 1,
        dedupedFreshItems: 1,
      });
      expect(JSON.stringify(report)).not.toContain("not-used.example");
      expect(JSON.stringify(report)).not.toContain("WEBHOOK");
      expect(diagnoseSourceExitCode(report, false)).toBe(0);
      expect(diagnoseSourceExitCode(report, true)).toBe(1);
    } finally {
      if (previousFeeds === undefined) {
        delete process.env.RSS_FEED_URLS;
      } else {
        process.env.RSS_FEED_URLS = previousFeeds;
      }
    }
  });

  it("classifies alternate date fields from a local fixture", async () => {
    const fixture = parseSourceDiagnosisFixture(await readFile(ALTERNATE_DATE_FIXTURE, "utf8"));
    const report = await createSourceDiagnosisReport(fixture);

    expect(report.feeds.map((feed) => [feed.sourceId, feed.outcome])).toEqual([
      ["published-wire", "available"],
      ["window-wire", "available"],
      ["invalid-wire", "filtered"],
    ]);
    expect(report.feeds[0]).toMatchObject({
      received: 2,
      normalized: 2,
      fresh: 2,
      dropped: { invalid: 0, stale: 0, future: 0 },
      error: null,
    });
    expect(report.feeds[1]).toMatchObject({
      received: 4,
      normalized: 4,
      fresh: 1,
      dropped: { invalid: 0, stale: 1, future: 2 },
      error: null,
    });
    expect(report.feeds[2]).toMatchObject({
      received: 1,
      normalized: 0,
      fresh: 0,
      dropped: { invalid: 1, stale: 0, future: 0 },
      error: null,
    });
    expect(report.summary).toEqual({
      feedCount: 3,
      available: 2,
      empty: 0,
      filtered: 1,
      requestFailed: 0,
      freshItems: 3,
      dedupedFreshItems: 3,
    });
  });

  it("does not fetch when the fixture path cannot be read", async () => {
    await expect(
      diagnoseSources(["--fixture", "fixtures/source-diagnosis/missing.json"]),
    ).rejects.toThrow("Cannot read source diagnosis fixture");
  });

  it("prints the report and exits 1 only in strict mode when a feed is not available", async () => {
    const writes: string[] = [];
    const originalWrite = process.stdout.write;
    const originalExitCode = process.exitCode;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await diagnoseSources(["--fixture", MIXED_FIXTURE]);
      expect(process.exitCode).toBe(originalExitCode);
      expect(JSON.parse(writes.join(""))).toMatchObject({
        summary: { available: 1, feedCount: 5 },
      });

      writes.length = 0;
      await diagnoseSources(["--fixture", MIXED_FIXTURE, "--strict"]);
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(writes.join(""))).toMatchObject({
        summary: { requestFailed: 1, empty: 1, filtered: 2 },
      });
    } finally {
      process.stdout.write = originalWrite;
      process.exitCode = originalExitCode;
    }
  });
});
