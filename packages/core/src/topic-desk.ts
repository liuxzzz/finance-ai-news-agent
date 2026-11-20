import { randomUUID } from "node:crypto";

import {
  TopicRunAlreadyActiveError,
  type StructuredModelProvider,
  type TopicBriefingRecord,
  type TopicDeskStore,
  type TopicEvidenceRecord,
  type TopicFeed,
  type TopicRecord,
  type TopicRunOutcome,
  type TopicRunRecord,
  type TopicSourceOutcome,
} from "@finance-ai-news-agent/plugin-sdk";

import { EvidenceSchema, type AgentGraphStateValue, type Evidence } from "./agent-state.js";
import { normalizeAndClusterEvidence, selectBalancedEvidence } from "./evidence-normalizer.js";
import { CURATE_WRITE_PROMPT_V1 } from "./finance-ai-prompts.js";
import { renderCuratedDraft } from "./model-agent-handlers.js";
import { curateWriteOutputSchemaForEvidence } from "./model-node-output.js";

const MAX_EVIDENCE = 12;
const STUB_MODEL_LABEL = "local-stub/topic-desk-stub@1";

export class TopicDeskError extends Error {
  override readonly name = "TopicDeskError";

  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export class TopicCollectionFailedError extends Error {
  override readonly name = "TopicCollectionFailedError";

  readonly sources: TopicSourceOutcome[];

  constructor(message: string, sources: TopicSourceOutcome[]) {
    super(message);
    this.sources = sources;
  }
}

export interface TopicCollectedItem {
  id: string;
  title: string;
  url: string;
  excerpt: string;
  source?: string;
  sourceId?: string;
  publishedAt?: string;
}

export interface TopicNewsCollector {
  collect(input: {
    runId: string;
    query: string;
    feeds: readonly TopicFeed[];
    windowHours: number;
  }): Promise<{
    items: TopicCollectedItem[];
    sources: TopicSourceOutcome[];
  }>;
}

export interface TopicBriefingDraft {
  markdown: string;
  modelLabel: string;
}

export interface TopicBriefingModel {
  readonly mode: "stub" | "structured";
  readonly label: string;
  generate(input: {
    topicName: string;
    keywords: readonly string[];
    evidence: readonly Evidence[];
  }): Promise<TopicBriefingDraft>;
}

export interface TopicBriefingExporter {
  exportMarkdown(input: { topicId: string; runId: string; markdown: string }): Promise<string>;
}

export interface TopicDeskDetail {
  topic: TopicRecord;
  run: TopicRunRecord;
  briefing: TopicBriefingRecord | null;
}

export interface TopicDraftInput {
  name: string;
  keywords: readonly string[];
  feeds: readonly TopicFeed[];
  windowHours?: number;
  lookbackDays?: number;
  enabled?: boolean;
}

export interface TopicDeskOptions {
  store: TopicDeskStore;
  collector: TopicNewsCollector;
  model: TopicBriefingModel;
  exporter?: TopicBriefingExporter;
  now?: () => Date;
  generateId?: () => string;
}

/**
 * User-facing topic tracking. Collection, normalization, and structured
 * rendering stay on the existing research primitives; this service only adds
 * topic configuration, run status, and briefing persistence.
 */
export class TopicDesk {
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(private readonly options: TopicDeskOptions) {
    this.now = options.now ?? (() => new Date());
    this.generateId = options.generateId ?? randomUUID;
  }

  async createTopic(input: TopicDraftInput): Promise<TopicRecord> {
    const draft = normalizeTopicDraft(input);
    return this.options.store.createTopic({
      id: this.generateId(),
      ...draft,
      createdAt: this.now().toISOString(),
    });
  }

  async updateTopic(id: string, input: TopicDraftInput): Promise<TopicRecord> {
    const current = await this.requireTopic(id);
    const draft = normalizeTopicDraft(input);
    const updated = await this.options.store.updateTopic(id, {
      ...draft,
      updatedAt: this.now().toISOString(),
    });

    if (updated === null) {
      throw new TopicDeskError(404, `Topic ${current.id} does not exist.`);
    }

    return updated;
  }

  async getTopic(id: string): Promise<TopicRecord> {
    return this.requireTopic(id);
  }

  async listTopics(): Promise<TopicRecord[]> {
    return this.options.store.listTopics();
  }

