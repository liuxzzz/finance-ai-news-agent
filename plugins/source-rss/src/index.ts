import { createHash, randomUUID } from "node:crypto";

import type {
  JsonObject,
  SourceAuditStore,
  ToolCall,
  ToolDescriptor,
  ToolExecutionContext,
  ToolGateway,
  ToolResult,
} from "@finance-ai-news-agent/plugin-sdk";
import Parser from "rss-parser";
import { z } from "zod";

import {
  collectionDisposition,
  rssFeedDiagnosis,
  summarizeCollectionDiagnosis,
} from "./collection-diagnosis.js";
import type { RssCollectionDiagnosis, RssFeedDiagnosis } from "./collection-diagnosis.js";

export type {
  RssCollectionDiagnosis,
  RssCollectionOutcome,
  RssFeedDiagnosis,
} from "./collection-diagnosis.js";

const TRACKING_PARAMETERS = new Set([
  "f",
  "from",
  "ref",
  "rss",
  "source",
  "spm",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term",
]);
const FUTURE_ITEM_SKEW_MS = 3 * 60 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_FEED_RETRY_DELAY_MS = 400;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_ITEM_AGE_HOURS = 48;
const DEFAULT_MAX_EXCERPT_CHARS = 600;
const MAX_FEEDS = 16;
const MAX_RESULTS = 24;
const RSS_USER_AGENT = "finance-ai-news-agent (+https://github.com/liuxzzz/finance-ai-news-agent)";
const TRANSIENT_HTTP_STATUSES = new Set([429, 502, 503, 504]);
const TRANSIENT_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const HTTP_STATUS_IN_MESSAGE = /(?:\bstatus(?:\s+code)?|\bHTTP\/1\.[01])[:\s]+(\d{3})\b/i;
const TRANSIENT_CODE_IN_MESSAGE =
  /\b(?:EAI_AGAIN|ECONNABORTED|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EPIPE|ETIMEDOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET)\b/;
const OBVIOUS_FEED_PARSE_ERROR =
  /unable to parse xml|feed not recognized as rss|default rss version not recognized|non-whitespace before first tag|invalid character|unexpected close tag|unclosed (?:root|xml)|no root element|attribute without value/i;

export interface RssFeedConfig {
  id: string;
  url: string;
  name?: string;
}

export interface ParsedRssItem {
  title?: string;
  link?: string;
  guid?: string;
  pubDate?: string;
  isoDate?: string;
  contentSnippet?: string;
  content?: string;
  summary?: string;
}

export interface ParsedRssFeed {
  title?: string;
  items: ParsedRssItem[];
}

export interface RssNewsGatewayOptions {
  feeds: readonly RssFeedConfig[];
  timeoutMs?: number;
  cacheTtlMs?: number;
  maxItemAgeHours?: number;
  maxExcerptChars?: number;
  minimumResultCount?: number;
  now?: () => number;
  parseFeed?: (url: string) => Promise<ParsedRssFeed>;
  retryDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  sourceAudit?: SourceAuditStore;
  generateId?: () => string;
}

interface LoadedRssItem {
  title: string;
  url: string;
  excerpt: string;
  source: string;
  sourceId: string;
  publishedAt: string;
  publishedTime: number;
  externalId: string | null;
  contentHash: string;
  raw: JsonObject;
}

const SearchNewsArgumentsSchema = z
  .object({
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(MAX_RESULTS).default(10),
  })
  .strict();

