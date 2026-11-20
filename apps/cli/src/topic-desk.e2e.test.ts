import { randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LocalStubBriefingModel,
  TopicDesk,
  type TopicDeskDetail,
  type TopicRecord,
  type TopicRunRecord,
} from "@finance-ai-news-agent/core";
import { FileOutputPlugin } from "@finance-ai-news-agent/output-file";
import {
  createPostgresPool,
  PostgresTopicDeskStore,
  runPostgresMigrations,
} from "@finance-ai-news-agent/storage-postgres";
import { describe, expect, it } from "vitest";

import { createRssTopicCollector } from "./topic-desk-collector.js";
import { startTopicDeskServer, type TopicDeskServer } from "./topic-desk-server.js";

const adminUrl =
  process.env.TOPIC_DESK_ADMIN_URL ?? "postgresql://agent:agent@127.0.0.1:5432/postgres";
const postgresReady = await postgresReachable(adminUrl);

if (!postgresReady && process.env.TOPIC_DESK_REQUIRE_POSTGRES === "1") {
  throw new Error("PostgreSQL is required for the topic desk end-to-end test.");
}

describe.skipIf(!postgresReady)("topic desk end to end", () => {
  it("runs collect, dedupe, failure, recovery, history, and export on postgres", async () => {
    const database = await createIsolatedDatabase(adminUrl);
    const pool = createPostgresPool({ connectionString: database.url });
    const feeds = await startFeedServer();
    const exportDirectory = await mkdtemp(join(tmpdir(), "topic-desk-"));
    const articles: FeedArticle[] = [
      article("rate-hold", "央行维持政策利率", "委员会维持政策利率不变。"),
      article("rate-path", "利率路径继续被讨论", "分析师继续讨论政策利率路径。"),
    ];
    feeds.articles = articles;
    let server: TopicDeskServer | undefined;

    try {
      await runPostgresMigrations(pool, {
        migrationsDirectory: fileURLToPath(new URL("../../../db/migrations", import.meta.url)),
      });
      server = await startDesk(pool, exportDirectory, 1);
      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("还没有专题");

      const health = await readJson<{ mode: string; modelLabel: string; notifications: string }>(
        server.url,
        "/api/health",
      );
      expect(health.mode).toBe("e2e");
      expect(health.modelLabel).toContain("local-stub");
      expect(health.notifications).toBe("disabled");

      const topic = await sendJson<TopicRecord>(server.url, "/api/topics", {
        name: "利率专题",
        keywords: ["利率"],
        windowHours: 48,
        lookbackDays: 7,
        feedIds: [],
        customFeeds: [
          { id: "rates", url: `${feeds.url}/rates.xml`, name: "利率夹具" },
          { id: "noise", url: `${feeds.url}/noise.xml`, name: "无关夹具" },
          { id: "broken", url: `${feeds.url}/broken.xml`, name: "失败夹具" },
        ],
      });
      const failed = await waitForTerminal(server.url, await trigger(server.url, topic.id));
      expect(failed.run.status).toBe("failed");
      expect(failed.run.error?.message).toContain("Local stub briefing model failed");
      expect(failed.run.sourceOutcomes.map((item) => item.sourceId).sort()).toEqual([
        "broken",
        "noise",
        "rates",
      ]);
      expect(failed.run.sourceOutcomes.find((item) => item.sourceId === "broken")?.outcome).toBe(
        "request_failed",
      );
      expect(failed.briefing).toBeNull();

      const ready = await waitForTerminal(server.url, await trigger(server.url, topic.id));
      expect(ready.run.status).toBe("succeeded");
      expect(ready.run.outcome).toBe("ready");
      expect(ready.run.modelInvoked).toBe(true);
      expect(ready.run.keywordMissCount).toBeGreaterThan(0);
      expect(ready.run.evidence.map((item) => item.title).sort()).toEqual(
        ["央行维持政策利率", "利率路径继续被讨论"].sort(),
      );
      expect(ready.briefing?.markdown).toContain("不是线上模型");
      expect(ready.briefing?.markdown).toContain("/items/rate-hold");
      expect(ready.briefing?.exportPath).toBeTruthy();
      const exportedFile = await readFile(ready.briefing!.exportPath!, "utf8");
      const exportedHttp = await fetch(`${server.url}/api/runs/${ready.run.id}/export`);
      expect(exportedHttp.headers.get("content-type")).toContain("text/markdown");
      expect(await exportedHttp.text()).toBe(exportedFile);

      articles.push(article("rate-new", "新增利率观察", "新增一条政策利率观察。"));
      const partial = await waitForTerminal(server.url, await trigger(server.url, topic.id));
      expect(partial.run.droppedDuplicateCount).toBe(2);
      expect(partial.run.evidence.map((item) => item.title)).toEqual(["新增利率观察"]);

      const deduped = await waitForTerminal(server.url, await trigger(server.url, topic.id));
      expect(deduped.run.outcome).toBe("deduped");
      expect(deduped.run.modelInvoked).toBe(false);
      expect(deduped.run.evidence).toHaveLength(0);

      const emptyTopic = await sendJson<TopicRecord>(server.url, "/api/topics", {
        name: "空专题",
        keywords: ["利率"],
        feedIds: [],
        customFeeds: [{ id: "empty", url: `${feeds.url}/empty.xml` }],
      });
      const empty = await waitForTerminal(server.url, await trigger(server.url, emptyTopic.id));
      expect(empty.run.outcome).toBe("empty");
      expect(empty.briefing?.markdown).toContain("未调用模型");

      const failedTopic = await sendJson<TopicRecord>(server.url, "/api/topics", {
        name: "单源全失败",
        keywords: ["利率"],
        feedIds: [],
        customFeeds: [{ id: "broken", url: `${feeds.url}/broken.xml` }],
      });
      const allFailed = await waitForTerminal(
        server.url,
        await trigger(server.url, failedTopic.id),
      );
      expect(allFailed.run.status).toBe("failed");
      expect(allFailed.run.sourceOutcomes[0]?.outcome).toBe("request_failed");

      const renamed = await sendJson<TopicRecord>(
        server.url,
        `/api/topics/${topic.id}`,
        {
          name: "利率专题已编辑",
          keywords: ["利率"],
          windowHours: 24,
          lookbackDays: 7,
          feedIds: [],
          customFeeds: [{ id: "rates", url: `${feeds.url}/rates.xml`, name: "利率夹具" }],
        },
        "PATCH",
      );
      expect(renamed.name).toBe("利率专题已编辑");
      expect(renamed.windowHours).toBe(24);

      await server.close();
      server = undefined;
      const reloaded = await startDesk(pool, exportDirectory, 0);
      server = reloaded;
      const history = await readJson<TopicRunRecord[]>(server.url, `/api/topics/${topic.id}/runs`);
      expect(history.map((run) => run.id)).toContain(ready.run.id);
      const reread = await readJson<TopicDeskDetail>(server.url, `/api/runs/${ready.run.id}`);
      expect(reread.briefing?.markdown).toBe(ready.briefing?.markdown);
      expect(reread.topic.name).toBe("利率专题已编辑");
    } finally {
      await server?.close();
      await feeds.close();
      await pool.end();
      await database.drop();
    }
  });
});