  async startRun(topicId: string): Promise<TopicRunRecord> {
    const topic = await this.requireTopic(topicId);

    if (!topic.enabled) {
      throw new TopicDeskError(409, "Disabled topics cannot be run.");
    }

    let run: TopicRunRecord;

    try {
      run = await this.options.store.beginRun({
        id: this.generateId(),
        topicId: topic.id,
        modelMode: this.options.model.mode,
        query: topic.keywords.join(" "),
        startedAt: this.now().toISOString(),
      });
    } catch (error) {
      if (error instanceof TopicRunAlreadyActiveError) {
        throw new TopicDeskError(409, error.message);
      }

      throw error;
    }

    const task = this.finishRun(topic, run.id);
    this.tasks.set(run.id, task);
    void task.finally(() => {
      if (this.tasks.get(run.id) === task) {
        this.tasks.delete(run.id);
      }
    });
    return run;
  }

  async waitForRun(runId: string): Promise<void> {
    await this.tasks.get(runId);
  }

  async settle(): Promise<void> {
    await Promise.all([...this.tasks.values()]);
  }

  async listRuns(topicId: string): Promise<TopicRunRecord[]> {
    await this.requireTopic(topicId);
    return this.options.store.listRuns(topicId);
  }

  async getRunDetail(runId: string): Promise<TopicDeskDetail> {
    const run = await this.options.store.getRun(runId);

    if (run === null) {
      throw new TopicDeskError(404, `Topic run ${runId} does not exist.`);
    }

    const topic = await this.requireTopic(run.topicId);
    const briefing = await this.options.store.getBriefingByRun(run.id);
    return { topic, run, briefing };
  }

  private async finishRun(topic: TopicRecord, runId: string): Promise<void> {
    let sources: TopicSourceOutcome[] = [];
    let collectedCount = 0;
    let keywordMissCount = 0;
    let droppedDuplicateCount = 0;

    try {
      const collected = await this.options.collector.collect({
        runId,
        query: topic.keywords.join(" "),
        feeds: topic.feeds,
        windowHours: topic.windowHours,
      });
      sources = collected.sources;
      collectedCount = collected.items.length;
      const matched = collected.items.filter((item) => itemMatchesKeywords(item, topic.keywords));
      keywordMissCount = collectedCount - matched.length;
      const normalized = normalizeAndClusterEvidence(
        matched.map((item) => EvidenceSchema.parse(item)),
        MAX_EVIDENCE,
      );
      const seenSince = new Date(
        this.now().getTime() - topic.lookbackDays * 24 * 60 * 60 * 1000,
      ).toISOString();
      const previouslySeen =
        topic.lookbackDays === 0
          ? []
          : await this.options.store.listSeenEvidence(topic.id, seenSince);
      const seenFingerprints = new Set(previouslySeen.map((item) => item.fingerprint));
      const seenTitles = new Set(previouslySeen.map((item) => item.titleFingerprint));
      const unseen = normalized.filter(
        (item) =>
          item.fingerprint !== undefined &&
          item.titleFingerprint !== undefined &&
          !seenFingerprints.has(item.fingerprint) &&
          !seenTitles.has(item.titleFingerprint),
      );
      droppedDuplicateCount = normalized.length - unseen.length;
      const evidence = selectBalancedEvidence(unseen, MAX_EVIDENCE);
      const outcome = briefingOutcome(evidence.length, droppedDuplicateCount);
      const invoked = outcome === "ready";
      const draft = invoked
        ? await this.options.model.generate({
            topicName: topic.name,
            keywords: topic.keywords,
            evidence,
          })
        : staticBriefing(topic.name, outcome);
      const markdown = invoked
        ? `${modelBanner(this.options.model.mode, draft.modelLabel)}\n\n${draft.markdown}`
        : draft.markdown;
      const exportPath =
        this.options.exporter === undefined
          ? null
          : await this.options.exporter.exportMarkdown({
              topicId: topic.id,
              runId,
              markdown,
            });
      const finishedAt = this.now().toISOString();
      await this.options.store.commitRun({
        runId,
        outcome,
        modelLabel: invoked ? draft.modelLabel : null,
        modelInvoked: invoked,
        sourceOutcomes: sources,
        evidence: evidence.map(toEvidenceRecord),
        collectedCount,
        keywordMissCount,
        droppedDuplicateCount,
        briefing: {
          id: this.generateId(),
          title: topic.name,
          markdown,
          exportPath,
        },
        seen: evidence.flatMap((item) => {
          if (item.fingerprint === undefined || item.titleFingerprint === undefined) {
            return [];
          }

          return [
            {
              topicId: topic.id,
              fingerprint: item.fingerprint,
              titleFingerprint: item.titleFingerprint,
              evidenceId: item.id,
              runId,
              seenAt: finishedAt,
            },
          ];
        }),
        finishedAt,
      });
    } catch (error) {
      if (error instanceof TopicCollectionFailedError) {
        sources = error.sources;
      }

      await this.options.store.failRun(
        runId,
        { name: errorName(error), message: errorMessage(error) },
        sources,
        { collectedCount, keywordMissCount, droppedDuplicateCount },
        this.now().toISOString(),
      );
    }
  }

