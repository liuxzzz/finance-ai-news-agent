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

import { installAtomFeedTolerance } from "./atom-feed-tolerance.js";
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
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
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
// A body that stops before the root closes. Another fetch often returns the
// rest of the document, so these are retried once like other transient failures.
const TRUNCATED_FEED_PARSE_ERROR =
  /unexpected close tag|unclosed (?:root|xml)|no root element|unexpected end/i;
// HTML, an unrecognized feed, or XML that is malformed in a durable way.
const PERMANENT_FEED_PARSE_ERROR =
  /unable to parse xml|feed not recognized as rss|default rss version not recognized|non-whitespace before first tag|invalid character|attribute without value/i;

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
  published?: string;
  updated?: string;
  "dc:date"?: string;
  dcDate?: string;
  date?: string;
  contentSnippet?: string;
  content?: string;
  summary?: string;
}

interface AdaptedRssItem extends ParsedRssItem {
  linkHrefs: readonly string[];
  guidIsPermalink: boolean;
  permalinkId?: string;
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
  parseFeed?: (url: string) => Promise<unknown>;
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

    let readFeed: (url: string) => Promise<unknown>;

    if (options.parseFeed !== undefined) {
      readFeed = options.parseFeed;
    } else {
      const parser = createRssParser(
        positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs"),
      );
      readFeed = (url) => parser.parseURL(url);
    }