interface FeedArticle {
  slug: string;
  title: string;
  excerpt: string;
}

function article(slug: string, title: string, excerpt: string): FeedArticle {
  return { slug, title, excerpt };
}

async function startDesk(
  pool: ReturnType<typeof createPostgresPool>,
  exportDirectory: string,
  stubFailures: number,
): Promise<TopicDeskServer> {
  const desk = new TopicDesk({
    store: new PostgresTopicDeskStore(pool),
    collector: createRssTopicCollector(),
    model: new LocalStubBriefingModel(stubFailures),
    exporter: {
      async exportMarkdown(input) {
        const outputPath = join(exportDirectory, input.topicId, `${input.runId}.md`);
        const output = new FileOutputPlugin(outputPath);
        const receipt = await output.deliver({
          id: input.runId,
          mediaType: "text/markdown",
          content: input.markdown,
        });
        return receipt.target;
      },
    },
  });
  return startTopicDeskServer({
    desk,
    catalog: [],
    mode: "e2e",
    modelLabel: "local-stub/topic-desk-stub@1",
    host: "127.0.0.1",
    port: 0,
  });
}

async function startFeedServer(): Promise<{
  url: string;
  articles: FeedArticle[];
  close: () => Promise<void>;
}> {
  const state: { articles: FeedArticle[] } = { articles: [] };
  const server = createServer((request, response) => {
    const path = request.url ?? "/";

    if (path.startsWith("/broken")) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("fixture feed failed");
      return;
    }

    const items = path.startsWith("/empty")
      ? []
      : path.startsWith("/noise")
        ? [article("sports", "周末体育赛程", "本地联赛公布周末赛程。")]
        : state.articles;
    response.writeHead(200, { "content-type": "application/rss+xml; charset=utf-8" });
    response.end(renderRss(items));
  });
  await listen(server);
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Fixture feed server did not bind.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    get articles() {
      return state.articles;
    },
    set articles(value: FeedArticle[]) {
      state.articles = value;
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

function renderRss(items: readonly FeedArticle[]): string {
  const body = items
    .map(
      (item) => `<item>
        <title>${item.title}</title>
        <link>http://127.0.0.1/items/${item.slug}</link>
        <guid isPermaLink="true">http://127.0.0.1/items/${item.slug}</guid>
        <pubDate>${new Date().toUTCString()}</pubDate>
        <description>${item.excerpt}</description>
      </item>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Fixture</title>${body}</channel></rss>`;
}

async function trigger(baseUrl: string, topicId: string): Promise<string> {
  const run = await sendJson<TopicRunRecord>(baseUrl, `/api/topics/${topicId}/runs`, {}, "POST");
  expect(run.status).toBe("running");
  return run.id;
}

async function waitForTerminal(baseUrl: string, runId: string): Promise<TopicDeskDetail> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const detail = await readJson<TopicDeskDetail>(baseUrl, `/api/runs/${runId}`);

    if (detail.run.status !== "running") {
      return detail;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Topic run ${runId} stayed running.`);
}

async function readJson<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);

  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as T;
}

async function sendJson<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  method = "POST",
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`${method} ${path} returned ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as T;
}

async function postgresReachable(connectionString: string): Promise<boolean> {
  const pool = createPostgresPool({ connectionString, connectionTimeoutMillis: 1_000 });

  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

async function createIsolatedDatabase(connectionString: string): Promise<{
  url: string;
  drop: () => Promise<void>;
}> {
  const name = `topic_desk_${randomBytes(8).toString("hex")}`;
  const admin = createPostgresPool({ connectionString });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async drop() {
      const pool = createPostgresPool({ connectionString });
      await pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await pool.end();
    },
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}
