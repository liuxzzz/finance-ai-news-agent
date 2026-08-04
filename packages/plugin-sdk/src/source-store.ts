import { z } from "zod";

import type { JsonObject, SerializedError } from "./runtime-store.js";

export const SourceRunStatusSchema = z.enum(["succeeded", "failed"]);

export type SourceRunStatus = z.infer<typeof SourceRunStatusSchema>;

export interface RawSourceItemInput {
  id: string;
  runId: string;
  sourceRunId: string;
  sourceId: string;
  externalId: string | null;
  url: string;
  title: string;
  excerpt: string;
  publishedAt: string;
  collectedAt: string;
  contentHash: string;
  raw: JsonObject;
}

export interface RawSourceItemRecord extends RawSourceItemInput {
  createdAt: string;
}

export interface RecordSourceCollectionInput {
  id: string;
  runId: string;
  sourceId: string;
  sourceUrlFingerprint: string;
  status: SourceRunStatus;
  itemCount: number;
  error: SerializedError | null;
  startedAt: string;
  finishedAt: string;
  items: RawSourceItemInput[];
}

export interface SourceRunRecord extends Omit<RecordSourceCollectionInput, "items"> {
  attempt: number;
  createdAt: string;
}

/** Durable audit boundary for source fetches and their raw parsed items. */
export interface SourceAuditStore {
  recordSourceCollection(input: RecordSourceCollectionInput): Promise<SourceRunRecord>;
  listSourceRuns(runId: string): Promise<SourceRunRecord[]>;
  listRawSourceItems(runId: string): Promise<RawSourceItemRecord[]>;
}
