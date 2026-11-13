import { validateRssFeedUrl } from "@finance-ai-news-agent/source-rss";

/**
 * Public, unauthenticated HTTPS feeds for the Finance & AI preset.
 * Resolving a selection only validates this configuration; it does not fetch feeds.
 */
export const FINANCE_AI_RSS_CATALOG: readonly RssCatalogFeed[] = [
  { id: "36kr", name: "36氪", url: "https://36kr.com/feed", topic: "general" },
  { id: "huxiu", name: "虎嗅", url: "https://rss.huxiu.com/", topic: "general" },
  { id: "infoq", name: "InfoQ", url: "https://www.infoq.cn/feed", topic: "general" },
  {
    id: "sec-press",
    name: "U.S. SEC Press Releases",
    url: "https://www.sec.gov/news/pressreleases.rss",
    topic: "finance",
  },
  {
    id: "federal-reserve",
    name: "Federal Reserve Press",
    url: "https://www.federalreserve.gov/feeds/press_all.xml",
    topic: "finance",
  },
  {
    id: "ecb-press",
    name: "European Central Bank Press",
    url: "https://www.ecb.europa.eu/rss/press.xml",
    topic: "finance",
  },
  {
    id: "wallstreetcn",
    name: "华尔街见闻",
    url: "https://dedicated.wallstreetcn.com/rss.xml",
    topic: "finance",
  },
  {
    id: "openai-news",
    name: "OpenAI News",
    url: "https://openai.com/news/rss.xml",
    topic: "ai",
  },
  {
    id: "google-ai",
    name: "Google AI Blog",
    url: "https://blog.google/innovation-and-ai/technology/ai/rss/",
    topic: "ai",
  },
  {
    id: "deepmind",
    name: "Google DeepMind Blog",
    url: "https://deepmind.google/blog/rss.xml",
    topic: "ai",
  },
  {
    id: "huggingface-blog",
    name: "Hugging Face Blog",
    url: "https://huggingface.co/blog/feed.xml",
    topic: "ai",
  },
  { id: "qbitai", name: "量子位", url: "https://www.qbitai.com/feed", topic: "ai" },
];

export const DEFAULT_RSS_FEED_URLS: readonly string[] = FINANCE_AI_RSS_CATALOG.filter(
  (feed) => feed.topic === "general",
).map((feed) => feed.url);

const MAX_RSS_FEEDS = 16;
const URL_LIST_ERROR = "RSS_FEED_URLS must contain 1 to 16 unique comma-separated feed URLs.";

export type RssFeedTopic = "finance" | "ai" | "general";

export interface RssCatalogFeed {
  id: string;
  name: string;
  url: string;
  topic: RssFeedTopic;
}

export interface ResolvedRssFeed {
  id: string;
  url: string;
  name?: string;
  topic?: RssFeedTopic;
}

export function resolveRssFeedSelection(input: {
  feedIds: string | undefined;
  feedUrls: string | undefined;
  fallbackUrls: readonly string[];
}): ResolvedRssFeed[] {
  const requestedIds = splitConfigList(input.feedIds);
  const explicitUrls = splitConfigList(input.feedUrls);

  if (requestedIds !== undefined && requestedIds.length === 0) {
    throw new Error("RSS_FEED_IDS must contain at least one catalog id.");
  }

  if (explicitUrls !== undefined && explicitUrls.length === 0) {
    throw new Error(URL_LIST_ERROR);
  }

  const requestedUrls = explicitUrls ?? (requestedIds === undefined ? [...input.fallbackUrls] : []);
  const catalogById = new Map(FINANCE_AI_RSS_CATALOG.map((feed) => [feed.id, feed]));
  const selected: ResolvedRssFeed[] = [];
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();

  if (requestedIds !== undefined) {
    for (const id of requestedIds) {
      if (seenIds.has(id)) {
        throw new Error(`Duplicate RSS feed id: ${id}.`);
      }

      const feed = catalogById.get(id);

      if (feed === undefined) {
        throw new Error(
          `Unknown RSS feed id: ${id}. Known ids: ${FINANCE_AI_RSS_CATALOG.map((entry) => entry.id).join(", ")}.`,
        );
      }

      addFeed(selected, seenIds, seenUrls, {
        id: feed.id,
        name: feed.name,
        url: validateRssFeedUrl(feed.url).toString(),
        topic: feed.topic,
      });
    }
  }

  const seenExplicitUrls = new Set<string>();
  let positionalIndex = 1;

  for (const rawUrl of requestedUrls) {
    const url = validateRssFeedUrl(rawUrl).toString();

    if (seenExplicitUrls.has(url)) {
      throw new Error(URL_LIST_ERROR);
    }

    seenExplicitUrls.add(url);

    if (seenUrls.has(url)) {
      continue;
    }

    addFeed(selected, seenIds, seenUrls, {
      id: `feed-${positionalIndex}`,
      url,
    });
    positionalIndex += 1;
  }

  if (selected.length === 0 || selected.length > MAX_RSS_FEEDS) {
    throw new Error(
      requestedIds === undefined
        ? URL_LIST_ERROR
        : "RSS feeds must contain 1 to 16 unique entries.",
    );
  }

  return selected;
}

function addFeed(
  selected: ResolvedRssFeed[],
  seenIds: Set<string>,
  seenUrls: Set<string>,
  feed: ResolvedRssFeed,
): void {
  if (seenIds.has(feed.id) || seenUrls.has(feed.url)) {
    throw new Error("RSS feed IDs and URLs must be unique.");
  }

  seenIds.add(feed.id);
  seenUrls.add(feed.url);
  selected.push(feed);
}

function splitConfigList(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
