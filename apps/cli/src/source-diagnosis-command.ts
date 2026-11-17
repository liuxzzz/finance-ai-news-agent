import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { RssNewsGateway, validateRssFeedUrl } from "@finance-ai-news-agent/source-rss";
import type { RssCollectionDiagnosis } from "@finance-ai-news-agent/source-rss";

const FIXTURE_KEYS = new Set(["now", "maxItemAgeHours", "feeds"]);
const FEED_KEYS = new Set(["id", "url", "name", "error", "feed"]);
const PARSED_FEED_KEYS = new Set(["title", "items"]);
const ITEM_FIELDS = [
  "title",
  "link",
  "guid",
  "pubDate",
  "isoDate",
  "contentSnippet",
  "content",
  "summary",
] as const;
const ITEM_KEYS = new Set<string>(ITEM_FIELDS);

interface DiagnosisFixtureItem {
  title?: string;
  link?: string;
  guid?: string;
  pubDate?: string;
  isoDate?: string;
  contentSnippet?: string;
  content?: string;
  summary?: string;
}

interface DiagnosisFixtureParsedFeed {
  title?: string;
  items: DiagnosisFixtureItem[];
}

interface DiagnosisFixtureFeed {
  id: string;
  url: string;
  name?: string;
  error?: string;
  feed?: DiagnosisFixtureParsedFeed;
}

export interface SourceDiagnosisFixture {
  now?: number;
  maxItemAgeHours?: number;
  feeds: DiagnosisFixtureFeed[];
}

export interface DiagnoseSourceOptions {
  fixturePath: string;
  strict: boolean;
}

export function parseDiagnoseSourceArgs(args: string[]): DiagnoseSourceOptions {
  let fixturePath: string | undefined;
  let strict = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--strict") {
      if (strict) {
        throw new Error("--strict was provided more than once.");
      }

      strict = true;
      continue;
    }

    if (arg === "--fixture") {
      const value = args[index + 1];

      if (value === undefined || value.startsWith("--")) {
        throw new Error("--fixture requires a path to a local JSON fixture.");
      }

      if (fixturePath !== undefined) {
        throw new Error("--fixture was provided more than once.");
      }

      fixturePath = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown diagnose-sources argument: ${arg}.`);
  }

  if (fixturePath === undefined) {
    throw new Error("diagnose-sources requires --fixture <file> and does not fetch remote feeds.");
  }

  return { fixturePath, strict };
}

export function diagnoseSourceExitCode(report: RssCollectionDiagnosis, strict: boolean): 0 | 1 {
  if (!strict || report.summary.available === report.summary.feedCount) {
    return 0;
  }

  return 1;
}

export function parseSourceDiagnosisFixture(text: string): SourceDiagnosisFixture {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Source diagnosis fixture must be JSON.");
  }

  if (!isRecord(parsed)) {
    throw new Error("Source diagnosis fixture must be a JSON object.");
  }

  assertOnlyKeys(parsed, FIXTURE_KEYS, "Source diagnosis fixture");
  const now = parsed.now === undefined ? undefined : parseFixtureNow(parsed.now);
  const maxItemAgeHours =
    parsed.maxItemAgeHours === undefined ? undefined : parseFixtureAgeHours(parsed.maxItemAgeHours);

  if (!Array.isArray(parsed.feeds) || parsed.feeds.length < 1 || parsed.feeds.length > 16) {
    throw new Error("Source diagnosis fixture feeds must contain 1 to 16 entries.");
  }

  return {
    ...(now === undefined ? {} : { now }),
    ...(maxItemAgeHours === undefined ? {} : { maxItemAgeHours }),
    feeds: parsed.feeds.map((feed, index) => parseFixtureFeed(feed, index)),
  };
}

export async function loadSourceDiagnosisFixture(
  fixturePath: string,
): Promise<SourceDiagnosisFixture> {
  const path = resolve(fixturePath);
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read source diagnosis fixture ${path}: ${message}`, { cause: error });
  }

  return parseSourceDiagnosisFixture(text);
}

