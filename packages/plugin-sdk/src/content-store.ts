export interface NormalizedContentItemInput {
  id: string;
  runId: string;
  evidenceId: string;
  sourceId: string | null;
  source: string | null;
  url: string;
  canonicalUrl: string;
  title: string;
  excerpt: string;
  publishedAt: string | null;
  fingerprint: string;
  titleFingerprint: string;
  clusterId: string;
  createdAt: string;
}

export type NormalizedContentItemRecord = NormalizedContentItemInput;

export interface FindPreviouslySeenContentInput {
  runId: string;
  fingerprints: readonly string[];
  titleFingerprints: readonly string[];
  lookbackDays: number;
}

export interface PreviouslySeenContentRecord {
  runId: string;
  evidenceId: string;
  reportDate: string;
  fingerprint: string;
  titleFingerprint: string;
}

/** Durable boundary for deterministic evidence normalization output. */
export interface ContentStore {
  saveNormalizedContentItems(
    items: readonly NormalizedContentItemInput[],
  ): Promise<NormalizedContentItemRecord[]>;
  listNormalizedContentItems(runId: string): Promise<NormalizedContentItemRecord[]>;
  findPreviouslySeenContent(
    input: FindPreviouslySeenContentInput,
  ): Promise<PreviouslySeenContentRecord[]>;
}
