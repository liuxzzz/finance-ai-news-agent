import {
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type PluginManifest,
} from "@finance-ai-news-agent/plugin-sdk";
import { generateText, type LanguageModel } from "ai";

export class AiSdkModelProvider implements ModelProvider {
  readonly manifest: PluginManifest = {
    id: "model-ai-sdk",
    name: "AI SDK Model Provider",
    version: "0.0.0",
    kind: "model",
    coreCompatibility: ">=0.0.0",
  };

  constructor(
    private readonly model: LanguageModel,
    private readonly modelName: string,
  ) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const result = await generateText({
      model: this.model,
      system: request.system,
      prompt: request.prompt,
      ...(request.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: request.maxOutputTokens }),
    });
    const usage: NonNullable<ModelResponse["usage"]> = {};

    if (result.usage.inputTokens !== undefined) {
      usage.inputTokens = result.usage.inputTokens;
    }

    if (result.usage.outputTokens !== undefined) {
      usage.outputTokens = result.usage.outputTokens;
    }

    return {
      text: result.text,
      model: this.modelName,
      usage,
    };
  }
}