export async function createSourceDiagnosisReport(
  fixture: SourceDiagnosisFixture,
): Promise<RssCollectionDiagnosis> {
  const stubs = new Map<string, DiagnosisFixtureFeed>();

  for (const feed of fixture.feeds) {
    stubs.set(validateRssFeedUrl(feed.url).toString(), feed);
  }

  const now = fixture.now;
  const gateway = new RssNewsGateway({
    feeds: fixture.feeds.map((feed) => ({
      id: feed.id,
      url: feed.url,
      ...(feed.name === undefined ? {} : { name: feed.name }),
    })),
    ...(fixture.maxItemAgeHours === undefined ? {} : { maxItemAgeHours: fixture.maxItemAgeHours }),
    ...(now === undefined ? {} : { now: () => now }),
    parseFeed: async (url) => {
      const feed = stubs.get(url);

      if (feed === undefined) {
        throw new Error("Source diagnosis fixture is missing a stub for a configured feed.");
      }

      if (feed.error !== undefined) {
        throw new Error(feed.error);
      }

      return {
        ...(feed.feed?.title === undefined ? {} : { title: feed.feed.title }),
        items: feed.feed?.items.map((item) => ({ ...item })) ?? [],
      };
    },
  });

  return gateway.diagnose();
}

export async function diagnoseSources(args: string[]): Promise<void> {
  const options = parseDiagnoseSourceArgs(args);
  const fixture = await loadSourceDiagnosisFixture(options.fixturePath);
  const report = await createSourceDiagnosisReport(fixture);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const exitCode = diagnoseSourceExitCode(report, options.strict);

  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

function parseFixtureFeed(value: unknown, index: number): DiagnosisFixtureFeed {
  const label = `Source diagnosis fixture feed[${index}]`;

  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }

  assertOnlyKeys(value, FEED_KEYS, label);
  const id = requiredString(value.id, `${label} id`);
  const url = requiredString(value.url, `${label} url`);
  const name = value.name === undefined ? undefined : requiredString(value.name, `${label} name`);
  const hasError = value.error !== undefined;
  const hasFeed = value.feed !== undefined;

  if (hasError === hasFeed) {
    throw new Error(`${label} must set exactly one of error or feed.`);
  }

  if (hasError) {
    return {
      id,
      url,
      ...(name === undefined ? {} : { name }),
      error: requiredString(value.error, `${label} error`),
    };
  }

  return {
    id,
    url,
    ...(name === undefined ? {} : { name }),
    feed: parseParsedFeed(value.feed, `${label} ${id}`),
  };
}

function parseParsedFeed(value: unknown, label: string): DiagnosisFixtureParsedFeed {
  if (!isRecord(value)) {
    throw new Error(`${label} feed must be an object.`);
  }

  assertOnlyKeys(value, PARSED_FEED_KEYS, `${label} feed`);

  if (!Array.isArray(value.items)) {
    throw new Error(`${label} feed items must be an array.`);
  }

  const title =
    value.title === undefined ? undefined : requireString(value.title, `${label} feed title`);

  return {
    ...(title === undefined ? {} : { title }),
    items: value.items.map((item, index) => parseFixtureItem(item, label, index)),
  };
}

function parseFixtureItem(value: unknown, feedLabel: string, index: number): DiagnosisFixtureItem {
  const label = `${feedLabel} item[${index}]`;

  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }

  assertOnlyKeys(value, ITEM_KEYS, label);
  const item: DiagnosisFixtureItem = {};

  for (const key of ITEM_FIELDS) {
    if (value[key] !== undefined) {
      item[key] = requireString(value[key], `${label} ${key}`);
    }
  }

  return item;
}

function parseFixtureNow(value: unknown): number {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("Source diagnosis fixture now must be an ISO-8601 timestamp.");
  }

  return Date.parse(value);
}

function parseFixtureAgeHours(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("Source diagnosis fixture maxItemAgeHours must be a positive number.");
  }

  return value;
}

function requiredString(value: unknown, label: string): string {
  const text = requireString(value, label);

  if (text.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return text;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }

  return value;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} has unknown field ${key}.`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
