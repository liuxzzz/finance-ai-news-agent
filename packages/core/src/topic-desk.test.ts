import type { StructuredModelProvider, TopicFeed } from "@finance-ai-news-agent/plugin-sdk";
import { describe, expect, it } from "vitest";

import type { Evidence } from "./agent-state.js";
import {
  LocalStubBriefingModel,
  TopicCollectionFailedError,
  TopicDesk,
  TopicDeskError,
  createStructuredTopicBriefingModel,
  type TopicCollectedItem,
  type TopicNewsCollector,
  type TopicSourceOutcome,
} from "./topic-desk.js";
import { InMemoryTopicDeskStore } from "./topic-desk-memory.js";

const feed: TopicFeed = {
  id: "desk-feed",
  url: "http://127.0.0.1:9/feed.xml",
  name: "Desk fixture",
};

describe("topic desk", () => {
  it("creates, edits, collects, deduplicates, and reads a briefing back", async () => {
    const collector = new ScriptedCollector([
      collection([item("rate-1", "央行维持利率"), item("sport-1", "周末体育赛程")]),
      collection([item("rate-1", "央行维持利率"), item("rate-2", "利率路径更新")]),
    ]);
    const desk = new TopicDesk({
      store: new InMemoryTopicDeskStore(),
      collector,
      model: new LocalStubBriefingModel(),
      now: clock(),
    });
    const topic = await desk.createTopic({
      name: "利率跟踪",
      keywords: ["利率"],
      feeds: [feed],
      windowHours: 24,
    });
    const renamed = await desk.updateTopic(topic.id, {
      name: "利率专题",
      keywords: ["利率"],
      feeds: [feed],
      windowHours: 24,
    });
    const first = await desk.startRun(renamed.id);
    expect(first.status).toBe("running");
    await desk.waitForRun(first.id);
    const ready = await desk.getRunDetail(first.id);

    expect(ready.run.status).toBe("succeeded");
    expect(ready.run.outcome).toBe("ready");
    expect(ready.run.modelInvoked).toBe(true);
    expect(ready.run.modelLabel).toBe("local-stub/topic-desk-stub@1");
    expect(ready.run.keywordMissCount).toBe(1);
    expect(ready.run.evidence.map((entry) => entry.title)).toEqual(["央行维持利率"]);
    expect(ready.briefing?.markdown).toContain("本地测试适配器，不是线上模型。");
    expect(ready.briefing?.markdown).toContain("http://127.0.0.1/rate-1");

    const second = await desk.startRun(renamed.id);
    await desk.waitForRun(second.id);
    const deduped = await desk.getRunDetail(second.id);
    expect(deduped.run.outcome).toBe("ready");
    expect(deduped.run.droppedDuplicateCount).toBe(1);
    expect(deduped.run.evidence.map((entry) => entry.title)).toEqual(["利率路径更新"]);

    const third = await desk.startRun(renamed.id);
    await desk.waitForRun(third.id);
    const emptyRepeat = await desk.getRunDetail(third.id);
    expect(emptyRepeat.run.outcome).toBe("deduped");
    expect(emptyRepeat.run.modelInvoked).toBe(false);
    expect(emptyRepeat.briefing?.markdown).toContain("未调用模型");
    expect(await desk.listRuns(renamed.id)).toHaveLength(3);
  });

  it("keeps a partial source failure and records an empty feed", async () => {
    const collector = new ScriptedCollector([
      collection(
        [item("rate-1", "利率决议")],
        [source("good", "available"), source("bad", "request_failed", "timeout")],
      ),
      collection([], [source("empty", "empty")]),
    ]);
    const desk = new TopicDesk({
      store: new InMemoryTopicDeskStore(),
      collector,
      model: new LocalStubBriefingModel(),
    });
    const topic = await desk.createTopic({
      name: "来源容错",
      keywords: ["利率"],
      feeds: [feed, { id: "bad", url: "https://example.com/bad.xml" }],
    });
    const run = await desk.startRun(topic.id);
    await desk.waitForRun(run.id);
    const detail = await desk.getRunDetail(run.id);
    expect(detail.run.status).toBe("succeeded");
    expect(detail.run.sourceOutcomes.map((entry) => entry.outcome)).toEqual([
      "available",
      "request_failed",
    ]);

    const emptyTopic = await desk.createTopic({
      name: "空结果",
      keywords: ["利率"],
      feeds: [{ id: "empty", url: "https://example.com/empty.xml" }],
    });
    const emptyRun = await desk.startRun(emptyTopic.id);
    await desk.waitForRun(emptyRun.id);
    const empty = await desk.getRunDetail(emptyRun.id);
    expect(empty.run.outcome).toBe("empty");
    expect(empty.briefing?.evidenceCount).toBe(0);
  });

  it("persists model failure and recovers on the next run", async () => {
    const collector = new ScriptedCollector([
      collection([item("rate-1", "利率决议")]),
      collection([item("rate-1", "利率决议")]),
    ]);
    const desk = new TopicDesk({
      store: new InMemoryTopicDeskStore(),
      collector,
      model: new LocalStubBriefingModel(1),
    });
    const topic = await desk.createTopic({
      name: "模型恢复",
      keywords: ["利率"],
      feeds: [feed],
    });
    const failed = await desk.startRun(topic.id);
    await desk.waitForRun(failed.id);
    const failure = await desk.getRunDetail(failed.id);
    expect(failure.run.status).toBe("failed");
    expect(failure.run.error?.message).toContain("Local stub briefing model failed");
    expect(failure.briefing).toBeNull();

    const recovered = await desk.startRun(topic.id);
    await desk.waitForRun(recovered.id);
    const success = await desk.getRunDetail(recovered.id);
    expect(success.run.status).toBe("succeeded");
    expect(success.run.evidence).toHaveLength(1);
  });

  it("fails the run when every feed fails and rejects a second active run", async () => {
    const collector: TopicNewsCollector = {
      async collect() {
        throw new TopicCollectionFailedError("All configured feeds failed.", [
          source("bad", "request_failed", "down"),
        ]);
      },
    };
    const desk = new TopicDesk({
      store: new InMemoryTopicDeskStore(),
      collector,
      model: new LocalStubBriefingModel(),
    });
    const topic = await desk.createTopic({
      name: "全失败",
      keywords: ["利率"],
      feeds: [feed],
    });
    const blocked = desk.startRun(topic.id);
    await expect(desk.startRun(topic.id)).rejects.toBeInstanceOf(TopicDeskError);
    const run = await blocked;
    await desk.waitForRun(run.id);
    const detail = await desk.getRunDetail(run.id);
    expect(detail.run.status).toBe("failed");
    expect(detail.run.sourceOutcomes[0]?.outcome).toBe("request_failed");
  });

  it("renders a structured briefing from evidence ids without trusting model URLs", async () => {
    const evidence: Evidence = {
      id: "ev-1",
      title: "利率决议公布",
      url: "https://example.com/rate",
      excerpt: "委员会维持政策利率不变。",
      source: "Example",
      publishedAt: "2026-11-20T00:00:00.000Z",
    };
    let capturedPrompt = "";
    const provider: StructuredModelProvider = {
      manifest: {
        id: "structured-test",
        name: "Structured test",
        version: "0",
        kind: "model",
        coreCompatibility: ">=0.0.0",
      },
      async generate() {
        throw new Error("plain text generation is not used");
      },
      async generateStructured(request) {
        capturedPrompt = request.prompt;
        return {
          value: request.schema.parse({
            schemaVersion: "curate_write.v1",
            stories: [
              {
                id: "story-1",
                category: "policy",
                headline: "政策利率维持不变",
                summary: "委员会维持政策利率不变。",
                whyItMatters: "专题正在跟踪利率路径。",
                evidenceIds: ["ev-1"],
              },
            ],
          }),
          model: "fake-structured-model",
          finishReason: "stop",
        };
      },
    };
    const desk = new TopicDesk({
      store: new InMemoryTopicDeskStore(),
      collector: {
        async collect() {
          return collection([
            {
              id: evidence.id,
              title: evidence.title,
              url: evidence.url,
              excerpt: evidence.excerpt,
              source: evidence.source,
              publishedAt: evidence.publishedAt,
            },
          ]);
        },
      },
      model: createStructuredTopicBriefingModel(provider),
    });
    const topic = await desk.createTopic({
      name: "结构化简报",
      keywords: ["利率"],
      feeds: [feed],
    });
    const run = await desk.startRun(topic.id);
    await desk.waitForRun(run.id);
    const detail = await desk.getRunDetail(run.id);
    expect(detail.run.modelMode).toBe("structured");
    expect(detail.run.modelLabel).toBe("fake-structured-model");
    expect(detail.briefing?.markdown).toContain("https://example.com/rate");
    expect(detail.briefing?.markdown).toContain("`ev-1`");
    expect(capturedPrompt).toContain("ev-1");
    expect(capturedPrompt).not.toContain("https://evil.example");
  });

  it("rejects public HTTP feeds and disabled topics", async () => {
    const desk = new TopicDesk({
      store: new InMemoryTopicDeskStore(),
      collector: {
        async collect() {
          return collection([]);
        },
      },
      model: new LocalStubBriefingModel(),
    });
    await expect(
      desk.createTopic({
        name: "坏地址",
        keywords: ["利率"],
        feeds: [{ id: "bad", url: "http://example.com/feed.xml" }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    const topic = await desk.createTopic({
      name: "停用",
      keywords: ["利率"],
      feeds: [feed],
      enabled: false,
    });
    await expect(desk.startRun(topic.id)).rejects.toMatchObject({ statusCode: 409 });
  });
});

class ScriptedCollector implements TopicNewsCollector {
  private index = 0;

  constructor(
    private readonly responses: Array<{
      items: TopicCollectedItem[];
      sources: TopicSourceOutcome[];
    }>,
  ) {}

  async collect(): Promise<{ items: TopicCollectedItem[]; sources: TopicSourceOutcome[] }> {
    const response = this.responses[this.index] ?? this.responses.at(-1);

    if (response === undefined) {
      throw new Error("Scripted collector has no response.");
    }

    this.index += 1;
    return response;
  }
}

function collection(
  items: TopicCollectedItem[],
  sources: TopicSourceOutcome[] = [source("desk-feed", "available")],
): { items: TopicCollectedItem[]; sources: TopicSourceOutcome[] } {
  return { items, sources };
}

function item(id: string, title: string): TopicCollectedItem {
  return {
    id,
    title,
    url: `http://127.0.0.1/${id}`,
    excerpt: `${title}的证据摘录`,
    source: "Fixture",
    sourceId: "desk-feed",
    publishedAt: "2026-11-20T00:00:00.000Z",
  };
}

function source(
  sourceId: string,
  outcome: TopicSourceOutcome["outcome"],
  message?: string,
): TopicSourceOutcome {
  return {
    sourceId,
    outcome,
    received: outcome === "empty" ? 0 : 1,
    fresh: outcome === "available" ? 1 : 0,
    error: message === undefined ? null : { name: "Error", message },
  };
}

function clock(): () => Date {
  let instant = Date.parse("2026-11-20T00:00:00.000Z");
  return () => {
    instant += 1_000;
    return new Date(instant);
  };
}
