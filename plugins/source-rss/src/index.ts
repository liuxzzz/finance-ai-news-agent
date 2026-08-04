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

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_ITEM_AGE_HOURS = 48;
const DEFAULT_MAX_EXCERPT_CHARS = 600;
const MAX_FEEDS = 16;
const MAX_RESULTS = 24;

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
  private readonly parseFeed: (url: string) => Promise<ParsedRssFeed>;
  private readonly sourceAudit: SourceAuditStore | undefined;
  private readonly generateId: () => string;
  private cache: { expiresAt: number; items: LoadedRssItem[] } | undefined;
  private loading: Promise<LoadedRssItem[]> | undefined;

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
    this.sourceAudit = options.sourceAudit;
    this.generateId = options.generateId ?? randomUUID;

    if (options.parseFeed !== undefined) {
      this.parseFeed = options.parseFeed;
    } else {
      const parser = new Parser({
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
    const results = await Promise.allSettled(
      this.feeds.map(async (configuredFeed) => {
        const sourceRunId = this.generateId();
        const startedAt = new Date(this.now()).toISOString();

        try {
          const feed = await this.parseFeed(configuredFeed.url);
          const source = configuredFeed.name ?? cleanText(feed.title ?? "") ?? configuredFeed.id;
          const normalized = feed.items
            .map((item) => normalizeItem(item, configuredFeed.id, source, this.maxExcerptChars))
            .filter((item): item is LoadedRssItem => item !== null);
          const finishedAt = new Date(this.now()).toISOString();

          if (this.sourceAudit !== undefined && runId !== undefined) {
            await this.sourceAudit.recordSourceCollection({
              id: sourceRunId,
              runId,
              sourceId: configuredFeed.id,
              sourceUrlFingerprint: fingerprint(configuredFeed.url),
              status: "succeeded",
              itemCount: normalized.length,
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

          return normalized.filter((item) => item.publishedTime >= this.now() - this.maxItemAgeMs);
        } catch (error) {
          if (this.sourceAudit !== undefined && runId !== undefined) {
            await this.sourceAudit.recordSourceCollection({
              id: sourceRunId,
              runId,
              sourceId: configuredFeed.id,
              sourceUrlFingerprint: fingerprint(configuredFeed.url),
              status: "failed",
              itemCount: 0,
              error: serializeError(error),
              startedAt,
              finishedAt: new Date(this.now()).toISOString(),
              items: [],
            });
          }

          throw error;
        }
      }),
    );
    const successful = results.filter(
      (result): result is PromiseFulfilledResult<LoadedRssItem[]> => result.status === "fulfilled",
    );

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

    const byUrl = new Map<string, LoadedRssItem>();

    for (const item of successful.flatMap((result) => result.value)) {
      const existing = byUrl.get(item.url);

      if (existing === undefined || item.publishedTime > existing.publishedTime) {
        byUrl.set(item.url, item);
      }
    }

    return [...byUrl.values()].sort((left, right) => right.publishedTime - left.publishedTime);
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

function normalizeItem(
  item: ParsedRssItem,
  sourceId: string,
  source: string,
  maxExcerptChars: number,
): LoadedRssItem | null {
  const title = cleanText(item.title ?? "");
  const link = item.link?.trim();

  if (title === null || link === undefined || link.length === 0) {
    return null;
  }

  let url: URL;

  try {
    url = new URL(link);
  } catch {
    return null;
  }

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
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
  const normalized = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length === 0 ? null : normalized;
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