  private async requireTopic(id: string): Promise<TopicRecord> {
    const topic = await this.options.store.getTopic(id);

    if (topic === null) {
      throw new TopicDeskError(404, `Topic ${id} does not exist.`);
    }

    return topic;
  }
}

export class LocalStubBriefingModel implements TopicBriefingModel {
  readonly mode = "stub" as const;
  readonly label = STUB_MODEL_LABEL;
  private failuresRemaining: number;

  constructor(failures = 0) {
    if (!Number.isSafeInteger(failures) || failures < 0) {
      throw new Error("Stub briefing failures must be a non-negative integer.");
    }

    this.failuresRemaining = failures;
  }

  async generate(input: {
    topicName: string;
    keywords: readonly string[];
    evidence: readonly Evidence[];
  }): Promise<TopicBriefingDraft> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("Local stub briefing model failed before producing a digest.");
    }

    const lines = [`# ${input.topicName}`, "", `关键词：${input.keywords.join("、")}`, ""];

    for (const item of input.evidence) {
      lines.push(
        `## ${item.title}`,
        "",
        item.excerpt,
        "",
        `来源：${item.url}`,
        `证据：${item.id}`,
        "",
      );
    }

    return {
      markdown: lines.join("\n").trimEnd(),
      modelLabel: STUB_MODEL_LABEL,
    };
  }
}

export function createStructuredTopicBriefingModel(
  provider: StructuredModelProvider,
): TopicBriefingModel {
  return {
    mode: "structured",
    label: provider.manifest.id,
    async generate(input) {
      const evidenceIds = new Set(input.evidence.map((item) => item.id));
      const state = briefingState(input.topicName, input.evidence);
      const response = await provider.generateStructured({
        role: "curate_write",
        system: CURATE_WRITE_PROMPT_V1.system,
        prompt: CURATE_WRITE_PROMPT_V1.renderUser(state),
        schema: curateWriteOutputSchemaForEvidence(evidenceIds),
        schemaName: "curate_write",
        schemaDescription: CURATE_WRITE_PROMPT_V1.system,
        maxOutputTokens: CURATE_WRITE_PROMPT_V1.maxOutputTokens,
        temperature: CURATE_WRITE_PROMPT_V1.temperature,
      });
      return {
        markdown: renderCuratedDraft(input.topicName, response.value, [...input.evidence]),
        modelLabel: response.model,
      };
    },
  };
}

export function normalizeTopicDraft(input: TopicDraftInput): {
  name: string;
  keywords: string[];
  feeds: TopicFeed[];
  windowHours: number;
  lookbackDays: number;
  enabled: boolean;
} {
  const name = input.name.trim();

  if (name.length < 1 || name.length > 80) {
    throw new TopicDeskError(400, "Topic name must be 1 to 80 characters.");
  }

  const keywords = input.keywords
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0);

  if (keywords.length < 1 || keywords.length > 8) {
    throw new TopicDeskError(400, "A topic needs 1 to 8 keywords.");
  }

  if (keywords.some((keyword) => keyword.length < 2 || keyword.length > 40)) {
    throw new TopicDeskError(400, "Each keyword must be 2 to 40 characters.");
  }

  if (
    new Set(keywords.map((keyword) => keyword.toLocaleLowerCase("zh-CN"))).size !== keywords.length
  ) {
    throw new TopicDeskError(400, "Keywords must be unique.");
  }

  const query = keywords.join(" ");

  if (query.length > 200) {
    throw new TopicDeskError(400, "Joined keywords must be 200 characters or fewer.");
  }

  if (input.feeds.length < 1 || input.feeds.length > 8) {
    throw new TopicDeskError(400, "A topic needs 1 to 8 feeds.");
  }

  const feeds = input.feeds.map(normalizeFeed);
  const ids = new Set<string>();
  const urls = new Set<string>();

  for (const feed of feeds) {
    if (ids.has(feed.id) || urls.has(feed.url)) {
      throw new TopicDeskError(400, "Feed ids and URLs must be unique.");
    }

    ids.add(feed.id);
    urls.add(feed.url);
  }

  return {
    name,
    keywords,
    feeds,
    windowHours: boundedInteger(input.windowHours ?? 48, "windowHours", 1, 168),
    lookbackDays: boundedInteger(input.lookbackDays ?? 7, "lookbackDays", 0, 30),
    enabled: input.enabled ?? true,
  };
}

