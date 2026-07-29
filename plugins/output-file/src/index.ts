import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  type DeliveryReceipt,
  type OutputPlugin,
  type PluginManifest,
  type RenderedArtifact,
} from "@finance-ai-news-agent/plugin-sdk";

export class FileOutputPlugin implements OutputPlugin {
  readonly manifest: PluginManifest = {
    id: "output-file",
    name: "Local File Output",
    version: "0.0.0",
    kind: "output",
    coreCompatibility: ">=0.0.0",
  };

  constructor(private readonly outputPath: string) {}

  async deliver(artifact: RenderedArtifact): Promise<DeliveryReceipt> {
    const target = resolve(this.outputPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, artifact.content, "utf8");

    return {
      deliveryId: artifact.id,
      target,
      deliveredAt: new Date().toISOString(),
    };
  }
}