const SEARCH_NEWS_TOOL: ToolDescriptor = {
  name: "search_news",
  description:
    "Search the latest items fetched directly from configured RSS feeds. Use concise topic keywords.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 200 },
      limit: { type: "integer", minimum: 1, maximum: MAX_RESULTS, default: 10 },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

/**
 * Internal read-only tool gateway backed by RSS. Feed URLs come only from
 * trusted application configuration; the model can choose keywords and limit.
 */
export class RssNewsGateway implements ToolGateway {
  private readonly feeds: RssFeedConfig[];
  private readonly cacheTtlMs: number;
  private readonly maxItemAgeMs: number;
  private readonly maxExcerptChars: number;
  private readonly minimumResultCount: number;
  private readonly now: () => number;
  private readonly retryDelayMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly parseFeed: (url: string) => Promise<ParsedRssFeed>;
  private readonly sourceAudit: SourceAuditStore | undefined;
  private readonly generateId: () => string;
  private cache: { expiresAt: number; items: LoadedRssItem[] } | undefined;
  private loading: Promise<LoadedRssItem[]> | undefined;
  private lastDiagnosis: RssCollectionDiagnosis | undefined;

  constructor(options: RssNewsGatewayOptions) {
    if (options.feeds.length === 0 || options.feeds.length > MAX_FEEDS) {
      throw new Error(`RSS feeds must contain 1 to ${MAX_FEEDS} entries.`);
    }

    const ids = new Set<string>();
    const urls = new Set<string>();
    this.feeds = options.feeds.map((feed) => {
      const id = feed.id.trim();
      const url = validateRssFeedUrl(feed.url).toString();

      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
        throw new Error(`RSS feed ID is invalid: ${feed.id}.`);
      }

      if (ids.has(id) || urls.has(url)) {
        throw new Error("RSS feed IDs and URLs must be unique.");
      }

      ids.add(id);
      urls.add(url);
      const name = feed.name?.trim();
      return { id, url, ...(name === undefined || name.length === 0 ? {} : { name }) };
    });
    this.cacheTtlMs = nonnegativeInteger(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, "cacheTtlMs");
    this.maxItemAgeMs =
      positiveNumber(options.maxItemAgeHours ?? DEFAULT_MAX_ITEM_AGE_HOURS, "maxItemAgeHours") *
      60 *
      60 *
      1_000;
    this.maxExcerptChars = boundedPositiveInteger(
      options.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS,
      "maxExcerptChars",
      4_000,
    );
    this.minimumResultCount = boundedNonnegativeInteger(
      options.minimumResultCount ?? 0,
      "minimumResultCount",
      MAX_RESULTS,
    );
    this.now = options.now ?? Date.now;
    this.retryDelayMs = nonnegativeInteger(
      options.retryDelayMs ?? DEFAULT_FEED_RETRY_DELAY_MS,
      "retryDelayMs",
    );
    this.sleep = options.sleep ?? defaultSleep;
    this.sourceAudit = options.sourceAudit;
    this.generateId = options.generateId ?? randomUUID;

    if (options.parseFeed !== undefined) {
      this.parseFeed = options.parseFeed;
    } else {
      const parser = new Parser({
        headers: { "User-Agent": RSS_USER_AGENT },
        timeout: positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs"),
      });
      this.parseFeed = async (url) => parser.parseURL(url);
    }
  }

  async listTools(): Promise<ToolDescriptor[]> {
    return [structuredClone(SEARCH_NEWS_TOOL)];
  }

  async callTool(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
    if (call.name !== SEARCH_NEWS_TOOL.name) {
      throw new Error(`RSS tool ${call.name} is not available.`);
    }

    const parsedArguments = SearchNewsArgumentsSchema.safeParse(call.arguments);

    if (!parsedArguments.success) {
      throw new Error(`Invalid arguments for RSS tool ${call.name}.`);
    }

    let items: LoadedRssItem[];

    try {
      items = await this.loadItems(context?.runId);
    } catch (error) {
      return {
        content: {
          error: error instanceof Error ? error.message : "RSS feeds could not be loaded.",
        },
        isError: true,
      };
    }

    const selected = selectLatestRelevantItems(
      items,
      parsedArguments.data.query,
      Math.max(parsedArguments.data.limit, this.minimumResultCount),
    );

    return {
      content: {
        items: selected.map((item) => ({
          id: rssEvidenceId(item.url),
          title: item.title,
          url: item.url,
          excerpt: item.excerpt,
          source: item.source,
          sourceId: item.sourceId,
          publishedAt: item.publishedAt,
        })),
      },
      isError: false,
    };
  }

  clearCache(): void {
    this.cache = undefined;
    this.lastDiagnosis = undefined;
  }

  /**
   * Classify each configured feed with the same fetch, retry, normalize, and age
   * window as `search_news`. This bypasses the feed cache. When a source audit
   * store and runId are both present, it writes the same collection rows as a
   * live fetch. `run-live` does not call this method.
   */
  async diagnose(context?: ToolExecutionContext): Promise<RssCollectionDiagnosis> {
    this.clearCache();

    try {
      await this.loadItems(context?.runId);
    } catch (error) {
      if (this.lastDiagnosis === undefined) {
        throw error;
      }
    }

    if (this.lastDiagnosis === undefined) {
      throw new Error("RSS collection diagnosis was not recorded.");
    }

    return this.lastDiagnosis;
  }

  private async loadItems(runId: string | undefined): Promise<LoadedRssItem[]> {
    const now = this.now();

    if (this.cache !== undefined && this.cache.expiresAt > now) {
      return this.cache.items;
    }

    if (this.sourceAudit !== undefined && runId === undefined) {
      throw new Error("RSS source auditing requires a runId execution context.");
    }

    this.loading ??= this.fetchItems(runId);

    try {
      const items = await this.loading;
      this.cache = { expiresAt: now + this.cacheTtlMs, items };
      return items;
    } finally {
      this.loading = undefined;
    }
  }

  private async fetchItems(runId: string | undefined): Promise<LoadedRssItem[]> {
    const dispositions: Array<RssFeedDiagnosis | undefined> = Array.from(
      { length: this.feeds.length },
      () => undefined,
    );
    const results = await Promise.allSettled(
      this.feeds.map(async (configuredFeed, index) => {
        const sourceRunId = this.generateId();
        const startedAt = new Date(this.now()).toISOString();

        try {
          const feed = await this.parseFeedWithRetry(configuredFeed.url);
          const source = configuredFeed.name ?? cleanText(feed.title ?? "") ?? configuredFeed.id;
          const normalized = feed.items
            .map((item) =>
              normalizeItem(
                item,
                configuredFeed.id,
                source,
                configuredFeed.url,
                this.maxExcerptChars,
              ),
            )
            .filter((item): item is LoadedRssItem => item !== null);
          const partitioned = partitionByAge(normalized, this.now(), this.maxItemAgeMs);
          const diagnosis = rssFeedDiagnosis({
            sourceId: configuredFeed.id,
            received: feed.items.length,
            normalized: normalized.length,
            fresh: partitioned.fresh.length,
            invalid: feed.items.length - normalized.length,
            stale: partitioned.stale,
            future: partitioned.future,
            error: null,
          });
          dispositions[index] = diagnosis;
          const finishedAt = new Date(this.now()).toISOString();

          if (this.sourceAudit !== undefined && runId !== undefined) {
            await this.sourceAudit.recordSourceCollection({
              id: sourceRunId,
              runId,
              sourceId: configuredFeed.id,
              sourceUrlFingerprint: fingerprint(configuredFeed.url),
              status: "succeeded",
              itemCount: normalized.length,
              disposition: collectionDisposition(diagnosis),
              error: null,
              startedAt,
              finishedAt,
              items: normalized.map((item) => ({
                id: rawSourceItemId(runId, item.url),
                runId,
                sourceRunId,
                sourceId: item.sourceId,
                externalId: item.externalId,
                url: item.url,
                title: item.title,
                excerpt: item.excerpt,
                publishedAt: item.publishedAt,
                collectedAt: finishedAt,
                contentHash: item.contentHash,
                raw: item.raw,
              })),
            });
          }

          return partitioned.fresh;
        } catch (error) {
          if (dispositions[index] === undefined) {
            const diagnosis = rssFeedDiagnosis({
              sourceId: configuredFeed.id,
              received: 0,
              normalized: 0,
              fresh: 0,
              invalid: 0,
              stale: 0,
              future: 0,
              error,
            });
            dispositions[index] = diagnosis;

            if (this.sourceAudit !== undefined && runId !== undefined) {
              await this.sourceAudit.recordSourceCollection({
                id: sourceRunId,
                runId,
                sourceId: configuredFeed.id,
                sourceUrlFingerprint: fingerprint(configuredFeed.url),
                status: "failed",
                itemCount: 0,
                disposition: collectionDisposition(diagnosis),
                error: serializeError(error),
                startedAt,
                finishedAt: new Date(this.now()).toISOString(),
                items: [],
              });
            }
          }

          throw error;
        }
      }),
    );
    const successful = results.filter(
      (result): result is PromiseFulfilledResult<LoadedRssItem[]> => result.status === "fulfilled",
    );
    const diagnosed = dispositions.filter(
      (diagnosis): diagnosis is RssFeedDiagnosis => diagnosis !== undefined,
    );

    if (diagnosed.length !== this.feeds.length) {
      const firstFailure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      throw firstFailure === undefined
        ? new Error("RSS collection diagnosis missed a configured feed.")
        : firstFailure.reason;
    }

    const deduped = dedupeFreshItems(successful.flatMap((result) => result.value));
    this.lastDiagnosis = summarizeCollectionDiagnosis(diagnosed, deduped.length);

    if (successful.length === 0) {
      const firstFailure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      throw new Error(
        `All configured RSS feeds failed${
          firstFailure === undefined ? "." : `: ${errorMessage(firstFailure.reason)}`
        }`,
      );
    }

    return deduped;
  }

  /**
   * One extra attempt for a transient fetch. Audit stays outside this method,
   * so a success after retry records a single succeeded row.
   */
  private async parseFeedWithRetry(url: string): Promise<ParsedRssFeed> {
    try {
      return await this.parseFeed(url);
    } catch (error) {
      if (!isTransientFeedError(error)) {
        throw error;
      }

      await this.sleep(this.retryDelayMs);
      return this.parseFeed(url);
    }
  }
}

