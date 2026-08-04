import { describe, expect, it } from "vitest";

import type { Evidence } from "./agent-state.js";
import {
  canonicalizeEvidenceUrl,
  normalizeAndClusterEvidence,
  selectBalancedEvidence,
} from "./evidence-normalizer.js";

describe("evidence normalizer", () => {
  it("removes tracking parameters and sorts the remaining query", () => {
    expect(
      canonicalizeEvidenceUrl("https://example.com/news?utm_source=rss&b=2&f=rss&a=1#article"),
    ).toBe("https://example.com/news?a=1&b=2");
  });

  it("deduplicates canonical URLs and titles while preserving the newest evidence", () => {
    const output = normalizeAndClusterEvidence([
      evidence("older", "同一新闻标题", "https://example.com/news?utm_source=rss", "2026-08-03"),
      evidence("newer", "同一新闻标题", "https://example.com/news?f=rss", "2026-08-04"),
      evidence("duplicate-title", "同一新闻标题！", "https://other.example/news", "2026-08-02"),
    ]);

    expect(output).toHaveLength(1);
    expect(output[0]).toEqual(
      expect.objectContaining({
        id: "newer",
        canonicalUrl: "https://example.com/news",
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        titleFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        clusterId: expect.stringMatching(/^cluster-/),
      }),
    );
  });

  it("assigns similar cross-source titles to the same deterministic cluster", () => {
    const output = normalizeAndClusterEvidence([
      evidence(
        "source-a",
        "OpenAI发布全新医疗健康产品并进入医院",
        "https://a.example/openai-health",
        "2026-08-04",
      ),
      evidence(
        "source-b",
        "OpenAI发布医疗健康产品，正式进入医院市场",
        "https://b.example/openai-health",
        "2026-08-04",
      ),
      evidence(
        "unrelated",
        "英伟达公布新一季度芯片业务财报",
        "https://c.example/nvidia",
        "2026-08-04",
      ),
    ]);

    expect(output[0]?.clusterId).toBe(output[1]?.clusterId);
    expect(output[2]?.clusterId).not.toBe(output[0]?.clusterId);
  });

  it("balances the final selection after filtering", () => {
    const input = [
      evidence("a-1", "Source A one", "https://a.example/1", "2026-08-04"),
      evidence("a-2", "Source A two", "https://a.example/2", "2026-08-04"),
      evidence("a-3", "Source A three", "https://a.example/3", "2026-08-04"),
      evidence("b-1", "Source B one", "https://b.example/1", "2026-08-04"),
      evidence("c-1", "Source C one", "https://c.example/1", "2026-08-04"),
    ].map((item) => ({ ...item, sourceId: item.id.slice(0, 1) }));

    expect(selectBalancedEvidence(input, 3).map((item) => item.id)).toEqual(["a-1", "b-1", "c-1"]);
  });
});

function evidence(id: string, title: string, url: string, date: string): Evidence {
  return {
    id,
    title,
    url,
    excerpt: `${title}的证据摘录`,
    source: id,
    publishedAt: `${date}T10:00:00.000Z`,
  };
}
