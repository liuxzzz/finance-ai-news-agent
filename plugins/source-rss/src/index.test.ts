import { createHash } from "node:crypto";
import { createServer } from "node:http";

import type {
  RawSourceItemRecord,
  RecordSourceCollectionInput,
  SourceAuditStore,
  SourceRunRecord,
} from "@finance-ai-news-agent/plugin-sdk";
import { describe, expect, it } from "vitest";

import { RssNewsGateway, validateRssFeedUrl } from "./index.js";

const FEED_NOW = Date.parse("2026-08-04T12:00:00.000Z");
const RSS_DATE_FEED = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Dates</title>
    <item>
      <title>Published only</title>
      <link>https://example.com/published</link>
      <published>2026-08-04T09:00:00.000Z</published>
    </item>
    <item>
      <title>Updated only</title>
      <link>https://example.com/updated</link>
      <updated>2026-08-04T08:00:00.000Z</updated>
    </item>
    <item>
      <title>Date only</title>
      <link>https://example.com/date</link>
      <date>2026-08-04T07:00:00.000Z</date>
    </item>
    <item>
      <title>Dublin core only</title>
      <link>https://example.com/dc</link>
      <dc:date>2026-08-04T06:00:00.000Z</dc:date>
    </item>
    <item>
      <title>PubDate wins</title>
      <link>https://example.com/pub</link>
      <pubDate>Mon, 03 Aug 2026 08:00:00 GMT</pubDate>
      <published>2026-08-04T09:00:00.000Z</published>
    </item>
    <item>
      <title>Bad pubDate valid dc</title>
      <link>https://example.com/bad-pub</link>
      <pubDate>not-a-date</pubDate>
      <dc:date>2026-08-04T05:00:00.000Z</dc:date>
    </item>
    <item>
      <title>Both dates</title>
      <link>https://example.com/both</link>
      <dc:date>2026-08-03T09:00:00.000Z</dc:date>
      <date>2026-08-04T09:00:00.000Z</date>
    </item>
    <item>
      <title>Standard pubDate</title>
      <link>https://example.com/standard</link>
      <pubDate>Tue, 04 Aug 2026 11:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Stale published</title>
      <link>https://example.com/stale</link>
      <published>2026-07-01T10:00:00.000Z</published>
    </item>
    <item>
      <title>Far future updated</title>
      <link>https://example.com/future</link>
      <updated>2099-01-01T00:00:00.000Z</updated>
    </item>
  </channel>
</rss>`;
const ATOM_DATE_FEED = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <title>Atom dates</title>
  <entry>
    <title>Atom updated attribute</title>
    <id>https://example.com/atom-updated</id>
    <link href="https://example.com/atom-updated"/>
    <updated type="text">2026-08-04T10:00:00.000Z</updated>
  </entry>
  <entry>
    <title>Atom dublin core</title>
    <id>https://example.com/atom-dc</id>
    <link href="https://example.com/atom-dc"/>
    <dc:date>2026-08-04T04:00:00.000Z</dc:date>
  </entry>
  <entry>
    <title>Atom published preferred</title>
    <id>https://example.com/atom-published</id>
    <link href="https://example.com/atom-published"/>
    <published>2026-08-04T03:00:00.000Z</published>
    <updated>2026-08-04T02:00:00.000Z</updated>
  </entry>
</feed>`;
const ATOM_LINK_FEED = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom links</title>
  <entry>
    <title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">AI <em>chips</em> &amp; rates</div></title>
    <id>https://example.com/permalink</id>
    <updated>2026-08-04T10:00:00.000Z</updated>
    <link rel="self" type="application/atom+xml" href="https://example.com/feed/self"/>
    <link rel="enclosure" type="audio/mpeg" href="https://cdn.example/ep.mp3" length="10"/>
    <link rel="alternate" type="application/atom+xml" href="https://example.com/article.atom"/>
    <link rel="alternate" type="text/html" href="https://example.com/article"/>
    <content type="html">&lt;p&gt;Body &amp; more&lt;/p&gt;</content>
  </entry>
  <entry>
    <title>Enclosure only</title>
    <id>https://example.com/permalink-enc</id>
    <updated>2026-08-04T09:00:00.000Z</updated>
    <link rel="enclosure" type="video/mp4" href="https://cdn.example/only.mp4"/>
  </entry>
  <entry>
    <title>Related beats image</title>
    <id>tag:example,2026:img</id>
    <updated>2026-08-04T08:30:00.000Z</updated>
    <link rel="enclosure" type="image/jpeg" href="https://cdn.example/photo.jpg"/>
    <link rel="related" type="text/html" href="https://example.com/related"/>
  </entry>
</feed>`;
const RSS_LINK_FEED = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>RSS links</title>
    <item>
      <title>Attribute link</title>
      <link href="https://example.com/attr-link" rel="alternate"/>
      <guid isPermaLink="false">https://example.com/not-permalink</guid>
      <pubDate>Tue, 04 Aug 2026 11:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Article beats enclosure</title>
      <link>https://example.com/rss-article</link>
      <guid>https://example.com/rss-article</guid>
      <enclosure url="https://cdn.example/rss.mp3" type="audio/mpeg" length="5"/>
      <pubDate>Tue, 04 Aug 2026 10:30:00 GMT</pubDate>
    </item>
    <item>
      <title>Non permalink guid</title>
      <guid isPermaLink="false">https://example.com/secret</guid>
      <pubDate>Tue, 04 Aug 2026 09:30:00 GMT</pubDate>
    </item>
    <item>
      <title>Permalink guid</title>
      <guid>https://example.com/default-guid</guid>
      <pubDate>Tue, 04 Aug 2026 08:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;
// rss-parser 3.13 throws on these Atom shapes before any item is returned:
// text, CDATA, whitespace, and empty <link> nodes hit getLink's $.rel, and a
// bare unparseable <published> or <updated> calls Date.toISOString.
const ATOM_TOLERANCE_FEED = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Tolerant Atom</title>
  <link>https://example.com/site</link>
  <entry>
    <title>Href control</title>
    <id>https://example.com/href</id>
    <updated>2026-08-04T11:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://example.com/href"/>
  </entry>
  <entry>
    <title>Text link</title>
    <id>urn:text</id>
    <updated>2026-08-04T10:00:00Z</updated>
    <link>https://example.com/text</link>
  </entry>
  <entry>
    <title>CDATA link</title>
    <id>urn:cdata</id>
    <updated>2026-08-04T09:30:00Z</updated>
    <link><![CDATA[https://example.com/cdata]]></link>
  </entry>
  <entry>
    <title>Whitespace link</title>
    <id>urn:ws</id>
    <updated>2026-08-04T09:00:00Z</updated>
    <link>
      https://example.com/whitespace
    </link>
  </entry>
  <entry>
    <title>Text before enclosure</title>
    <id>urn:mix</id>
    <updated>2026-08-04T08:30:00Z</updated>
    <link>https://example.com/mixed-text</link>
    <link rel="enclosure" type="audio/mpeg" href="https://cdn.example/mixed.mp3"/>
  </entry>
  <entry>
    <title>Empty link uses id</title>
    <id>https://example.com/empty-id</id>
    <updated>2026-08-04T08:00:00Z</updated>
    <link></link>
  </entry>
  <entry>
    <title>Bad published keeps updated</title>
    <id>urn:dates</id>
    <published>not-a-date</published>
    <updated>2026-08-04T07:00:00Z</updated>
    <link href="https://example.com/recovered-date"/>
  </entry>
  <entry>
    <title>Blank updated dropped</title>
    <id>urn:blank</id>
    <updated>   </updated>
    <link href="https://example.com/blank-date"/>
  </entry>
  <entry>
    <title>Relative text link</title>
    <id>urn:rel</id>
    <updated>2026-08-04T06:00:00Z</updated>
    <link>/p/relative-atom</link>
  </entry>
</feed>`;

