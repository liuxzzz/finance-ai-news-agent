import type { JsonObject } from "@finance-ai-news-agent/plugin-sdk";

export const RSS_COLLECTION_OUTCOMES = [
  "available",
  "empty",
  "filtered",
  "request_failed",
] as const;

export type RssCollectionOutcome = (typeof RSS_COLLECTION_OUTCOMES)[number];

export interface RssFeedDropCounts {
  /** Items the collector could not normalize (missing title, usable URL, or parseable time). */
  invalid: number;
  /** Normalized items older than the configured age window. */
  stale: number;
  /** Normalized items newer than the allowed clock skew. */
  future: number;
}

export interface RssFeedDiagnosis {
  sourceId: string;
  outcome: RssCollectionOutcome;
  received: number;
  normalized: number;
  fresh: number;
  dropped: RssFeedDropCounts;
  error: { name: string; message: string } | null;
}

export interface RssCollectionDiagnosis {
  feeds: RssFeedDiagnosis[];
  summary: {
    feedCount: number;
    available: number;
    empty: number;
    filtered: number;
    requestFailed: number;
    /** Sum of per-feed fresh items, before cross-feed URL dedupe. */
    freshItems: number;
    /** Fresh items that remain after keeping the newest copy of each URL. */
    dedupedFreshItems: number;
  };
}

export function rssCollectionOutcome(input: {
  failed: boolean;
  received: number;
  fresh: number;
}): RssCollectionOutcome {
  if (input.failed) {
    return "request_failed";
  }

  if (input.received === 0) {
    return "empty";
  }

  if (input.fresh === 0) {
    return "filtered";
  }

  return "available";
}

/**
 * Counts produced by one collector pass. `invalid` stays one bucket so the
 * reason cannot drift from `normalizeItem`, including whichever publication
 * fields that function currently accepts.
 */
export function rssFeedDiagnosis(input: {
  sourceId: string;
  received: number;
  normalized: number;
  fresh: number;
  invalid: number;
  stale: number;
  future: number;
  error: unknown | null;
}): RssFeedDiagnosis {
  const failed = input.error !== null && input.error !== undefined;
  const diagnosis: RssFeedDiagnosis = {
    sourceId: input.sourceId,
    outcome: rssCollectionOutcome({
      failed,
      received: input.received,
      fresh: input.fresh,
    }),
    received: input.received,
    normalized: input.normalized,
    fresh: input.fresh,
    dropped: {
      invalid: input.invalid,
      stale: input.stale,
      future: input.future,
    },
    error: failed ? diagnosisError(input.error) : null,
  };
  assertRssFeedDiagnosis(diagnosis);
  return diagnosis;
}

/** JSON stored on `source_runs.disposition`. The audit `error` column keeps the stack. */
export function collectionDisposition(diagnosis: RssFeedDiagnosis): JsonObject {
  return {
    outcome: diagnosis.outcome,
    received: diagnosis.received,
    normalized: diagnosis.normalized,
    fresh: diagnosis.fresh,
    dropped: {
      invalid: diagnosis.dropped.invalid,
      stale: diagnosis.dropped.stale,
      future: diagnosis.dropped.future,
    },
  };
}

export function summarizeCollectionDiagnosis(
  feeds: readonly RssFeedDiagnosis[],
  dedupedFreshItems: number,
): RssCollectionDiagnosis {
  if (!Number.isSafeInteger(dedupedFreshItems) || dedupedFreshItems < 0) {
    throw new Error("dedupedFreshItems must be a nonnegative integer.");
  }

  const freshItems = feeds.reduce((total, feed) => total + feed.fresh, 0);

  if (dedupedFreshItems > freshItems) {
    throw new Error(
      "RSS collection diagnosis deduped fresh items exceed the per-feed fresh total.",
    );
  }

  return {
    feeds: feeds.map((feed) => ({
      sourceId: feed.sourceId,
      outcome: feed.outcome,
      received: feed.received,
      normalized: feed.normalized,
      fresh: feed.fresh,
      dropped: { ...feed.dropped },
      error: feed.error === null ? null : { ...feed.error },
    })),
    summary: {
      feedCount: feeds.length,
      available: feeds.filter((feed) => feed.outcome === "available").length,
      empty: feeds.filter((feed) => feed.outcome === "empty").length,
      filtered: feeds.filter((feed) => feed.outcome === "filtered").length,
      requestFailed: feeds.filter((feed) => feed.outcome === "request_failed").length,
      freshItems,
      dedupedFreshItems,
    },
  };
}

function assertRssFeedDiagnosis(diagnosis: RssFeedDiagnosis): void {
  const counts = [
    diagnosis.received,
    diagnosis.normalized,
    diagnosis.fresh,
    diagnosis.dropped.invalid,
    diagnosis.dropped.stale,
    diagnosis.dropped.future,
  ];

  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error("RSS feed diagnosis counts must be nonnegative integers.");
  }

  if (diagnosis.outcome === "request_failed") {
    if (diagnosis.error === null || counts.some((count) => count !== 0)) {
      throw new Error("A failed RSS feed diagnosis cannot include received items.");
    }

    return;
  }

  if (diagnosis.error !== null) {
    throw new Error("A successful RSS feed diagnosis cannot include an error.");
  }

  if (
    diagnosis.received !== diagnosis.normalized + diagnosis.dropped.invalid ||
    diagnosis.normalized !== diagnosis.fresh + diagnosis.dropped.stale + diagnosis.dropped.future
  ) {
    throw new Error("RSS feed diagnosis counts do not balance.");
  }

  const expected = rssCollectionOutcome({
    failed: false,
    received: diagnosis.received,
    fresh: diagnosis.fresh,
  });

  if (diagnosis.outcome !== expected) {
    throw new Error("RSS feed diagnosis outcome does not match its counts.");
  }
}

function diagnosisError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }

  return { name: "Error", message: String(error) };
}