export function validateRssFeedUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("RSS feed URL must be a valid HTTP(S) URL.");
  }

  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";

  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("RSS feed URL must use HTTPS except for local loopback tests.");
  }

  if (url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) {
    throw new Error("RSS feed URL must not contain credentials or fragments.");
  }

  return url;
}

function partitionByAge(
  items: readonly LoadedRssItem[],
  now: number,
  maxItemAgeMs: number,
): { fresh: LoadedRssItem[]; stale: number; future: number } {
  const earliest = now - maxItemAgeMs;
  const latest = now + FUTURE_ITEM_SKEW_MS;
  const fresh: LoadedRssItem[] = [];
  let stale = 0;
  let future = 0;

  for (const item of items) {
    if (item.publishedTime < earliest) {
      stale += 1;
    } else if (item.publishedTime > latest) {
      future += 1;
    } else {
      fresh.push(item);
    }
  }

  return { fresh, stale, future };
}

function dedupeFreshItems(items: readonly LoadedRssItem[]): LoadedRssItem[] {
  const byUrl = new Map<string, LoadedRssItem>();

  for (const item of items) {
    const existing = byUrl.get(item.url);

    if (existing === undefined || item.publishedTime > existing.publishedTime) {
      byUrl.set(item.url, item);
    }
  }

  return [...byUrl.values()].sort((left, right) => right.publishedTime - left.publishedTime);
}

