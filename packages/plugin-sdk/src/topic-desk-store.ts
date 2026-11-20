/**
 * Persistence contract for the topic desk.
 * The daily `runs` ledger stays untouched; topic configuration, briefing runs,
 * and evidence fingerprints live in their own tables.
 */

export interface TopicFeed {
  id: string;
  url: string;
  name?: string;
}

export interface TopicRecord {
  id: string;
  name: string;
  keywords: string[];
  feeds: TopicFeed[];
  windowHours: number;
  lookbackDays: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTopicInput {
  id: string;
  name: string;
  keywords: string[];
  feeds: TopicFeed[];
  windowHours: number;
  lookbackDays: number;
  enabled: boolean;
  createdAt: string;
}

export interface UpdateTopicInput {
  name: string;
  keywords: string[];
  feeds: TopicFeed[];
  windowHours: number;
  lookbackDays: number;
  enabled: boolean;
  updatedAt: string;
}

export type TopicRunStatus = "running" | "succeeded" | "failed";

export type TopicRunOutcome = "ready" | "empty" | "deduped";

export type TopicSourceOutcomeKind = "available" | "empty" | "filtered" | "request_failed";

export interface TopicSourceOutcome {
  sourceId: string;
  outcome: TopicSourceOutcomeKind;
  received: number;
  fresh: number;
  error: { name: string; message: string } | null;
}

export interface TopicEvidenceRecord {
  id: string;
  title: string;
  url: string;
  excerpt: string;
  source?: string;
  sourceId?: string;
  publishedAt?: string;
  canonicalUrl?: string;
  fingerprint?: string;
  titleFingerprint?: string;
  clusterId?: string;
}

export interface TopicRunRecord {
  id: string;
  topicId: string;
  status: TopicRunStatus;
  outcome: TopicRunOutcome | null;
  modelMode: "stub" | "structured";
  modelLabel: string | null;
  modelInvoked: boolean;
  query: string;
  sourceOutcomes: TopicSourceOutcome[];
  evidence: TopicEvidenceRecord[];
  collectedCount: number;
  keywordMissCount: number;
  droppedDuplicateCount: number;
  error: { name: string; message: string } | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface BeginTopicRunInput {
  id: string;
  topicId: string;
  modelMode: "stub" | "structured";
  query: string;
  startedAt: string;
}

export interface TopicBriefingRecord {
  id: string;
  runId: string;
  topicId: string;
  title: string;
  markdown: string;
  evidenceCount: number;
  exportPath: string | null;
  createdAt: string;
}

export interface TopicSeenEvidenceRecord {
  topicId: string;
  fingerprint: string;
  titleFingerprint: string;
  evidenceId: string;
  runId: string;
  seenAt: string;
}

export interface CommitTopicRunInput {
  runId: string;
  outcome: TopicRunOutcome;
  modelLabel: string | null;
  modelInvoked: boolean;
  sourceOutcomes: TopicSourceOutcome[];
  evidence: TopicEvidenceRecord[];
  collectedCount: number;
  keywordMissCount: number;
  droppedDuplicateCount: number;
  briefing: {
    id: string;
    title: string;
    markdown: string;
    exportPath: string | null;
  };
  seen: TopicSeenEvidenceRecord[];
  finishedAt: string;
}

export class TopicRunAlreadyActiveError extends Error {
  override readonly name = "TopicRunAlreadyActiveError";

  constructor() {
    super("This topic already has a running briefing.");
  }
}

export interface TopicDeskStore {
  createTopic(input: CreateTopicInput): Promise<TopicRecord>;
  updateTopic(id: string, input: UpdateTopicInput): Promise<TopicRecord | null>;
  getTopic(id: string): Promise<TopicRecord | null>;
  listTopics(): Promise<TopicRecord[]>;
  beginRun(input: BeginTopicRunInput): Promise<TopicRunRecord>;
  failRun(
    runId: string,
    error: { name: string; message: string },
    sourceOutcomes: TopicSourceOutcome[],
    counts: { collectedCount: number; keywordMissCount: number; droppedDuplicateCount: number },
    finishedAt: string,
  ): Promise<TopicRunRecord>;
  commitRun(input: CommitTopicRunInput): Promise<{
    run: TopicRunRecord;
    briefing: TopicBriefingRecord;
  }>;
  getRun(id: string): Promise<TopicRunRecord | null>;
  listRuns(topicId: string): Promise<TopicRunRecord[]>;
  getBriefingByRun(runId: string): Promise<TopicBriefingRecord | null>;
  listSeenEvidence(topicId: string, seenSince: string): Promise<TopicSeenEvidenceRecord[]>;
}
