export interface StoryEventInput {
  storyId: string;
  headline: string;
  normalizedHeadline: string;
  titleFingerprint: string;
  evidenceIds: readonly string[];
}

export interface SaveStoryEventUpdatesInput {
  runId: string;
  stories: readonly StoryEventInput[];
  observedAt: string;
  lookbackDays: number;
}

export interface StoryEventRecord {
  id: string;
  tenantId: string;
  topic: string;
  canonicalHeadline: string;
  normalizedHeadline: string;
  titleFingerprint: string;
  latestHeadline: string;
  firstSeenDate: string;
  lastSeenDate: string;
  firstRunId: string;
  latestRunId: string;
  updateCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoryEventUpdateRecord {
  id: string;
  eventId: string;
  runId: string;
  storyId: string;
  headline: string;
  evidenceIds: string[];
  observedAt: string;
  createdAt: string;
}

export interface SavedStoryEventUpdate {
  event: StoryEventRecord;
  update: StoryEventUpdateRecord;
  isNewEvent: boolean;
  isNewUpdate: boolean;
}

/** Durable event timeline built from approved, evidence-grounded stories. */
export interface StoryMemoryStore {
  saveStoryEventUpdates(input: SaveStoryEventUpdatesInput): Promise<SavedStoryEventUpdate[]>;
  listStoryEventUpdates(runId: string): Promise<StoryEventUpdateRecord[]>;
  listStoryEventsForRun(runId: string): Promise<StoryEventRecord[]>;
}