function normalizeFeed(feed: TopicFeed): TopicFeed {
  const id = feed.id.trim();

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw new TopicDeskError(400, `Feed id is invalid: ${feed.id}.`);
  }

  const url = assertTopicFeedUrl(feed.url).toString();
  const name = feed.name?.trim();
  return name === undefined || name.length === 0 ? { id, url } : { id, url, name };
}

export function assertTopicFeedUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value.trim());
  } catch {
    throw new TopicDeskError(400, "Feed URL must be a valid HTTP(S) URL.");
  }

  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";

  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TopicDeskError(400, "Feed URL must use HTTPS except for local loopback.");
  }

  if (url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) {
    throw new TopicDeskError(400, "Feed URL must not contain credentials or fragments.");
  }

  return url;
}

function itemMatchesKeywords(
  item: { title: string; excerpt: string },
  keywords: readonly string[],
): boolean {
  const haystack = `${item.title}\n${item.excerpt}`.toLocaleLowerCase("zh-CN");
  return keywords.some((keyword) => haystack.includes(keyword.toLocaleLowerCase("zh-CN")));
}

function briefingOutcome(evidenceCount: number, droppedDuplicateCount: number): TopicRunOutcome {
  if (evidenceCount > 0) {
    return "ready";
  }

  return droppedDuplicateCount > 0 ? "deduped" : "empty";
}

function staticBriefing(topicName: string, outcome: "empty" | "deduped"): TopicBriefingDraft {
  const reason =
    outcome === "deduped"
      ? "窗口内的匹配新闻都已写入过该专题，本次没有新证据。"
      : "采集结果里没有匹配该专题关键词的新证据。";
  return {
    modelLabel: STUB_MODEL_LABEL,
    markdown: [
      `# ${topicName}`,
      "",
      "> 生成方式：未调用模型。",
      `> 结果：${outcome}`,
      "",
      reason,
    ].join("\n"),
  };
}

function modelBanner(mode: "stub" | "structured", label: string): string {
  const note =
    mode === "stub"
      ? "本地测试适配器，不是线上模型。"
      : "结构化编辑结果；来源链接由程序从证据生成。";
  return `> 模型：${label}\n> 模式：${mode}\n> 说明：${note}`;
}

function briefingState(topic: string, evidence: readonly Evidence[]): AgentGraphStateValue {
  return {
    runId: "topic-desk",
    topic,
    maxRevisions: 0,
    plan: [],
    evidence: [...evidence],
    stories: [],
    draft: "",
    critique: "",
    approved: false,
    reviewRoute: "revise",
    revisionCount: 0,
    modelUsage: { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    trace: [],
  };
}

function toEvidenceRecord(evidence: Evidence): TopicEvidenceRecord {
  return {
    id: evidence.id,
    title: evidence.title,
    url: evidence.url,
    excerpt: evidence.excerpt,
    ...(evidence.source === undefined ? {} : { source: evidence.source }),
    ...(evidence.sourceId === undefined ? {} : { sourceId: evidence.sourceId }),
    ...(evidence.publishedAt === undefined ? {} : { publishedAt: evidence.publishedAt }),
    ...(evidence.canonicalUrl === undefined ? {} : { canonicalUrl: evidence.canonicalUrl }),
    ...(evidence.fingerprint === undefined ? {} : { fingerprint: evidence.fingerprint }),
    ...(evidence.titleFingerprint === undefined
      ? {}
      : { titleFingerprint: evidence.titleFingerprint }),
    ...(evidence.clusterId === undefined ? {} : { clusterId: evidence.clusterId }),
  };
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TopicDeskError(400, `${label} must be an integer from ${minimum} to ${maximum}.`);
  }

  return value;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}