    this.parseFeed = async (url) => adaptParsedFeed(await readFeed(url));
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

/**
 * rss-parser already copies Atom `published` / `updated` onto `pubDate` when the
 * element text is a bare string, and it copies RSS `dc:date` onto `date` before
 * deriving `isoDate`. Those mappings miss RSS `published` / `updated` / `date`,
 * Atom `dc:date`, and element text stored under attributes. `elementDate` keeps
 * a literal `<date>` off `item.date`, which is the Dublin Core alias `setISODate`
 * already consumed.
 */
function createRssParser(timeoutMs: number): Parser {
  installAtomFeedTolerance();
  return new Parser({
    headers: { "User-Agent": RSS_USER_AGENT },
    timeout: timeoutMs,
    customFields: {
      item: [
        "published",
        "updated",
        ["dc:date", "dcDate"],
        "dc:date",
        ["date", "elementDate"],
        ["link", "rawLinks", { keepArray: true }],
        ["guid", "rawGuid", { keepArray: true }],
      ],
    },
  });
}

/**
 * rss-parser 3.13 turns a lone Atom `<link href>` into a string, but `getLink`
 * returns the first `rel=alternate` even when that target is `application/atom+xml`,
 * and otherwise uses the first link. With no HTML alternate, that first link is
 * often an audio or video enclosure. An RSS `<link href="...">` stays an object,
 * and an XHTML `title` stays an object, so reading only strings drops the item.
 * `rawLinks` and `rawGuid` keep the xml2js nodes from the custom fields above.
 * RSS text `<link>` nodes already arrive as strings. Atom text, CDATA, and
 * empty `<link>` nodes are normalized before `getLink`, so one of them does
 * not reject the feed before this adapter runs.
 */
function adaptParsedFeed(value: unknown): ParsedRssFeed {
  if (!isRecord(value)) {
    return { items: [] };
  }

  const title = readXmlText(value.title);
  const items = Array.isArray(value.items) ? value.items.map((item) => adaptParsedItem(item)) : [];
  return {
    ...(title === undefined ? {} : { title }),
    items,
  };
}

function adaptParsedItem(value: unknown): AdaptedRssItem {
  if (!isRecord(value)) {
    return { linkHrefs: [], guidIsPermalink: true };
  }

  const literalDate = readString(value.elementDate);
  const date =
    literalDate !== undefined && literalDate.trim().length > 0
      ? literalDate
      : readString(value.date);
  const hrefs = selectArticleHrefs(value);
  const guidInfo = readPermalinkGuid(value);
  const permalinkId = readHttpIdentifier(value.id);

  return {
    ...optionalText("title", readXmlText(value.title)),
    ...optionalText("link", hrefs[0]),
    ...optionalText("guid", guidInfo.guid),
    ...optionalText("pubDate", readString(value.pubDate)),
    ...optionalText("isoDate", readString(value.isoDate)),
    ...optionalText("published", readString(value.published)),
    ...optionalText("updated", readString(value.updated)),
    ...optionalText("dc:date", readString(value["dc:date"])),
    ...optionalText("dcDate", readString(value.dcDate)),
    ...optionalText("date", date),
    ...optionalText("contentSnippet", readXmlText(value.contentSnippet)),
    ...optionalText("content", readXmlText(value.content)),
    ...optionalText("summary", readXmlText(value.summary)),
    linkHrefs: hrefs,
    guidIsPermalink: guidInfo.permalink,
    ...(permalinkId === undefined ? {} : { permalinkId }),
  };
}

function optionalText<Key extends keyof ParsedRssItem>(
  key: Key,
  value: string | undefined,
): Pick<ParsedRssItem, Key> | Record<string, never> {
  if (value === undefined) {
    return {};
  }

  return { [key]: value } as Pick<ParsedRssItem, Key>;
}

const PUBLISHED_AT_FIELDS = [
  "isoDate",
  "pubDate",
  "published",
  "updated",
  "dc:date",
  "dcDate",
  "date",
] as const satisfies readonly (keyof ParsedRssItem)[];

function publishedTimestamp(item: ParsedRssItem): number | undefined {
  for (const field of PUBLISHED_AT_FIELDS) {
    const value = item[field];

    if (typeof value !== "string") {
      continue;
    }

    const parsed = Date.parse(value.trim());

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
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
  const publishedTime = publishedTimestamp(item);

  if (publishedTime === undefined) {
    return null;
  }

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
  const adapted = item as AdaptedRssItem;
  const hrefs = adapted.linkHrefs ?? (item.link === undefined ? [] : [item.link]);

  for (const href of hrefs) {
    const resolved = safeHttpUrl(href, feedUrl);

    if (resolved !== null) {
      return canonicalizeArticleUrl(resolved);
    }
  }

  if (adapted.guidIsPermalink !== false) {
    const guid = item.guid?.trim();

    if (guid !== undefined && guid.length > 0) {
      const guidUrl = safeHttpUrl(guid);

      if (guidUrl !== null) {
        return canonicalizeArticleUrl(guidUrl);
      }
    }
  }

  const permalinkId = adapted.permalinkId?.trim();

  if (permalinkId !== undefined && permalinkId.length > 0) {
    const idUrl = safeHttpUrl(permalinkId);

    if (idUrl !== null) {
      return canonicalizeArticleUrl(idUrl);
    }
  }

  return null;
}

interface LinkCandidate {
  href: string;
  rel?: string;
  type?: string;
}

const AUDIO_VIDEO_EXTENSION = /\.(?:aac|m4a|m4v|mov|mp3|mp4|mpeg|mpg|ogg|opus|wav|webm)$/i;

/**
 * Rank http(s) article links before resolution. Missing `rel` counts as
 * `alternate`. Audio and video links are skipped. Other enclosures stay last
 * so a JPEG does not beat an HTML `related` link, and can still be used when
 * nothing else resolves.
 */
function selectArticleHrefs(value: Record<string, unknown>): string[] {
  const source =
    Array.isArray(value.rawLinks) && value.rawLinks.length > 0 ? value.rawLinks : value.link;
  const candidates: LinkCandidate[] = [];
  collectLinkCandidates(source, candidates);
  const ranked = candidates
    .map((candidate, index) => ({ candidate, index, rank: articleLinkRank(candidate) }))
    .filter(
      (entry): entry is { candidate: LinkCandidate; index: number; rank: number } =>
        entry.rank !== undefined,
    )
    .sort((left, right) => left.rank - right.rank || left.index - right.index);
  const hrefs: string[] = [];

  for (const entry of ranked) {
    if (!hrefs.includes(entry.candidate.href)) {
      hrefs.push(entry.candidate.href);
    }
  }

  return hrefs;
}

function collectLinkCandidates(value: unknown, output: LinkCandidate[]): void {
  if (typeof value === "string") {
    const href = value.trim();

    if (href.length > 0) {
      output.push({ href });
    }

    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectLinkCandidates(entry, output);
    }

    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const attrs = isRecord(value.$) ? value.$ : value;
  const href = readString(attrs.href)?.trim() || readString(value._)?.trim() || "";

  if (href.length === 0) {
    return;
  }

  const rel = readString(attrs.rel)?.trim().toLocaleLowerCase("en-US");
  const type = readString(attrs.type)?.trim().toLocaleLowerCase("en-US");
  output.push({
    href,
    ...(rel === undefined || rel.length === 0 ? {} : { rel }),
    ...(type === undefined || type.length === 0 ? {} : { type }),
  });
}

function articleLinkRank(candidate: LinkCandidate): number | undefined {
  if (isAudioVideoLink(candidate)) {
    return undefined;
  }

  const alternate = candidate.rel === undefined || candidate.rel === "alternate";

  if (alternate && isArticleType(candidate.type)) {
    return 0;
  }

  if (alternate) {
    return 1;
  }

  if (candidate.rel !== "enclosure") {
    return 2;
  }

  return 3;
}

function isAudioVideoLink(candidate: LinkCandidate): boolean {
  const mime = candidate.type === undefined ? "" : mediaType(candidate.type);

  if (mime.startsWith("audio/") || mime.startsWith("video/")) {
    return true;
  }

  if (candidate.type !== undefined && isArticleType(candidate.type)) {
    return false;
  }

  return audioVideoPath(candidate.href);
}

function isArticleType(type: string | undefined): boolean {
  if (type === undefined) {
    return true;
  }

  const mime = mediaType(type);
  return mime === "text/html" || mime === "application/xhtml+xml" || mime === "text/plain";
}

function mediaType(type: string): string {
  return type.split(";")[0]?.trim() ?? "";
}

function audioVideoPath(href: string): boolean {
  const withoutFragment = href.split("#")[0] ?? href;
  const withoutQuery = withoutFragment.split("?")[0] ?? withoutFragment;
  return AUDIO_VIDEO_EXTENSION.test(withoutQuery.replace(/\/+$/u, ""));
}

function readPermalinkGuid(value: Record<string, unknown>): { guid?: string; permalink: boolean } {
  const rawGuid = value.rawGuid;
  const source = Array.isArray(rawGuid) ? rawGuid : value.guid;
  const nodes = Array.isArray(source) ? source : [source];
  let guid: string | undefined;
  let permalink = true;
  let sawPermalinkFlag = false;

  for (const node of nodes) {
    const parsed = readGuidNode(node);

    if (parsed === undefined) {
      continue;
    }

    if (guid === undefined && parsed.text !== undefined) {
      guid = parsed.text;
    }

    if (parsed.permalink !== undefined && !sawPermalinkFlag) {
      permalink = parsed.permalink;
      sawPermalinkFlag = true;
    }
  }

  if (guid === undefined) {
    const direct = readString(value.guid)?.trim();

    if (direct !== undefined && direct.length > 0) {
      guid = direct;
    }
  }

  return { ...(guid === undefined ? {} : { guid }), permalink };
}

function readGuidNode(value: unknown): { text?: string; permalink?: boolean } | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    return text.length === 0 ? undefined : { text };
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const attrs = isRecord(value.$) ? value.$ : value;
  const flag = readString(attrs.isPermaLink)?.trim().toLocaleLowerCase("en-US");
  const text = readString(value._)?.trim() ?? "";
  const permalink = flag === "false" ? false : flag === "true" ? true : undefined;

  if (text.length === 0 && permalink === undefined) {
    return undefined;
  }

  return {
    ...(text.length === 0 ? {} : { text }),
    ...(permalink === undefined ? {} : { permalink }),
  };
}

function readHttpIdentifier(value: unknown): string | undefined {
  const text = readXmlText(value)?.trim();

  if (text === undefined || text.length === 0 || safeHttpUrl(text) === null) {
    return undefined;
  }

  return text;
}

function readXmlText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  const parts: string[] = [];
  collectXmlText(value, parts);
  const text = parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");
  return text.length === 0 ? undefined : text;
}