// Shapes produced by rss-parser 3.13, Node sockets, and fetch. See the retry
// tests below for which of these are transient.
const TRANSIENT_FEED_FAILURES = [
  { label: "HTTP 408", failure: new Error("Status code 408") },
  { label: "HTTP 429", failure: new Error("Status code 429") },
  { label: "HTTP 500", failure: new Error("Status code 500") },
  { label: "HTTP 502", failure: new Error("Status code 502") },
  { label: "HTTP 503", failure: new Error("Status code 503") },
  { label: "HTTP 504", failure: new Error("Status code 504") },
  { label: "HTTP 520", failure: new Error("Status code 520") },
  { label: "HTTP 521", failure: new Error("Status code 521") },
  { label: "HTTP 522", failure: new Error("Status code 522") },
  { label: "HTTP 523", failure: new Error("Status code 523") },
  { label: "HTTP 524", failure: new Error("Status code 524") },
  {
    label: "status property 429",
    failure: Object.assign(new Error("rate limited"), { status: 429 }),
  },
  { label: "rss-parser timeout", failure: new Error("Request timed out after 5000ms") },
  { label: "ECONNRESET", failure: withCode("read ECONNRESET", "ECONNRESET") },
  { label: "ETIMEDOUT", failure: withCode("connect ETIMEDOUT 203.0.113.8:443", "ETIMEDOUT") },
  {
    label: "ECONNREFUSED",
    failure: withCode("connect ECONNREFUSED 203.0.113.8:443", "ECONNREFUSED"),
  },
  { label: "ENOTFOUND", failure: withCode("getaddrinfo ENOTFOUND flaky.example", "ENOTFOUND") },
  { label: "EAI_AGAIN", failure: withCode("getaddrinfo EAI_AGAIN flaky.example", "EAI_AGAIN") },
  { label: "ECONNABORTED", failure: withCode("connection aborted", "ECONNABORTED") },
  { label: "ENETUNREACH", failure: withCode("network unreachable", "ENETUNREACH") },
  { label: "EHOSTUNREACH", failure: withCode("host unreachable", "EHOSTUNREACH") },
  { label: "EPIPE", failure: withCode("broken pipe", "EPIPE") },
  {
    label: "UND_ERR_CONNECT_TIMEOUT",
    failure: withCode("undici failure", "UND_ERR_CONNECT_TIMEOUT"),
  },
  {
    label: "UND_ERR_HEADERS_TIMEOUT",
    failure: withCode("undici failure", "UND_ERR_HEADERS_TIMEOUT"),
  },
  { label: "UND_ERR_BODY_TIMEOUT", failure: withCode("undici failure", "UND_ERR_BODY_TIMEOUT") },
  { label: "UND_ERR_SOCKET", failure: withCode("undici failure", "UND_ERR_SOCKET") },
  { label: "ECONNRESET message only", failure: new Error("read ECONNRESET") },
  { label: "socket hang up", failure: new Error("socket hang up") },
  {
    label: "response status 503",
    failure: Object.assign(new Error("upstream unavailable"), { response: { status: 503 } }),
  },
  { label: "AbortError", failure: namedError("AbortError", "The operation was aborted") },
  {
    label: "TimeoutError",
    failure: namedError("TimeoutError", "The operation was aborted due to timeout"),
  },
  { label: "fetch TypeError", failure: new TypeError("fetch failed") },
  {
    label: "fetch cause ECONNREFUSED",
    failure: Object.assign(new Error("fetch failed"), {
      cause: withCode("connect ECONNREFUSED 127.0.0.1:443", "ECONNREFUSED"),
    }),
  },
  {
    label: "unclosed root",
    failure: new Error("Unclosed root tag\nLine: 12\nColumn: 0\nChar: "),
  },
  {
    label: "unclosed xml",
    failure: new Error("Unclosed xml tag\nLine: 4\nColumn: 1\nChar: <"),
  },
  {
    label: "unexpected close tag",
    failure: new Error("Unexpected close tag\nLine: 2\nColumn: 3\nChar: >"),
  },
  { label: "no root element", failure: new Error("No root element found") },
  {
    label: "unexpected end",
    failure: new Error("Unexpected end\nLine: 8\nColumn: 0\nChar: "),
  },
];

