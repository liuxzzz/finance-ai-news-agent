import {
  TopicRunAlreadyActiveError,
  type BeginTopicRunInput,
  type CommitTopicRunInput,
  type CreateTopicInput,
  type TopicBriefingRecord,
  type TopicDeskStore,
  type TopicRecord,
  type TopicRunRecord,
  type TopicSeenEvidenceRecord,
  type TopicSourceOutcome,
  type UpdateTopicInput,
} from "@finance-ai-news-agent/plugin-sdk";

/** Test double for the topic desk contract. The workbench itself uses PostgreSQL. */
export class InMemoryTopicDeskStore implements TopicDeskStore {
  private readonly topics = new Map<string, TopicRecord>();
  private readonly runs = new Map<string, TopicRunRecord>();
  private readonly briefings = new Map<string, TopicBriefingRecord>();
  private readonly seen: TopicSeenEvidenceRecord[] = [];

  async createTopic(input: CreateTopicInput): Promise<TopicRecord> {
    const topic: TopicRecord = {
      ...input,
      updatedAt: input.createdAt,
      keywords: [...input.keywords],
      feeds: input.feeds.map(cloneFeed),
    };
    this.topics.set(topic.id, topic);
    return cloneTopic(topic);
  }

  async updateTopic(id: string, input: UpdateTopicInput): Promise<TopicRecord | null> {
    const current = this.topics.get(id);

    if (current === undefined) {
      return null;
    }

    const updated: TopicRecord = {
      ...current,
      ...input,
      keywords: [...input.keywords],
      feeds: input.feeds.map(cloneFeed),
    };
    this.topics.set(id, updated);
    return cloneTopic(updated);
  }

  async getTopic(id: string): Promise<TopicRecord | null> {
    const topic = this.topics.get(id);
    return topic === undefined ? null : cloneTopic(topic);
  }

  async listTopics(): Promise<TopicRecord[]> {
    return [...this.topics.values()]
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
      )
      .map(cloneTopic);
  }

  async beginRun(input: BeginTopicRunInput): Promise<TopicRunRecord> {
    if (!this.topics.has(input.topicId)) {
      throw new Error(`Topic ${input.topicId} does not exist.`);
    }

    if (
      [...this.runs.values()].some(
        (run) => run.topicId === input.topicId && run.status === "running",
      )
    ) {
      throw new TopicRunAlreadyActiveError();
    }

    const run: TopicRunRecord = {
      id: input.id,
      topicId: input.topicId,
      status: "running",
      outcome: null,
      modelMode: input.modelMode,
      modelLabel: null,
      modelInvoked: false,
      query: input.query,
      sourceOutcomes: [],
      evidence: [],
      collectedCount: 0,
      keywordMissCount: 0,
      droppedDuplicateCount: 0,
      error: null,
      startedAt: input.startedAt,
      finishedAt: null,
    };
    this.runs.set(run.id, run);
    return cloneRun(run);
  }

  async failRun(
    runId: string,
    error: { name: string; message: string },
    sourceOutcomes: TopicSourceOutcome[],
    counts: { collectedCount: number; keywordMissCount: number; droppedDuplicateCount: number },
    finishedAt: string,
  ): Promise<TopicRunRecord> {
    const run = this.requireRunning(runId);
    run.status = "failed";
    run.sourceOutcomes = sourceOutcomes.map(cloneSource);
    run.collectedCount = counts.collectedCount;
    run.keywordMissCount = counts.keywordMissCount;
    run.droppedDuplicateCount = counts.droppedDuplicateCount;
    run.error = { ...error };
    run.finishedAt = finishedAt;
    return cloneRun(run);
  }

  async commitRun(input: CommitTopicRunInput): Promise<{
    run: TopicRunRecord;
    briefing: TopicBriefingRecord;
  }> {
    const run = this.requireRunning(input.runId);
    run.status = "succeeded";
    run.outcome = input.outcome;
    run.modelLabel = input.modelLabel;
    run.modelInvoked = input.modelInvoked;
    run.sourceOutcomes = input.sourceOutcomes.map(cloneSource);
    run.evidence = input.evidence.map(cloneEvidence);
    run.collectedCount = input.collectedCount;
    run.keywordMissCount = input.keywordMissCount;
    run.droppedDuplicateCount = input.droppedDuplicateCount;
    run.finishedAt = input.finishedAt;
    const briefing: TopicBriefingRecord = {
      id: input.briefing.id,
      runId: run.id,
      topicId: run.topicId,
      title: input.briefing.title,
      markdown: input.briefing.markdown,
      evidenceCount: input.evidence.length,
      exportPath: input.briefing.exportPath,
      createdAt: input.finishedAt,
    };
    this.briefings.set(run.id, briefing);
    this.seen.push(...input.seen.map((item) => ({ ...item })));
    return { run: cloneRun(run), briefing: { ...briefing } };
  }

  async getRun(id: string): Promise<TopicRunRecord | null> {
    const run = this.runs.get(id);
    return run === undefined ? null : cloneRun(run);
  }

  async listRuns(topicId: string): Promise<TopicRunRecord[]> {
    return [...this.runs.values()]
      .filter((run) => run.topicId === topicId)
      .sort(
        (left, right) =>
          right.startedAt.localeCompare(left.startedAt) || left.id.localeCompare(right.id),
      )
      .map(cloneRun);
  }

  async getBriefingByRun(runId: string): Promise<TopicBriefingRecord | null> {
    const briefing = this.briefings.get(runId);
    return briefing === undefined ? null : { ...briefing };
  }

  async listSeenEvidence(topicId: string, seenSince: string): Promise<TopicSeenEvidenceRecord[]> {
    return this.seen
      .filter((item) => item.topicId === topicId && item.seenAt >= seenSince)
      .map((item) => ({ ...item }));
  }

  private requireRunning(runId: string): TopicRunRecord {
    const run = this.runs.get(runId);

    if (run === undefined || run.status !== "running") {
      throw new Error(`Running topic run ${runId} does not exist.`);
    }

    return run;
  }
}

function cloneTopic(topic: TopicRecord): TopicRecord {
  return {
    ...topic,
    keywords: [...topic.keywords],
    feeds: topic.feeds.map(cloneFeed),
  };
}

function cloneFeed(feed: TopicRecord["feeds"][number]): TopicRecord["feeds"][number] {
  return feed.name === undefined
    ? { id: feed.id, url: feed.url }
    : { id: feed.id, url: feed.url, name: feed.name };
}

function cloneRun(run: TopicRunRecord): TopicRunRecord {
  return {
    ...run,
    sourceOutcomes: run.sourceOutcomes.map(cloneSource),
    evidence: run.evidence.map(cloneEvidence),
    error: run.error === null ? null : { ...run.error },
  };
}

function cloneSource(source: TopicSourceOutcome): TopicSourceOutcome {
  return {
    ...source,
    error: source.error === null ? null : { ...source.error },
  };
}

function cloneEvidence(
  evidence: TopicRunRecord["evidence"][number],
): TopicRunRecord["evidence"][number] {
  return { ...evidence };
}