function collectXmlText(value: unknown, parts: string[]): void {
  if (typeof value === "string") {
    parts.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectXmlText(entry, parts);
    }

    return;
  }

  if (!isRecord(value)) {
    return;
  }

  if (typeof value._ === "string") {
    parts.push(value._);
  }

  for (const [key, entry] of Object.entries(value)) {
    if (key === "$" || key === "_") {
      continue;
    }

    collectXmlText(entry, parts);
  }
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
      published: item.published,
      updated: item.updated,
      "dc:date": item["dc:date"],
      dcDate: item.dcDate,
      date: item.date,
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
 * Retryable statuses are 408, 429, 500, 502, 503, 504, and 520–524. Other
 * statuses, including 401, 403, 404, and 410, are final.
 * A document that stops before the root closes (`unclosed root` / `unclosed xml`,
 * `unexpected close tag`, `no root element`, `unexpected end`) is treated as a
 * truncated transfer and retried once. A response that is not a feed, or XML
 * that is malformed in a durable way, is not.
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
    if (TRUNCATED_FEED_PARSE_ERROR.test(error)) {
      return true;
    }

    return !PERMANENT_FEED_PARSE_ERROR.test(error) && messageIsTransient(error, "");
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

  if (TRUNCATED_FEED_PARSE_ERROR.test(message)) {
    return true;
  }

  if (PERMANENT_FEED_PARSE_ERROR.test(message)) {
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