const NON_TRANSIENT_FEED_FAILURES = [
  { label: "HTTP 400", failure: new Error("Status code 400") },
  { label: "HTTP 401", failure: new Error("Status code 401") },
  { label: "HTTP 403", failure: new Error("Status code 403") },
  { label: "HTTP 404", failure: new Error("Status code 404") },
  { label: "HTTP 410", failure: new Error("Status code 410") },
  { label: "status property 404", failure: Object.assign(new Error("missing"), { status: 404 }) },
  { label: "redirect cap", failure: new Error("Too many redirects") },
  { label: "empty XML", failure: new Error("Unable to parse XML.") },
  { label: "unrecognized feed", failure: new Error("Feed not recognized as RSS 1 or 2.") },
  {
    label: "unrecognized rss version",
    failure: new Error("Default RSS version not recognized."),
  },
  {
    label: "xml2js syntax error",
    failure: new Error("Non-whitespace before first tag.\nLine: 0\nColumn: 1\nChar: <"),
  },
  {
    label: "invalid character",
    failure: new Error("Invalid character in entity name\nLine: 1\nColumn: 4\nChar: &"),
  },
  {
    label: "attribute without value",
    failure: new Error("Attribute without value\nLine: 3\nColumn: 8\nChar: >"),
  },
  { label: "application error", failure: new Error("feed unavailable") },
];

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("RSS news gateway", () => {
  it("fetches configured feeds, ranks matching items, and returns normalized evidence", async () => {
    let requests = 0;
    const gateway = new RssNewsGateway({
      feeds: [{ id: "36kr", name: "36氪", url: "https://36kr.com/feed" }],
      now: () => Date.parse("2026-08-04T12:00:00.000Z"),
      parseFeed: async () => {
        requests += 1;
        return {
          title: "36氪",
          items: [
            {
              title: "普通公司动态",
              link: "https://36kr.com/p/older",
              pubDate: "Mon, 03 Aug 2026 08:00:00 GMT",
              contentSnippet: "普通商业新闻",
            },
            {
              title: "AI 芯片公司发布新产品",
              link: "https://36kr.com/p/ai-chip",
              isoDate: "2026-08-04T09:00:00.000Z",
              content: "<p>新产品用于 AI 推理。</p>",
            },
          ],
        };
      },
    });

    const result = await gateway.callTool({
      id: "call-1",
      name: "search_news",
      arguments: { query: "AI 芯片", limit: 1 },
    });

    expect(result.isError).toBe(false);
    expect(result.content).toEqual({
      items: [
        {
          id: expect.stringMatching(/^rss-[a-f0-9]{24}$/),
          title: "AI 芯片公司发布新产品",
          url: "https://36kr.com/p/ai-chip",
          excerpt: "新产品用于 AI 推理。",
          source: "36氪",
          sourceId: "36kr",
          publishedAt: "2026-08-04T09:00:00.000Z",
        },
      ],
    });

    await gateway.callTool({
      id: "call-2",
      name: "search_news",
      arguments: { query: "公司", limit: 2 },
    });
    expect(requests).toBe(1);
  });

  it("continues when one feed fails and falls back to latest items without keyword matches", async () => {
    const gateway = new RssNewsGateway({
      feeds: [
        { id: "broken", url: "https://broken.example/feed" },
        { id: "working", url: "https://working.example/feed" },
      ],
      now: () => Date.parse("2026-08-04T12:00:00.000Z"),
      parseFeed: async (url) => {
        if (url.includes("broken")) {
          throw new Error("network unavailable");
        }

        return {
          title: "Working feed",
          items: [
            {
              title: "Newest item",
              link: "https://working.example/newest",
              pubDate: "2026-08-04T10:00:00Z",
            },
            {
              title: "Older item",
              link: "https://working.example/older",
              pubDate: "2026-08-03T10:00:00Z",
            },
          ],
        };
      },
    });

    const result = await gateway.callTool({
      id: "call-1",
      name: "search_news",
      arguments: { query: "unmatched keyword", limit: 1 },
    });

    expect(result).toEqual({
      content: {
        items: [expect.objectContaining({ title: "Newest item" })],
      },
      isError: false,
    });
  });

  it("balances sources, filters stale items, and bounds excerpts before model use", async () => {
    const longExcerpt = "长".repeat(2_000);
    const gateway = new RssNewsGateway({
      feeds: [
        { id: "source-a", name: "Source A", url: "https://a.example/feed" },
        { id: "source-b", name: "Source B", url: "https://b.example/feed" },
        { id: "source-c", name: "Source C", url: "https://c.example/feed" },
      ],
      maxItemAgeHours: 24,
      maxExcerptChars: 500,
      minimumResultCount: 6,
      now: () => Date.parse("2026-08-04T12:00:00.000Z"),
      parseFeed: async (url) => {
        const source = new URL(url).hostname[0];
        return {
          items: [
            {
              title: `${source} AI latest`,
              link: `https://${source}.example/latest`,
              pubDate: "2026-08-04T11:00:00Z",
              contentSnippet: longExcerpt,
            },
            {
              title: `${source} AI second`,
              link: `https://${source}.example/second`,
              pubDate: "2026-08-04T10:00:00Z",
              contentSnippet: "second",
            },
            {
              title: `${source} stale`,
              link: `https://${source}.example/stale`,
              pubDate: "2026-07-01T10:00:00Z",
              contentSnippet: "stale AI item",
            },
          ],
        };
      },
    });

    const result = await gateway.callTool({
      id: "balanced",
      name: "search_news",
      arguments: { query: "AI", limit: 1 },
    });
    const items = (
      result.content as { items: Array<{ source: string; excerpt: string; url: string }> }
    ).items;

    expect(items).toHaveLength(6);
    expect(
      items
        .slice(0, 3)
        .map((item) => item.source)
        .sort(),
    ).toEqual(["Source A", "Source B", "Source C"]);
    expect(items.filter((item) => item.source === "Source A")).toHaveLength(2);
    expect(items.some((item) => item.url.endsWith("/stale"))).toBe(false);
    expect(Math.max(...items.map((item) => item.excerpt.length))).toBe(500);
  });

  it("rejects model-selected URLs and unsafe configured feed URLs", async () => {
    const gateway = new RssNewsGateway({
      feeds: [{ id: "test", url: "https://example.com/feed" }],
      parseFeed: async () => ({ items: [] }),
    });

    await expect(
      gateway.callTool({
        id: "call-1",
        name: "search_news",
        arguments: { query: "AI", limit: 2, url: "https://attacker.example/feed" },
      }),
    ).rejects.toThrow("Invalid arguments");
    expect(() => validateRssFeedUrl("http://example.com/feed")).toThrow("must use HTTPS");
  });

  it("audits successful and failed sources with their raw parsed items", async () => {
    const audit = new RecordingSourceAudit();
    const gateway = new RssNewsGateway({
      feeds: [
        { id: "working", url: "https://working.example/feed" },
        { id: "broken", url: "https://broken.example/feed" },
      ],
      now: () => Date.parse("2026-08-04T12:00:00.000Z"),
      generateId: sequentialIds(),
      sourceAudit: audit,
      parseFeed: async (url) => {
        if (url.includes("broken")) {
          throw new Error("feed unavailable");
        }

        return {
          title: "Working",
          items: [
            {
              guid: "external-1",
              title: "AI update",
              link: "https://working.example/article",
              pubDate: "2026-08-04T11:00:00Z",
              contentSnippet: "Evidence text",
            },
          ],
        };
      },
    });

    const result = await gateway.callTool(
      {
        id: "audited",
        name: "search_news",
        arguments: { query: "AI", limit: 5 },
      },
      { runId: "run-1" },
    );

    expect(result.isError).toBe(false);
    expect(audit.collections).toHaveLength(2);
    expect(audit.collections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run-1",
          sourceId: "working",
          status: "succeeded",
          itemCount: 1,
          items: [
            expect.objectContaining({
              externalId: "external-1",
              url: "https://working.example/article",
            }),
          ],
        }),
        expect.objectContaining({
          runId: "run-1",
          sourceId: "broken",
          status: "failed",
          itemCount: 0,
          error: expect.objectContaining({ message: "feed unavailable" }),
          items: [],
        }),
      ]),
    );
  });

  it("resolves relative article links and falls back to absolute permalink guids", async () => {
    const gateway = new RssNewsGateway({
      feeds: [{ id: "36kr", name: "36氪", url: "https://36kr.com/feed" }],
      now: () => Date.parse("2026-08-04T12:00:00.000Z"),
      parseFeed: async () => ({
        items: [
          {
            title: "相对链接稿件",
            link: "/p/relative-ai",
            isoDate: "2026-08-04T09:00:00.000Z",
          },
          {
            title: "协议相对稿件",
            link: "//cdn.36kr.com/p/protocol",
            isoDate: "2026-08-04T08:00:00.000Z",
          },
          {
            title: "只有永久链接",
            guid: "https://36kr.com/p/guid-only",
            isoDate: "2026-08-04T07:00:00.000Z",
          },
          {
            title: "危险链接被忽略",
            link: "javascript:alert(1)",
            guid: "opaque-guid",
            isoDate: "2026-08-04T06:00:00.000Z",
          },
        ],
      }),
    });

    const result = await gateway.callTool({
      id: "links",
      name: "search_news",
      arguments: { query: "unmatched", limit: 10 },
    });
    const items = (result.content as { items: Array<{ title: string; url: string }> }).items;

    expect(items.map((item) => item.url)).toEqual([
      "https://36kr.com/p/relative-ai",
      "https://cdn.36kr.com/p/protocol",
      "https://36kr.com/p/guid-only",
    ]);
    expect(items.map((item) => item.title)).not.toContain("危险链接被忽略");
  });

  it("decodes numeric HTML entities before ranking and model use", async () => {
    const gateway = new RssNewsGateway({
      feeds: [{ id: "sec-press", name: "SEC", url: "https://www.sec.gov/news/pressreleases.rss" }],
      now: () => Date.parse("2026-08-04T12:00:00.000Z"),
      parseFeed: async () => ({
        items: [
          {
            title: "&#20013;&#x6587; &#65;I &#39;芯片&#39;",
            link: "https://www.sec.gov/news/press-release/ai",
            isoDate: "2026-08-04T09:00:00.000Z",
            contentSnippet: "增长 &gt; 10&#160;%",
          },
        ],
      }),
    });

    const result = await gateway.callTool({
      id: "entities",
      name: "search_news",
      arguments: { query: "中文", limit: 1 },
    });

    expect(result.content).toEqual({
      items: [
        expect.objectContaining({
          title: "中文 AI '芯片'",
          excerpt: "增长 > 10 %",
        }),
      ],
    });
  });

  it("collapses tracking parameters and fragments before ranking", async () => {
    const gateway = new RssNewsGateway({
      feeds: [{ id: "sec-press", url: "https://www.sec.gov/news/pressreleases.rss" }],
      now: () => Date.parse("2026-08-04T12:00:00.000Z"),
      parseFeed: async () => ({
        items: [
          {
            title: "AI rule older copy",
            link: "https://www.sec.gov/news/press-release/ai-rule?utm_source=rss&id=7#body",
            isoDate: "2026-08-04T08:00:00.000Z",
          },
          {
            title: "AI rule latest copy",
            link: "https://www.sec.gov/news/press-release/ai-rule?id=7&utm_medium=feed",
            isoDate: "2026-08-04T10:00:00.000Z",
          },
          {
            title: "Separate filing",
            link: "https://www.sec.gov/news/press-release/other?ref=rss",
            isoDate: "2026-08-04T09:00:00.000Z",
          },
        ],
      }),
    });

    const result = await gateway.callTool({
      id: "tracked",
      name: "search_news",
      arguments: { query: "unmatched", limit: 5 },
    });
    const items = (result.content as { items: Array<{ title: string; url: string }> }).items;

    expect(items).toEqual([
      expect.objectContaining({
        title: "AI rule latest copy",
        url: "https://www.sec.gov/news/press-release/ai-rule?id=7",
      }),
      expect.objectContaining({
        title: "Separate filing",
        url: "https://www.sec.gov/news/press-release/other",
      }),
    ]);
  });

  it("drops items dated beyond the allowed clock skew", async () => {
    const gateway = new RssNewsGateway({
      feeds: [{ id: "sec-press", url: "https://www.sec.gov/news/pressreleases.rss" }],
      now: () => Date.parse("2026-08-04T12:00:00.000Z"),
      parseFeed: async () => ({
        items: [
          {
            title: "Current filing",
            link: "https://www.sec.gov/news/press-release/current",
            isoDate: "2026-08-04T11:00:00.000Z",
          },
          {
            title: "Slightly ahead filing",
            link: "https://www.sec.gov/news/press-release/ahead",
            isoDate: "2026-08-04T14:00:00.000Z",
          },
          {
            title: "Tomorrow filing",
            link: "https://www.sec.gov/news/press-release/tomorrow",
            isoDate: "2026-08-05T12:00:00.000Z",
          },
          {
            title: "Far future filing",
            link: "https://www.sec.gov/news/press-release/future",
            isoDate: "2099-01-01T00:00:00.000Z",
          },
        ],
      }),
    });

    const result = await gateway.callTool({
      id: "future",
      name: "search_news",
      arguments: { query: "filing", limit: 10 },
    });
    const items = (result.content as { items: Array<{ title: string }> }).items;

    expect(items.map((item) => item.title)).toEqual(["Slightly ahead filing", "Current filing"]);
  });

  // rss-parser 3.13 parseURL does not set status or statusCode. HTTP failures
  // are `Error` messages `Status code <n>` (retry 408/429/500/502/503/504 and
  // 520–524; other statuses, including 401/403/404/410, are final). Timeouts are
  // `Request timed out after <ms>ms`. Socket failures reject the Node error
  // (`ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`,
  // `ECONNABORTED`, `ENETUNREACH`, `EHOSTUNREACH`, `EPIPE`, and undici
  // `UND_ERR_*` timeout/socket codes), matched from `code` or the message, or
  // an AbortError / TimeoutError / fetch TypeError. A code nested on `cause`
  // still counts. A body that stops before the root closes (`Unclosed root tag`,
  // `Unclosed xml tag`, `Unexpected close tag`, `No root element`, `Unexpected end`)
  // is retried once. `Unable to parse XML.`, `Feed not recognized as RSS 1 or 2.`,
  // `Default RSS version not recognized.`, non-whitespace before the first tag,
  // invalid characters, attributes without values, and `Too many redirects` are
  // not retried. Other application errors are not retried.
  it.each(TRANSIENT_FEED_FAILURES)(
    "retries a transient $label once and then uses the feed",
    async ({ failure }) => {
      let attempts = 0;
      const delays: number[] = [];
      const gateway = new RssNewsGateway({
        feeds: [{ id: "flaky", name: "Flaky", url: "https://flaky.example/feed" }],
        now: () => FEED_NOW,
        retryDelayMs: 5_000,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
        parseFeed: async () => {
          attempts += 1;

          if (attempts === 1) {
            throw failure;
          }

          return {
            title: "Flaky",
            items: [feedArticle("Recovered AI item", "https://flaky.example/recovered")],
          };
        },
      });
      const startedAt = Date.now();
      const result = await gateway.callTool({
        id: "retry-ok",
        name: "search_news",
        arguments: { query: "AI", limit: 5 },
      });

      expect(attempts).toBe(2);
      expect(delays).toEqual([5_000]);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(result).toEqual({
        content: {
          items: [expect.objectContaining({ title: "Recovered AI item", sourceId: "flaky" })],
        },
        isError: false,
      });
    },
  );

  it("audits a feed as succeeded when the single retry recovers", async () => {
    let attempts = 0;
    const audit = new RecordingSourceAudit();
    const gateway = new RssNewsGateway({
      feeds: [{ id: "flaky", name: "Flaky", url: "https://flaky.example/feed" }],
      now: () => FEED_NOW,
      generateId: sequentialIds(),
      sourceAudit: audit,
      sleep: async () => undefined,
      parseFeed: async () => {
        attempts += 1;

        if (attempts === 1) {
          throw new Error("Status code 429");
        }

        return {
          title: "Flaky",
          items: [feedArticle("Recovered AI item", "https://flaky.example/recovered")],
        };
      },
    });

    const result = await gateway.callTool(
      {
        id: "retry-audit",
        name: "search_news",
        arguments: { query: "AI", limit: 5 },
      },
      { runId: "run-retry" },
    );

    expect(attempts).toBe(2);
    expect(result.isError).toBe(false);
    expect(audit.collections).toEqual([
      expect.objectContaining({
        runId: "run-retry",
        sourceId: "flaky",
        status: "succeeded",
        itemCount: 1,
        error: null,
      }),
    ]);
  });

  it("audits one succeeded row when a truncated feed recovers on the single retry", async () => {
    let attempts = 0;
    const audit = new RecordingSourceAudit();
    const gateway = new RssNewsGateway({
      feeds: [{ id: "flaky", name: "Flaky", url: "https://flaky.example/feed" }],
      now: () => FEED_NOW,
      generateId: sequentialIds(),
      sourceAudit: audit,
      sleep: async () => undefined,
      parseFeed: async () => {
        attempts += 1;

        if (attempts === 1) {
          throw new Error("Unclosed root tag\nLine: 12\nColumn: 0\nChar: ");
        }

        return {
          title: "Flaky",
          items: [feedArticle("Recovered AI item", "https://flaky.example/recovered")],
        };
      },
    });

    const result = await gateway.callTool(
      {
        id: "truncated-audit",
        name: "search_news",
        arguments: { query: "AI", limit: 5 },
      },
      { runId: "run-truncated" },
    );

    expect(attempts).toBe(2);
    expect(result.isError).toBe(false);
    expect(audit.collections).toEqual([
      expect.objectContaining({
        runId: "run-truncated",
        sourceId: "flaky",
        status: "succeeded",
        itemCount: 1,
        error: null,
        disposition: expect.objectContaining({ outcome: "available", fresh: 1 }),
      }),
    ]);
  });

  it("does not retry a malformed feed and records one request_failed row", async () => {
    let attempts = 0;
    const audit = new RecordingSourceAudit();
    const gateway = new RssNewsGateway({
      feeds: [
        { id: "broken", url: "https://broken.example/feed" },
        { id: "working", name: "Working", url: "https://working.example/feed" },
      ],
      now: () => FEED_NOW,
      generateId: sequentialIds(),
      sourceAudit: audit,
      sleep: async () => undefined,
      parseFeed: async (url) => {
        if (url.includes("broken")) {
          attempts += 1;
          throw new Error("Feed not recognized as RSS 1 or 2.");
        }

        return {
          title: "Working",
          items: [feedArticle("Working AI item", "https://working.example/ai")],
        };
      },
    });

    const result = await gateway.callTool(
      {
        id: "malformed-audit",
        name: "search_news",
        arguments: { query: "AI", limit: 5 },
      },
      { runId: "run-malformed" },
    );

    expect(attempts).toBe(1);
    expect(result.isError).toBe(false);
    expect(audit.collections).toHaveLength(2);
    expect(audit.collections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "broken",
          status: "failed",
          itemCount: 0,
          disposition: expect.objectContaining({ outcome: "request_failed" }),
        }),
        expect.objectContaining({
          sourceId: "working",
          status: "succeeded",
          disposition: expect.objectContaining({ outcome: "available" }),
        }),
      ]),
    );
  });

  it("fails a feed once after two transient errors and keeps the other feeds", async () => {
    const attempts = new Map<string, number>();
    const audit = new RecordingSourceAudit();
    const gateway = new RssNewsGateway({
      feeds: [
        { id: "flaky", url: "https://flaky.example/feed" },
        { id: "working", name: "Working", url: "https://working.example/feed" },
      ],
      now: () => FEED_NOW,
      generateId: sequentialIds(),
      sourceAudit: audit,
      retryDelayMs: 5_000,
      sleep: async () => undefined,
      parseFeed: async (url) => {
        attempts.set(url, (attempts.get(url) ?? 0) + 1);

        if (url.includes("flaky")) {
          throw withCode("read ECONNRESET", "ECONNRESET");
        }

        return {
          title: "Working",
          items: [feedArticle("Working AI item", "https://working.example/ai")],
        };
      },
    });
    const startedAt = Date.now();
    const result = await gateway.callTool(
      {
        id: "partial",
        name: "search_news",
        arguments: { query: "AI", limit: 5 },
      },
      { runId: "run-partial" },
    );

    expect(attempts.get("https://flaky.example/feed")).toBe(2);
    expect(attempts.get("https://working.example/feed")).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result).toEqual({
      content: {
        items: [expect.objectContaining({ title: "Working AI item", sourceId: "working" })],
      },
      isError: false,
    });
    expect(audit.collections).toHaveLength(2);
    expect(audit.collections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "working",
          status: "succeeded",
          itemCount: 1,
        }),
        expect.objectContaining({
          sourceId: "flaky",
          status: "failed",
          itemCount: 0,
          error: expect.objectContaining({ message: "read ECONNRESET" }),
          items: [],
        }),
      ]),
    );
    expect(audit.collections.filter((collection) => collection.status === "failed")).toHaveLength(
      1,
    );
  });

  it("keeps the all-feeds-failed result when every transient retry is exhausted", async () => {
    const attempts = new Map<string, number>();
    const audit = new RecordingSourceAudit();
    const gateway = new RssNewsGateway({
      feeds: [
        { id: "left", url: "https://left.example/feed" },
        { id: "right", url: "https://right.example/feed" },
      ],
      now: () => FEED_NOW,
      generateId: sequentialIds(),
      sourceAudit: audit,
      sleep: async () => undefined,
      parseFeed: async (url) => {
        attempts.set(url, (attempts.get(url) ?? 0) + 1);
        throw new Error("Request timed out after 5000ms");
      },
    });

    const result = await gateway.callTool(
      {
        id: "all-failed",
        name: "search_news",
        arguments: { query: "AI", limit: 5 },
      },
      { runId: "run-all-failed" },
    );

    expect(attempts.get("https://left.example/feed")).toBe(2);
    expect(attempts.get("https://right.example/feed")).toBe(2);
    expect(result).toEqual({
      content: {
        error: "All configured RSS feeds failed: Request timed out after 5000ms",
      },
      isError: true,
    });
    expect(audit.collections).toHaveLength(2);
    expect(audit.collections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: "left", status: "failed", itemCount: 0, items: [] }),
        expect.objectContaining({ sourceId: "right", status: "failed", itemCount: 0, items: [] }),
      ]),
    );
  });

  it.each(NON_TRANSIENT_FEED_FAILURES)(
    "does not retry a non-transient $label",
    async ({ failure }) => {
      let attempts = 0;
      const delays: number[] = [];
      const gateway = new RssNewsGateway({
        feeds: [
          { id: "broken", url: "https://broken.example/feed" },
          { id: "working", name: "Working", url: "https://working.example/feed" },
        ],
        now: () => FEED_NOW,
        retryDelayMs: 5_000,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
        parseFeed: async (url) => {
          if (url.includes("broken")) {
            attempts += 1;
            throw failure;
          }

          return {
            title: "Working",
            items: [feedArticle("Working AI item", "https://working.example/ai")],
          };
        },
      });

      const result = await gateway.callTool({
        id: "no-retry",
        name: "search_news",
        arguments: { query: "AI", limit: 5 },
      });

      expect(attempts).toBe(1);
      expect(delays).toEqual([]);
      expect(result).toEqual({
        content: {
          items: [expect.objectContaining({ title: "Working AI item" })],
        },
        isError: false,
      });
    },
  );

  it("sleeps for the default delay only through the injected timer", async () => {
    const delays: number[] = [];
    const gateway = new RssNewsGateway({
      feeds: [{ id: "flaky", url: "https://flaky.example/feed" }],
      now: () => FEED_NOW,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
      parseFeed: async () => {
        if (delays.length === 0) {
          throw new Error("Request timed out after 5000ms");
        }

        return {
          items: [feedArticle("Recovered AI item", "https://flaky.example/recovered")],
        };
      },
    });
    const startedAt = Date.now();

    await gateway.callTool({
      id: "default-delay",
      name: "search_news",
      arguments: { query: "AI", limit: 1 },
    });

    expect(delays).toEqual([400]);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("keeps items dated only by updated, published, dc:date, dcDate, or date", async () => {
    const gateway = new RssNewsGateway({
      feeds: [
        { id: "dates", name: "Dates", url: "https://dates.example/feed" },
        { id: "broken", url: "https://broken.example/feed" },
      ],
      now: () => FEED_NOW,
      parseFeed: async (url) => {
        if (url.includes("broken")) {
          throw new Error("feed unavailable");
        }

        return {
          items: [
            {
              title: "Updated only",
              link: "https://dates.example/updated",
              updated: "2026-08-04T09:30:00.000Z",
            },
            {
              title: "Published only",
              link: "https://dates.example/published",
              published: "2026-08-04T08:15:00Z",
            },
            {
              title: "Dublin core colon",
              link: "https://dates.example/dc-colon",
              "dc:date": "2026-08-04T07:00:00.000Z",
            },
            {
              title: "Dublin core mapped",
              link: "https://dates.example/dc-mapped",
              dcDate: "2026-08-04T06:00:00.000Z",
            },
            {
              title: "Date element",
              link: "https://dates.example/date",
              date: "Tue, 04 Aug 2026 05:00:00 GMT",
            },
          ],
        };
      },
    });

    const result = await gateway.callTool({
      id: "alternate-dates",
      name: "search_news",
      arguments: { query: "unmatched", limit: 10 },
    });
    const items = (result.content as { items: Array<{ title: string; publishedAt: string }> })
      .items;

    expect(result.isError).toBe(false);
    expect(items).toEqual([
      expect.objectContaining({
        title: "Updated only",
        publishedAt: "2026-08-04T09:30:00.000Z",
      }),
      expect.objectContaining({
        title: "Published only",
        publishedAt: "2026-08-04T08:15:00.000Z",
      }),
      expect.objectContaining({
        title: "Dublin core colon",
        publishedAt: "2026-08-04T07:00:00.000Z",
      }),
      expect.objectContaining({
        title: "Dublin core mapped",
        publishedAt: "2026-08-04T06:00:00.000Z",
      }),
      expect.objectContaining({
        title: "Date element",
        publishedAt: "2026-08-04T05:00:00.000Z",
      }),
    ]);
  });

  it("prefers the first parseable field in isoDate, pubDate, then alternate order", async () => {
    const gateway = new RssNewsGateway({
      feeds: [{ id: "dates", url: "https://dates.example/feed" }],
      now: () => FEED_NOW,
      parseFeed: async () => ({
        items: [
          {
            title: "Iso wins",
            link: "https://dates.example/iso",
            isoDate: "2026-08-04T09:00:00.000Z",
            pubDate: "2026-08-04T08:00:00.000Z",
            published: "2026-08-04T07:00:00.000Z",
            updated: "2026-08-04T06:00:00.000Z",
            "dc:date": "2026-08-04T05:00:00.000Z",
            dcDate: "2026-08-04T04:00:00.000Z",
            date: "2026-08-04T03:00:00.000Z",
          },
          {
            title: "Pub wins",
            link: "https://dates.example/pub",
            isoDate: "not-a-date",
            pubDate: "Mon, 03 Aug 2026 08:00:00 GMT",
            published: "2026-08-04T09:00:00.000Z",
            updated: "2026-08-04T01:00:00.000Z",
          },
          {
            title: "Published after bad prefixes",
            link: "https://dates.example/fallthrough",
            isoDate: "tomorrow",
            pubDate: "yesterday",
            published: "2026-08-04T10:00:00.000Z",
            updated: "2026-08-04T01:00:00.000Z",
            date: "2026-08-04T02:00:00.000Z",
          },
        ],
      }),
    });

    const result = await gateway.callTool({
      id: "date-priority",
      name: "search_news",
      arguments: { query: "unmatched", limit: 10 },
    });
    const items = (result.content as { items: Array<{ title: string; publishedAt: string }> })
      .items;

    expect(items).toEqual([
      expect.objectContaining({
        title: "Published after bad prefixes",
        publishedAt: "2026-08-04T10:00:00.000Z",
      }),
      expect.objectContaining({
        title: "Iso wins",
        publishedAt: "2026-08-04T09:00:00.000Z",
      }),
      expect.objectContaining({
        title: "Pub wins",
        publishedAt: "2026-08-03T08:00:00.000Z",
      }),
    ]);
  });

  it("drops items when every date field is missing or unparseable", async () => {
    const audit = new RecordingSourceAudit();
    const gateway = new RssNewsGateway({
      feeds: [{ id: "dates", url: "https://dates.example/feed" }],
      now: () => FEED_NOW,
      generateId: sequentialIds(),
      sourceAudit: audit,
      parseFeed: async () => ({
        items: [
          { title: "No date", link: "https://dates.example/none" },
          {
            title: "Bad dates",
            link: "https://dates.example/bad",
            isoDate: "not-a-date",
            pubDate: "yesterday",
            published: "nope",
            updated: "",
            "dc:date": "32/13/2026",
            dcDate: "bogus",
            date: "still-no",
          },
          {
            title: "Kept via date",
            link: "https://dates.example/kept",
            date: "2026-08-04T09:00:00.000Z",
            contentSnippet: "Kept",
          },
        ],
      }),
    });

    const result = await gateway.callTool(
      {
        id: "drop-undated",
        name: "search_news",
        arguments: { query: "unmatched", limit: 10 },
      },
      { runId: "run-dates" },
    );
    const items = (result.content as { items: Array<{ title: string }> }).items;

    expect(result.isError).toBe(false);
    expect(items.map((item) => item.title)).toEqual(["Kept via date"]);
    expect(audit.collections).toEqual([
      expect.objectContaining({
        sourceId: "dates",
        status: "succeeded",
        itemCount: 1,
        items: [
          expect.objectContaining({
            title: "Kept via date",
            publishedAt: "2026-08-04T09:00:00.000Z",
            raw: {
              title: "Kept via date",
              link: "https://dates.example/kept",
              date: "2026-08-04T09:00:00.000Z",
              contentSnippet: "Kept",
            },
          }),
        ],
      }),
    ]);
  });

  it("filters stale and future alternate dates with the existing window", async () => {
    const audit = new RecordingSourceAudit();
    const gateway = new RssNewsGateway({
      feeds: [{ id: "dates", url: "https://dates.example/feed" }],
      maxItemAgeHours: 48,
      now: () => FEED_NOW,
      generateId: sequentialIds(),
      sourceAudit: audit,
      parseFeed: async () => ({
        items: [
          {
            title: "Fresh updated",
            link: "https://dates.example/fresh",
            updated: "2026-08-04T11:00:00.000Z",
          },
          {
            title: "Stale published",
            link: "https://dates.example/stale",
            published: "2026-07-01T10:00:00.000Z",
          },
          {
            title: "Within skew",
            link: "https://dates.example/skew",
            dcDate: "2026-08-04T14:00:00.000Z",
          },
          {
            title: "Beyond skew",
            link: "https://dates.example/beyond",
            date: "2026-08-05T12:00:00.000Z",
          },
          {
            title: "Far future",
            link: "https://dates.example/future",
            "dc:date": "2099-01-01T00:00:00.000Z",
          },
        ],
      }),
    });

    const result = await gateway.callTool(
      {
        id: "alternate-window",
        name: "search_news",
        arguments: { query: "unmatched", limit: 10 },
      },
      { runId: "run-window" },
    );
    const items = (result.content as { items: Array<{ title: string }> }).items;

    expect(items.map((item) => item.title)).toEqual(["Within skew", "Fresh updated"]);
    expect(audit.collections[0]?.itemCount).toBe(5);
    expect(audit.collections[0]?.items.map((item) => item.title).sort()).toEqual([
      "Beyond skew",
      "Far future",
      "Fresh updated",
      "Stale published",
      "Within skew",
    ]);
  });

  it("keeps alternate date fields in the raw payload used for the content hash", async () => {
    const audit = new RecordingSourceAudit();
    const gateway = new RssNewsGateway({
      feeds: [{ id: "dates", url: "https://dates.example/feed" }],
      now: () => FEED_NOW,
      generateId: sequentialIds(),
      sourceAudit: audit,
      parseFeed: async () => ({
        items: [
          {
            guid: "ext-date",
            title: "Updated story",
            link: "https://dates.example/story",
            isoDate: "not-a-date",
            published: "also-bad",
            updated: "2026-08-04T09:00:00.000Z",
            contentSnippet: "Evidence",
          },
        ],
      }),
    });

    await gateway.callTool(
      {
        id: "raw-dates",
        name: "search_news",
        arguments: { query: "story", limit: 1 },
      },
      { runId: "run-raw-dates" },
    );
    const raw = {
      title: "Updated story",
      link: "https://dates.example/story",
      guid: "ext-date",
      isoDate: "not-a-date",
      published: "also-bad",
      updated: "2026-08-04T09:00:00.000Z",
      contentSnippet: "Evidence",
    };
    const recorded = audit.collections[0]?.items[0];

    expect(recorded).toEqual(
      expect.objectContaining({
        externalId: "ext-date",
        publishedAt: "2026-08-04T09:00:00.000Z",
        raw,
        contentHash: createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
      }),
    );
  });

  it("reads alternate date fields through the default rss-parser custom fields", async () => {
    const userAgents: string[] = [];
    const server = createServer((request, response) => {
      userAgents.push(request.headers["user-agent"] ?? "");
      const body = request.url?.includes("atom") ? ATOM_DATE_FEED : RSS_DATE_FEED;
      response.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
        connection: "close",
      });
      response.end(body);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();

    if (address === null || typeof address === "string") {
      throw new Error("RSS test server did not bind to a TCP port.");
    }

    try {
      const audit = new RecordingSourceAudit();
      const gateway = new RssNewsGateway({
        feeds: [
          { id: "rss", name: "RSS", url: `http://127.0.0.1:${address.port}/rss` },
          { id: "atom", name: "Atom", url: `http://127.0.0.1:${address.port}/atom` },
        ],
        timeoutMs: 2_000,
        now: () => FEED_NOW,
        generateId: sequentialIds(),
        sourceAudit: audit,
      });
      const result = await gateway.callTool(
        {
          id: "parser-dates",
          name: "search_news",
          arguments: { query: "unmatched", limit: 20 },
        },
        { runId: "run-parser-dates" },
      );
      const items = (result.content as { items: Array<{ title: string; publishedAt: string }> })
        .items;
      const rssAudit = audit.collections.find((collection) => collection.sourceId === "rss");
      const both = rssAudit?.items.find((item) => item.title === "Both dates");
      const standard = rssAudit?.items.find((item) => item.title === "Standard pubDate");
      const badPubDate = rssAudit?.items.find((item) => item.title === "Bad pubDate valid dc");

      expect(result.isError).toBe(false);
      expect(userAgents).toEqual([
        "finance-ai-news-agent (+https://github.com/liuxzzz/finance-ai-news-agent)",
        "finance-ai-news-agent (+https://github.com/liuxzzz/finance-ai-news-agent)",
      ]);
      expect(items.map((item) => [item.title, item.publishedAt]).sort()).toEqual(
        [
          ["Atom dublin core", "2026-08-04T04:00:00.000Z"],
          ["Atom published preferred", "2026-08-04T03:00:00.000Z"],
          ["Atom updated attribute", "2026-08-04T10:00:00.000Z"],
          ["Bad pubDate valid dc", "2026-08-04T05:00:00.000Z"],
          ["Both dates", "2026-08-03T09:00:00.000Z"],
          ["Date only", "2026-08-04T07:00:00.000Z"],
          ["Dublin core only", "2026-08-04T06:00:00.000Z"],
          ["PubDate wins", "2026-08-03T08:00:00.000Z"],
          ["Published only", "2026-08-04T09:00:00.000Z"],
          ["Standard pubDate", "2026-08-04T11:00:00.000Z"],
          ["Updated only", "2026-08-04T08:00:00.000Z"],
        ].sort(),
      );
      expect(items.map((item) => item.title)).not.toContain("Stale published");
      expect(items.map((item) => item.title)).not.toContain("Far future updated");
      expect(rssAudit?.itemCount).toBe(10);
      expect(standard?.raw).toEqual({
        title: "Standard pubDate",
        link: "https://example.com/standard",
        pubDate: "Tue, 04 Aug 2026 11:00:00 GMT",
        isoDate: "2026-08-04T11:00:00.000Z",
      });
      expect(both?.publishedAt).toBe("2026-08-03T09:00:00.000Z");
      expect(both?.raw).toEqual({
        title: "Both dates",
        link: "https://example.com/both",
        isoDate: "2026-08-03T09:00:00.000Z",
        "dc:date": "2026-08-03T09:00:00.000Z",
        dcDate: "2026-08-03T09:00:00.000Z",
        date: "2026-08-04T09:00:00.000Z",
      });
      expect(badPubDate?.raw).toEqual({
        title: "Bad pubDate valid dc",
        link: "https://example.com/bad-pub",
        pubDate: "not-a-date",
        "dc:date": "2026-08-04T05:00:00.000Z",
        dcDate: "2026-08-04T05:00:00.000Z",
        date: "2026-08-04T05:00:00.000Z",
      });
      expect(JSON.stringify(rssAudit?.items)).not.toContain("elementDate");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps structured Atom and RSS links without using audio or video enclosures", async () => {
    const server = createServer((request, response) => {
      const body = request.url?.includes("atom") ? ATOM_LINK_FEED : RSS_LINK_FEED;
      response.writeHead(200, {
        "content-type": "application/rss+xml; charset=utf-8",
        connection: "close",
      });
      response.end(body);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();

    if (address === null || typeof address === "string") {
      throw new Error("RSS test server did not bind to a TCP port.");
    }

    try {
      const audit = new RecordingSourceAudit();
      const gateway = new RssNewsGateway({
        feeds: [
          { id: "rss", name: "RSS", url: `http://127.0.0.1:${address.port}/rss` },
          { id: "atom", name: "Atom", url: `http://127.0.0.1:${address.port}/atom` },
        ],
        timeoutMs: 2_000,
        now: () => FEED_NOW,
        sourceAudit: audit,
      });
      const result = await gateway.callTool(
        {
          id: "parser-links",
          name: "search_news",
          arguments: { query: "unmatched", limit: 10 },
        },
        { runId: "run-parser-links" },
      );
      const items = (result.content as { items: Array<{ title: string; url: string }> }).items;
      const ranked = await gateway.callTool({
        id: "parser-links-rank",
        name: "search_news",
        arguments: { query: "chips", limit: 1 },
      });
      const rssItems = audit.collections.find((collection) => collection.sourceId === "rss")?.items;
      const attribute = rssItems?.find((item) => item.title === "Attribute link");

      expect(result.isError).toBe(false);
      expect(items.map((item) => [item.title, item.url])).toEqual([
        ["Attribute link", "https://example.com/attr-link"],
        ["AI & rates chips", "https://example.com/article"],
        ["Article beats enclosure", "https://example.com/rss-article"],
        ["Enclosure only", "https://example.com/permalink-enc"],
        ["Permalink guid", "https://example.com/default-guid"],
        ["Related beats image", "https://example.com/related"],
      ]);
      expect(items.map((item) => item.url)).not.toContain("https://cdn.example/only.mp4");
      expect(items.map((item) => item.url)).not.toContain("https://cdn.example/ep.mp3");
      expect(items.map((item) => item.url)).not.toContain("https://example.com/article.atom");
      expect(items.map((item) => item.url)).not.toContain("https://cdn.example/photo.jpg");
      expect(items.map((item) => item.title)).not.toContain("Non permalink guid");
      expect(ranked.content).toEqual({
        items: [
          expect.objectContaining({
            title: "AI & rates chips",
            url: "https://example.com/article",
            excerpt: "Body & more",
          }),
        ],
      });
      expect(attribute).toEqual(
        expect.objectContaining({
          url: "https://example.com/attr-link",
          externalId: "https://example.com/not-permalink",
          raw: expect.objectContaining({
            link: "https://example.com/attr-link",
            guid: "https://example.com/not-permalink",
          }),
        }),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("adapts injected object links and xml text instead of dropping the item", async () => {
    const audit = new RecordingSourceAudit();
    const gateway = new RssNewsGateway({
      feeds: [{ id: "structured", url: "https://36kr.com/feed" }],
      now: () => FEED_NOW,
      sourceAudit: audit,
      parseFeed: async () => ({
        title: { _: "Structured Feed", $: { type: "html" } },
        items: [
          {
            title: { _: "Object title", $: { type: "html" } },
            link: [
              {
                $: {
                  rel: "enclosure",
                  type: "audio/mpeg",
                  href: "https://cdn.example/injected.mp3",
                },
              },
              {
                $: {
                  rel: "alternate",
                  type: "application/atom+xml",
                  href: "https://example.com/injected.atom",
                },
              },
              {
                $: {
                  rel: "alternate",
                  type: "text/html",
                  href: "https://example.com/injected",
                },
              },
            ],
            summary: { _: "Object summary", $: { type: "html" } },
            isoDate: "2026-08-04T10:00:00.000Z",
          },
          {
            title: { $: { type: "xhtml" }, div: [{ _: "Nested", em: ["title"] }] },
            link: { $: { href: "/p/object-relative", rel: "alternate" } },
            guid: { _: "https://example.com/ignored-guid", $: { isPermaLink: "false" } },
            isoDate: "2026-08-04T09:00:00.000Z",
          },
          {
            title: "Enclosure object falls back",
            link: {
              href: "https://cdn.example/only.mp3",
              rel: "enclosure",
              type: "audio/mpeg",
            },
            guid: "https://example.com/object-guid",
            isoDate: "2026-08-04T08:00:00.000Z",
          },
          {
            title: "Content object",
            link: "https://example.com/content-object",
            content: { _: "<p>Content body</p>", $: { type: "html" } },
            isoDate: "2026-08-04T07:00:00.000Z",
          },
          {
            title: "Plain string still works",
            link: "https://example.com/plain",
            isoDate: "2026-08-04T06:00:00.000Z",
          },
        ],
      }),
    });

    const result = await gateway.callTool(
      {
        id: "structured-links",
        name: "search_news",
        arguments: { query: "unmatched", limit: 10 },
      },
      { runId: "run-structured-links" },
    );
    const items = (
      result.content as {
        items: Array<{ title: string; url: string; source: string; excerpt: string }>;
      }
    ).items;
    const relative = audit.collections[0]?.items.find((item) => item.title === "Nested title");

    expect(items.map((item) => [item.title, item.url, item.excerpt])).toEqual([
      ["Object title", "https://example.com/injected", "Object summary"],
      ["Nested title", "https://36kr.com/p/object-relative", "Nested title"],
      [
        "Enclosure object falls back",
        "https://example.com/object-guid",
        "Enclosure object falls back",
      ],
      ["Content object", "https://example.com/content-object", "Content body"],
      ["Plain string still works", "https://example.com/plain", "Plain string still works"],
    ]);
    expect(items.every((item) => item.source === "Structured Feed")).toBe(true);
    expect(items.map((item) => item.url)).not.toContain("https://cdn.example/injected.mp3");
    expect(items.map((item) => item.url)).not.toContain("https://example.com/injected.atom");
    expect(relative).toEqual(
      expect.objectContaining({
        externalId: "https://example.com/ignored-guid",
        url: "https://36kr.com/p/object-relative",
      }),
    );
  });

  it("keeps the rest of an Atom feed when a text link or unparseable date would abort rss-parser", async () => {
    const server = createServer((request, response) => {
      const body = request.url?.includes("atom") ? ATOM_TOLERANCE_FEED : "";
      response.writeHead(body.length === 0 ? 404 : 200, {
        "content-type": "application/atom+xml; charset=utf-8",
        connection: "close",
      });
      response.end(body);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();

    if (address === null || typeof address === "string") {
      throw new Error("RSS test server did not bind to a TCP port.");
    }

    try {
      const audit = new RecordingSourceAudit();
      const gateway = new RssNewsGateway({
        feeds: [{ id: "atom", name: "Atom", url: `http://127.0.0.1:${address.port}/atom` }],
        timeoutMs: 2_000,
        now: () => FEED_NOW,
        sourceAudit: audit,
      });
      const result = await gateway.callTool(
        {
          id: "parser-atom-tolerance",
          name: "search_news",
          arguments: { query: "unmatched", limit: 20 },
        },
        { runId: "run-parser-atom-tolerance" },
      );
      const items = (result.content as { items: Array<{ title: string; url: string }> }).items;
      const recovered = audit.collections[0]?.items.find(
        (item) => item.title === "Bad published keeps updated",
      );

      expect(result.isError).toBe(false);
      expect(items.map((item) => [item.title, item.url])).toEqual([
        ["Href control", "https://example.com/href"],
        ["Text link", "https://example.com/text"],
        ["CDATA link", "https://example.com/cdata"],
        ["Whitespace link", "https://example.com/whitespace"],
        ["Text before enclosure", "https://example.com/mixed-text"],
        ["Empty link uses id", "https://example.com/empty-id"],
        ["Bad published keeps updated", "https://example.com/recovered-date"],
        ["Relative text link", `http://127.0.0.1:${address.port}/p/relative-atom`],
      ]);
      expect(items.map((item) => item.url)).not.toContain("https://cdn.example/mixed.mp3");
      expect(items.map((item) => item.title)).not.toContain("Blank updated dropped");
      expect(audit.collections[0]).toEqual(
        expect.objectContaining({
          status: "succeeded",
          itemCount: 8,
          error: null,
          disposition: {
            outcome: "available",
            received: 9,
            normalized: 8,
            fresh: 8,
            dropped: { invalid: 1, stale: 0, future: 0 },
          },
        }),
      );
      expect(recovered?.publishedAt).toBe("2026-08-04T07:00:00.000Z");
      expect(JSON.stringify(recovered?.raw)).not.toContain("not-a-date");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
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
  return () => `source-run-${(value += 1)}`;
}

function feedArticle(title: string, url: string) {
  return {
    title,
    link: url,
    isoDate: "2026-08-04T09:00:00.000Z",
    contentSnippet: title,
  };
}