function normalizeItem(
  item: ParsedRssItem,
  sourceId: string,
  source: string,
  feedUrl: string,
  maxExcerptChars: number,
): LoadedRssItem | null {
  const title = cleanText(item.title ?? "");
  const url = articleUrl(item, feedUrl);

  if (title === null || url === null) {
    return null;
  }

  const excerpt = cleanText(item.contentSnippet ?? item.summary ?? item.content ?? "") ?? title;
  const dateText = item.isoDate ?? item.pubDate;
  const parsedTime = dateText === undefined ? Number.NaN : Date.parse(dateText);

  if (!Number.isFinite(parsedTime)) {
    return null;
  }

  const publishedTime = parsedTime;
  const raw = parsedRssItemJson(item);
  const contentHash = createHash("sha256").update(JSON.stringify(raw)).digest("hex");

  return {
    title: title.slice(0, 300),
    url: url.toString(),
    excerpt: excerpt.slice(0, maxExcerptChars),
    source: source.slice(0, 120),
    sourceId,
    publishedAt: new Date(publishedTime).toISOString(),
    publishedTime,
    externalId: item.guid?.trim() || null,
    contentHash,
    raw,
  };
}

function articleUrl(item: ParsedRssItem, feedUrl: string): URL | null {
  const link = item.link?.trim();

  if (link !== undefined && link.length > 0) {
    const resolved = safeHttpUrl(link, feedUrl);

    if (resolved !== null) {
      return canonicalizeArticleUrl(resolved);
    }
  }

  const guid = item.guid?.trim();
  const guidUrl = guid === undefined || guid.length === 0 ? null : safeHttpUrl(guid);
  return guidUrl === null ? null : canonicalizeArticleUrl(guidUrl);
}

