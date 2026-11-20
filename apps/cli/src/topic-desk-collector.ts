import { NewsToolResultSchema, TopicCollectionFailedError } from "@finance-ai-news-agent/core";
import type { TopicCollectedItem, TopicNewsCollector } from "@finance-ai-news-agent/core";
import type { TopicFeed, TopicSourceOutcome } from "@finance-ai-news-agent/plugin-sdk";
import { RssNewsGateway } from "@finance-ai-news-agent/source-rss";

/**
 * Topic collection goes through the same RSS gateway as `search_news`.
 * Source audit stays on the daily run ledger; the topic run stores the
 * diagnosis itself so a topic does not invent a daily `runs` row.
 */
export function createRssTopicCollector(): TopicNewsCollector {
  return {
    async collect(input) {
      const gateway = new RssNewsGateway({
        feeds: input.feeds.map(feedConfig),
        maxItemAgeHours: input.windowHours,
        minimumResultCount: 0,
      });
      const diagnosis = await gateway.diagnose();
      const sources: TopicSourceOutcome[] = diagnosis.feeds.map((feed) => ({
        sourceId: feed.sourceId,
        outcome: feed.outcome,
        received: feed.received,
        fresh: feed.fresh,
        error: feed.error,
      }));
      const readableFeeds = diagnosis.summary.feedCount - diagnosis.summary.requestFailed;

      if (readableFeeds === 0) {
        throw new TopicCollectionFailedError("All configured feeds failed.", sources);
      }

      const result = await gateway.callTool(
        {
          id: `topic-desk-${input.runId}`,
          name: "search_news",
          arguments: { query: input.query, limit: 12 },
        },
        { runId: input.runId },
      );

      if (result.isError) {
        const message =
          typeof result.content === "object" &&
          result.content !== null &&
          "error" in result.content &&
          typeof result.content.error === "string"
            ? result.content.error
            : "search_news failed.";
        throw new TopicCollectionFailedError(message, sources);
      }

      const parsed = NewsToolResultSchema.safeParse(result.content);

      if (!parsed.success) {
        throw new TopicCollectionFailedError(
          "search_news returned an unexpected payload.",
          sources,
        );
      }

      const items: TopicCollectedItem[] = parsed.data.items.map((item) => ({
        id: item.id,
        title: item.title,
        url: item.url,
        excerpt: item.excerpt,
        ...(item.source === undefined ? {} : { source: item.source }),
        ...(item.sourceId === undefined ? {} : { sourceId: item.sourceId }),
        ...(item.publishedAt === undefined ? {} : { publishedAt: item.publishedAt }),
      }));
      return { items, sources };
    },
  };
}

function feedConfig(feed: TopicFeed): { id: string; url: string; name?: string } {
  return feed.name === undefined
    ? { id: feed.id, url: feed.url }
    : { id: feed.id, url: feed.url, name: feed.name };
}
