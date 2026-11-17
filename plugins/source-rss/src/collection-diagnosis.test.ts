import { describe, expect, it } from "vitest";

import type {
  RawSourceItemRecord,
  RecordSourceCollectionInput,
  SourceAuditStore,
  SourceRunRecord,
} from "@finance-ai-news-agent/plugin-sdk";

import { rssFeedDiagnosis } from "./collection-diagnosis.js";
import { RssNewsGateway } from "./index.js";

const FEED_NOW = Date.parse("2026-08-04T12:00:00.000Z");
const EARLIEST = Date.parse("2026-08-02T12:00:00.000Z");
const LATEST = Date.parse("2026-08-04T15:00:00.000Z");

describe("RSS collection diagnosis", () => {
  it("separates an empty feed, a failed request, and filtered items", async () => {
    const audit = new RecordingSourceAudit();
    const gateway = new RssNewsGateway({
      feeds: [
        { id: "open", name: "Open", url: "https://open.invalid/feed" },
        { id: "quiet", url: "https://quiet.invalid/feed" },
        { id: "invalid", url: "https://invalid.invalid/feed" },
        { id: "stale", url: "https://stale.invalid/feed" },
        { id: "future", url: "https://future.invalid/feed" },
        { id: "down", url: "https://down.invalid/feed" },
      ],
      now: () => FEED_NOW,
      maxItemAgeHours: 48,
      generateId: sequentialIds(),
      sourceAudit: audit,
      parseFeed: async (url) => {
        if (url.includes("quiet")) {
          return { title: "Quiet", items: [] };
        }

        if (url.includes("invalid.invalid")) {
          return {
            items: [
              { title: "No date", link: "https://invalid.invalid/nodate" },
              { link: "https://invalid.invalid/notitle", isoDate: "2026-08-04T09:00:00.000Z" },
              { title: "No url", isoDate: "2026-08-04T09:00:00.000Z" },
            ],
          };
        }

        if (url.includes("stale")) {
          return {
            items: [article("Old", "https://stale.invalid/old", "2026-07-01T00:00:00.000Z")],
          };
        }

        if (url.includes("future")) {
          return {
            items: [article("Ahead", "https://future.invalid/ahead", "2099-01-01T00:00:00.000Z")],
          };
        }

        if (url.includes("down")) {
          throw new Error("Status code 404");
        }

        return {
          title: "Open",
          items: [
            article("Fresh", "https://open.invalid/fresh", "2026-08-04T09:00:00.000Z"),
            article("Also old", "https://open.invalid/old", "2026-07-01T00:00:00.000Z"),
          ],
        };
      },
    });

    const report = await gateway.diagnose({ runId: "run-diagnosis" });
    const result = await gateway.callTool(
      { id: "search", name: "search_news", arguments: { query: "unmatched", limit: 10 } },
      { runId: "run-diagnosis" },
    );

    expect(report).toEqual({
      feeds: [
        expect.objectContaining({
          sourceId: "open",
          outcome: "available",
          received: 2,
          normalized: 2,
          fresh: 1,
          dropped: { invalid: 0, stale: 1, future: 0 },
          error: null,
        }),
        expect.objectContaining({
          sourceId: "quiet",
          outcome: "empty",
          received: 0,
          normalized: 0,
          fresh: 0,
          dropped: { invalid: 0, stale: 0, future: 0 },
          error: null,
        }),
        expect.objectContaining({
          sourceId: "invalid",
          outcome: "filtered",
          received: 3,
          normalized: 0,
          fresh: 0,
          dropped: { invalid: 3, stale: 0, future: 0 },
          error: null,
        }),
        expect.objectContaining({
          sourceId: "stale",
          outcome: "filtered",
          received: 1,
          normalized: 1,
          fresh: 0,
          dropped: { invalid: 0, stale: 1, future: 0 },
          error: null,
        }),
        expect.objectContaining({
          sourceId: "future",
          outcome: "filtered",
          received: 1,
          normalized: 1,
          fresh: 0,
          dropped: { invalid: 0, stale: 0, future: 1 },
          error: null,
        }),
        expect.objectContaining({
          sourceId: "down",
          outcome: "request_failed",
          received: 0,
          normalized: 0,
          fresh: 0,
          dropped: { invalid: 0, stale: 0, future: 0 },
          error: { name: "Error", message: "Status code 404" },
        }),
      ],
      summary: {
        feedCount: 6,
        available: 1,
        empty: 1,
        filtered: 3,
        requestFailed: 1,
        freshItems: 1,
        dedupedFreshItems: 1,
      },
    });
    expect(result).toEqual({
      content: {
        items: [expect.objectContaining({ title: "Fresh", sourceId: "open" })],
      },
      isError: false,
    });
    expect(audit.collections).toEqual([
      expect.objectContaining({
        sourceId: "open",
        status: "succeeded",
        itemCount: 2,
        error: null,
        disposition: {
          outcome: "available",
          received: 2,
          normalized: 2,
          fresh: 1,
          dropped: { invalid: 0, stale: 1, future: 0 },
        },
      }),
      expect.objectContaining({
        sourceId: "quiet",
        status: "succeeded",
        itemCount: 0,
        disposition: expect.objectContaining({ outcome: "empty", received: 0 }),
      }),
      expect.objectContaining({
        sourceId: "invalid",
        status: "succeeded",
        itemCount: 0,
        items: [],
        disposition: expect.objectContaining({
          outcome: "filtered",
          received: 3,
          normalized: 0,
        }),
      }),
      expect.objectContaining({
        sourceId: "stale",
        status: "succeeded",
        itemCount: 1,
        disposition: expect.objectContaining({ outcome: "filtered", fresh: 0 }),
      }),
      expect.objectContaining({
        sourceId: "future",
        status: "succeeded",
        itemCount: 1,
        disposition: expect.objectContaining({ outcome: "filtered", fresh: 0 }),
      }),
      expect.objectContaining({
        sourceId: "down",
        status: "failed",
        itemCount: 0,
        items: [],
        error: expect.objectContaining({ message: "Status code 404" }),
        disposition: expect.objectContaining({ outcome: "request_failed" }),
      }),
    ]);
    expect(audit.collections).toHaveLength(6);
  });

  it("keeps items on the inclusive age-window boundaries", async () => {
    const gateway = new RssNewsGateway({
      feeds: [{ id: "edges", url: "https://edges.invalid/feed" }],
      now: () => FEED_NOW,
      maxItemAgeHours: 48,
      parseFeed: async () => ({
        items: [
          article("Earliest", "https://edges.invalid/earliest", new Date(EARLIEST).toISOString()),
          article(
            "Just stale",
            "https://edges.invalid/stale",
            new Date(EARLIEST - 1).toISOString(),
          ),
          article("Latest", "https://edges.invalid/latest", new Date(LATEST).toISOString()),
          article(
            "Just future",
            "https://edges.invalid/future",
            new Date(LATEST + 1).toISOString(),
          ),
        ],
      }),
    });

    const report = await gateway.diagnose();

    expect(report.feeds[0]).toEqual(
      expect.objectContaining({
        outcome: "available",
        received: 4,
        normalized: 4,
        fresh: 2,
        dropped: { invalid: 0, stale: 1, future: 1 },
      }),
    );
    expect(report.summary.dedupedFreshItems).toBe(2);
  });

  it("does not reclassify a duplicate URL as filtered", async () => {
    const gateway = new RssNewsGateway({
      feeds: [
        { id: "left", url: "https://left.invalid/feed" },
        { id: "right", url: "https://right.invalid/feed" },
      ],
      now: () => FEED_NOW,
      parseFeed: async (url) => ({
        items: [
          article(
            url.includes("left") ? "Left copy" : "Right copy",
            "https://shared.invalid/story",
            url.includes("left") ? "2026-08-04T10:00:00.000Z" : "2026-08-04T08:00:00.000Z",
          ),
        ],
      }),
    });

    const report = await gateway.diagnose();
    const result = await gateway.callTool({
      id: "dedupe",
      name: "search_news",
      arguments: { query: "copy", limit: 5 },
    });

    expect(report.feeds.map((feed) => feed.outcome)).toEqual(["available", "available"]);
    expect(report.summary).toMatchObject({ freshItems: 2, dedupedFreshItems: 1 });
    expect(result).toEqual({
      content: {
        items: [expect.objectContaining({ title: "Left copy", sourceId: "left" })],
      },
      isError: false,
    });
  });

  it("records one succeeded diagnosis after a transient retry", async () => {
    let attempts = 0;
    const audit = new RecordingSourceAudit();
    const gateway = new RssNewsGateway({
      feeds: [{ id: "flaky", url: "https://flaky.invalid/feed" }],
      now: () => FEED_NOW,
      generateId: sequentialIds(),
      sourceAudit: audit,
      sleep: async () => undefined,
      parseFeed: async () => {
        attempts += 1;

        if (attempts === 1) {
          throw new Error("Status code 503");
        }

        return {
          items: [article("Recovered", "https://flaky.invalid/item", "2026-08-04T09:00:00.000Z")],
        };
      },
    });

    const report = await gateway.diagnose({ runId: "run-retry" });

    expect(attempts).toBe(2);
    expect(report.feeds).toEqual([
      expect.objectContaining({ sourceId: "flaky", outcome: "available", fresh: 1, error: null }),
    ]);
    expect(audit.collections).toHaveLength(1);
    expect(audit.collections[0]).toEqual(
      expect.objectContaining({ status: "succeeded", itemCount: 1 }),
    );
  });

  it("returns a report when every feed fails and leaves search_news failed", async () => {
    const gateway = new RssNewsGateway({
      feeds: [
        { id: "left", url: "https://left.invalid/feed" },
        { id: "right", url: "https://right.invalid/feed" },
      ],
      now: () => FEED_NOW,
      sleep: async () => undefined,
      parseFeed: async () => {
        throw new Error("Request timed out after 5000ms");
      },
    });

    const report = await gateway.diagnose();
    const result = await gateway.callTool({
      id: "all-failed",
      name: "search_news",
      arguments: { query: "AI", limit: 5 },
    });

    expect(report.summary).toMatchObject({
      feedCount: 2,
      available: 0,
      requestFailed: 2,
      dedupedFreshItems: 0,
    });
    expect(result).toEqual({
      content: {
        error: "All configured RSS feeds failed: Request timed out after 5000ms",
      },
      isError: true,
    });
  });

  it("rejects a diagnosis whose counts do not balance", () => {
    expect(() =>
      rssFeedDiagnosis({
        sourceId: "broken",
        received: 1,
        normalized: 1,
        fresh: 2,
        invalid: 0,
        stale: 0,
        future: 0,
        error: null,
      }),
    ).toThrow("counts do not balance");
  });
});

class RecordingSourceAudit implements SourceAuditStore {
  readonly collections: RecordSourceCollectionInput[] = [];

  async recordSourceCollection(input: RecordSourceCollectionInput): Promise<SourceRunRecord> {
    this.collections.push(structuredClone(input));
    return {
      ...structuredClone(input),
      attempt: 1,
      createdAt: input.startedAt,
    };
  }

  async listSourceRuns(): Promise<SourceRunRecord[]> {
    return [];
  }

  async listRawSourceItems(): Promise<RawSourceItemRecord[]> {
    return [];
  }
}

function sequentialIds(): () => string {
  let value = 0;
  return () => `diagnosis-${(value += 1)}`;
}

function article(title: string, url: string, isoDate: string) {
  return {
    title,
    link: url,
    isoDate,
    contentSnippet: title,
  };
}