function canonicalizeArticleUrl(url: URL): URL {
  const canonical = new URL(url.toString());
  canonical.hash = "";

  for (const name of [...canonical.searchParams.keys()]) {
    const normalized = name.toLocaleLowerCase("en-US");

    if (TRACKING_PARAMETERS.has(normalized) || normalized.startsWith("utm_")) {
      canonical.searchParams.delete(name);
    }
  }

  canonical.searchParams.sort();
  return canonical;
}

function safeHttpUrl(value: string, baseUrl?: string): URL | null {
  try {
    const url = baseUrl === undefined ? new URL(value) : new URL(value, baseUrl);

    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

function selectLatestRelevantItems(
  items: LoadedRssItem[],
  query: string,
  limit: number,
): LoadedRssItem[] {
  const tokens = query
    .toLocaleLowerCase("zh-CN")
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  const bySource = new Map<string, Array<{ item: LoadedRssItem; score: number }>>();

  for (const item of items) {
    const candidates = bySource.get(item.sourceId) ?? [];
    candidates.push({ item, score: relevanceScore(item, tokens) });
    bySource.set(item.sourceId, candidates);
  }

  for (const candidates of bySource.values()) {
    const hasRelevantItems = candidates.some(({ score }) => score > 0);

    if (hasRelevantItems) {
      const relevant = candidates.filter(({ score }) => score > 0);
      candidates.splice(0, candidates.length, ...relevant);
    }

    candidates.sort(
      (left, right) =>
        right.score - left.score || right.item.publishedTime - left.item.publishedTime,
    );
  }

  const sourceQueues = [...bySource.entries()].sort((left, right) => {
    const leftTop = left[1][0];
    const rightTop = right[1][0];
    return (
      (rightTop?.score ?? 0) - (leftTop?.score ?? 0) ||
      (rightTop?.item.publishedTime ?? 0) - (leftTop?.item.publishedTime ?? 0)
    );
  });
  const selected: LoadedRssItem[] = [];

  for (let round = 0; selected.length < limit; round += 1) {
    let added = false;

    for (const [, candidates] of sourceQueues) {
      const candidate = candidates[round];

      if (candidate === undefined) {
        continue;
      }

      selected.push(candidate.item);
      added = true;

      if (selected.length >= limit) {
        break;
      }
    }

    if (!added) {
      break;
    }
  }

  return selected;
}

function relevanceScore(item: LoadedRssItem, tokens: string[]): number {
  const title = item.title.toLocaleLowerCase("zh-CN");
  const excerpt = item.excerpt.toLocaleLowerCase("zh-CN");
  return tokens.reduce(
    (score, token) => score + (title.includes(token) ? 3 : 0) + (excerpt.includes(token) ? 1 : 0),
    0,
  );
}

function rssEvidenceId(url: string): string {
  return `rss-${createHash("sha256").update(url).digest("hex").slice(0, 24)}`;
}

function rawSourceItemId(runId: string, url: string): string {
  return `raw-${createHash("sha256").update(`${runId}\u0000${url}`).digest("hex").slice(0, 32)}`;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function parsedRssItemJson(item: ParsedRssItem): JsonObject {
  return Object.fromEntries(
    Object.entries({
      title: item.title,
      link: item.link,
      guid: item.guid,
      pubDate: item.pubDate,
      isoDate: item.isoDate,
      contentSnippet: item.contentSnippet,
      content: item.content,
      summary: item.summary,
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }

  return { name: "Error", message: String(error) };
}

function cleanText(value: string): string | null {
  const normalized = decodeHtmlEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length === 0 ? null : normalized;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d{1,7});/g, (entity, digits: string) =>
      decodeNumericEntity(Number(digits), entity),
    )
    .replace(/&#x([0-9a-f]{1,6});/gi, (entity, hex: string) =>
      decodeNumericEntity(Number.parseInt(hex, 16), entity),
    );
}

function decodeNumericEntity(codePoint: number, entity: string): string {
  if (
    !Number.isInteger(codePoint) ||
    codePoint < 0x20 ||
    codePoint === 0x7f ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return entity;
  }

  return String.fromCodePoint(codePoint);
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * rss-parser 3.13 `parseURL` rejects HTTP failures as `Error` with message
 * `Status code <n>` and no status field. Timeouts use
 * `Request timed out after <ms>ms`. Socket failures reject the Node error,
 * whose `code` is ECONNRESET, ETIMEDOUT, ECONNREFUSED, ENOTFOUND, and similar.
 * XML parsing runs only after the response ends, so those parser messages are
 * not treated as truncated transfers.
 */
function isTransientFeedError(error: unknown): boolean {
  const status = httpStatus(error);

  if (status !== undefined) {
    return TRANSIENT_HTTP_STATUSES.has(status);
  }

  return hasTransientNetworkSignal(error, 0);
}

function httpStatus(error: unknown, depth = 0): number | undefined {
  if (depth > 4 || !isRecord(error)) {
    return undefined;
  }

  const direct = numericStatus(error.status) ?? numericStatus(error.statusCode);

  if (direct !== undefined) {
    return direct;
  }

  if (isRecord(error.response)) {
    const responseStatus =
      numericStatus(error.response.status) ?? numericStatus(error.response.statusCode);

    if (responseStatus !== undefined) {
      return responseStatus;
    }
  }

  const message = readString(error.message);

  if (message !== undefined) {
    const match = message.match(HTTP_STATUS_IN_MESSAGE);

    if (match?.[1] !== undefined) {
      return Number(match[1]);
    }
  }

  return httpStatus(error.cause, depth + 1);
}

function hasTransientNetworkSignal(error: unknown, depth: number): boolean {
  if (depth > 4) {
    return false;
  }

  if (typeof error === "string") {
    return !OBVIOUS_FEED_PARSE_ERROR.test(error) && messageIsTransient(error, "");
  }

  if (!isRecord(error)) {
    return false;
  }

  const name = readString(error.name) ?? "";
  const message = readString(error.message) ?? "";
  const code = readString(error.code);

  if (code !== undefined && TRANSIENT_NETWORK_CODES.has(code)) {
    return true;
  }

  if (name === "AbortError" || name === "TimeoutError") {
    return true;
  }

  if (OBVIOUS_FEED_PARSE_ERROR.test(message)) {
    return false;
  }

  if (messageIsTransient(message, name)) {
    return true;
  }

  if (hasTransientNetworkSignal(error.cause, depth + 1)) {
    return true;
  }

  return (
    Array.isArray(error.errors) &&
    error.errors.some((item) => hasTransientNetworkSignal(item, depth + 1))
  );
}

function messageIsTransient(message: string, name: string): boolean {
  if (
    name === "TypeError" &&
    /fetch failed|failed to fetch|networkerror|network error|network failure|network request failed/i.test(
      message,
    )
  ) {
    return true;
  }

  return (
    /timed out/i.test(message) ||
    /\btimeout\b/i.test(message) ||
    /socket hang up/i.test(message) ||
    /the operation was aborted/i.test(message) ||
    /\brequest aborted\b/i.test(message) ||
    TRANSIENT_CODE_IN_MESSAGE.test(message)
  );
}

function numericStatus(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) {
    return value;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative integer.`);
  }

  return value;
}

function boundedNonnegativeInteger(value: number, name: string, maximum: number): number {
  const parsed = nonnegativeInteger(value, name);

  if (parsed > maximum) {
    throw new Error(`${name} must not exceed ${maximum}.`);
  }

  return parsed;
}

function boundedPositiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }

  return value;
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }

  return value;
}
