import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileOutputPlugin } from "./index.js";

describe("file output plugin", () => {
  it("maps repeated delivery keys to one deterministic file artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "finance-ai-output-"));
    const outputPath = join(directory, "digest.md");
    const output = new FileOutputPlugin(outputPath);
    const artifact = {
      id: "run-1:digest",
      mediaType: "text/markdown",
      content: "# Digest",
    };
    const context = { deliveryKey: "stable-delivery-key" };

    try {
      const first = await output.deliver(artifact, context);
      const duplicate = await output.deliver(artifact, context);

      expect(first.deliveryId).toBe(duplicate.deliveryId);
      expect(first.target).toBe(duplicate.target);
      expect(await readdir(directory)).toEqual(["digest.md"]);
      expect(await readFile(outputPath, "utf8")).toBe(artifact.content);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
