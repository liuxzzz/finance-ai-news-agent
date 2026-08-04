import { describe, expect, it } from "vitest";

import { storyHeadlineSimilarity } from "./runtime-store.js";

describe("story event matching", () => {
  it("matches wording changes for the same event", () => {
    expect(
      storyHeadlineSimilarity(
        "openai发布全新医疗健康产品并进入医院",
        "openai发布医疗健康产品正式进入医院市场",
      ),
    ).toBeGreaterThanOrEqual(0.62);
  });

  it("does not merge unrelated events", () => {
    expect(
      storyHeadlineSimilarity(
        "openai发布全新医疗健康产品并进入医院",
        "英伟达公布新一季度芯片业务财报",
      ),
    ).toBeLessThan(0.62);
  });
});
