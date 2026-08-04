import { createHash } from "node:crypto";

import { EvidenceSchema, type Evidence } from "./agent-state.js";

const TRACKING_PARAMETERS = new Set([
  "f",
  "from",
  "ref",
  "rss",
  "source",
  "spm",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term",
]);

export function normalizeAndClusterEvidence(evidence: readonly Evidence[], limit = 24): Evidence[] {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 24) {
    throw new Error("Evidence normalization limit must be an integer from 1 to 24.");
  }

  const ordered = evidence
    .map((item) => ({ item, canonicalUrl: canonicalizeEvidenceUrl(item.url) }))
    .sort(
      (left, right) =>
        publishedTime(right.item) - publishedTime(left.item) ||
        left.canonicalUrl.localeCompare(right.canonicalUrl),
    );
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  const unique: Array<{ item: Evidence; canonicalUrl: string; normalizedTitle: string }> = [];

  for (const candidate of ordered) {
    const normalizedTitle = normalizeTitle(candidate.item.title);

    if (seenUrls.has(candidate.canonicalUrl) || seenTitles.has(normalizedTitle)) {
      continue;
    }

    seenUrls.add(candidate.canonicalUrl);
    seenTitles.add(normalizedTitle);
    unique.push({ ...candidate, normalizedTitle });

    if (unique.length >= limit) {
      break;
    }
  }

  const clusters: Array<{ id: string; representative: string }> = [];

  return unique.map(({ item, canonicalUrl, normalizedTitle }) => {
    const existing = clusters.find(
      (cluster) => titleSimilarity(cluster.representative, normalizedTitle) >= 0.68,
    );
    const clusterId =
      existing?.id ?? `cluster-${hashText(`${canonicalUrl}\u0000${normalizedTitle}`).slice(0, 20)}`;

    if (existing === undefined) {
      clusters.push({ id: clusterId, representative: normalizedTitle });
    }

    return EvidenceSchema.parse({
      ...item,
      canonicalUrl,
      fingerprint: hashText(`${canonicalUrl}\u0000${normalizedTitle}`),
      titleFingerprint: hashText(normalizedTitle),
      clusterId,
    });
  });
}

/** Selects evidence round-robin by source while preserving each source's ranking order. */
export function selectBalancedEvidence(evidence: readonly Evidence[], limit: number): Evidence[] {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 24) {
    throw new Error("Balanced evidence limit must be an integer from 1 to 24.");
  }

  const groups = new Map<string, Evidence[]>();

  for (const item of evidence) {
    const sourceKey =
      item.sourceId ?? item.source ?? new URL(item.canonicalUrl ?? item.url).hostname;
    const group = groups.get(sourceKey);

    if (group === undefined) {
      groups.set(sourceKey, [item]);
    } else {
      group.push(item);
    }
  }

  const queues = [...groups.values()];
  const selected: Evidence[] = [];

  while (selected.length < limit && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const item = queue.shift();

      if (item !== undefined) {
        selected.push(item);
      }

      if (selected.length >= limit) {
        break;
      }
    }
  }

  return selected;
}

export function canonicalizeEvidenceUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";

  for (const name of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETERS.has(name.toLocaleLowerCase("en-US")) || name.startsWith("utm_")) {
      url.searchParams.delete(name);
    }
  }

  url.searchParams.sort();
  return url.toString();
}

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function titleSimilarity(left: string, right: string): number {
  if (left === right) {
    return 1;
  }

  if (left.length < 8 || right.length < 8) {
    return 0;
  }

  const leftBigrams = characterBigrams(left);
  const rightBigrams = characterBigrams(right);
  let intersection = 0;

  for (const value of leftBigrams) {
    if (rightBigrams.has(value)) {
      intersection += 1;
    }
  }

  return (2 * intersection) / (leftBigrams.size + rightBigrams.size);
}

function characterBigrams(value: string): Set<string> {
  const characters = [...value];
  const output = new Set<string>();

  for (let index = 0; index < characters.length - 1; index += 1) {
    output.add(`${characters[index]}${characters[index + 1]}`);
  }

  return output;
}

function publishedTime(evidence: Evidence): number {
  if (evidence.publishedAt === undefined) {
    return 0;
  }

  const value = Date.parse(evidence.publishedAt);
  return Number.isFinite(value) ? value : 0;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
