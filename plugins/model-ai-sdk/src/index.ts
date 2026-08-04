import {
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type PluginManifest,
  StructuredModelOutputError,
  type StructuredModelProvider,
  type StructuredModelRequest,
  type StructuredModelResponse,
} from "@finance-ai-news-agent/plugin-sdk";
import { createDeepSeek } from "@ai-sdk/deepseek";
import {
  generateText,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  type JSONValue,
  type LanguageModel,
} from "ai";

export interface DeepSeekModelProviderOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  thinkingMode?: DeepSeekThinkingMode;
}

export type DeepSeekThinkingMode = "adaptive" | "enabled" | "disabled";

type DeepSeekProviderOptions = Record<string, Record<string, JSONValue>>;

export class AiSdkModelProvider implements ModelProvider, StructuredModelProvider {
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
    private readonly providerOptions?: DeepSeekProviderOptions,
  ) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const result = await generateText({
      model: this.model,
      system: request.system,
      prompt: request.prompt,
      ...(request.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: request.maxOutputTokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
      ...(request.maxRetries === undefined ? {} : { maxRetries: request.maxRetries }),
      ...(this.providerOptions === undefined ? {} : { providerOptions: this.providerOptions }),
    });

    return {
      text: result.text,
      model: this.modelName,
      finishReason: result.finishReason,
      usage: mapUsage(result.usage),
    };
  }

  async generateStructured<OUTPUT>(
    request: StructuredModelRequest<OUTPUT>,
  ): Promise<StructuredModelResponse<OUTPUT>> {
    try {
      const result = await generateText({
        model: this.model,
        system: request.system,
        prompt: request.prompt,
        output: Output.object({
          schema: request.schema,
          name: request.schemaName,
          ...(request.schemaDescription === undefined
            ? {}
            : { description: request.schemaDescription }),
        }),
        ...(request.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: request.maxOutputTokens }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
        ...(request.maxRetries === undefined ? {} : { maxRetries: request.maxRetries }),
        ...(this.providerOptions === undefined ? {} : { providerOptions: this.providerOptions }),
      });

      if (result.finishReason !== "stop") {
        throw new StructuredModelOutputError(
          `Structured generation stopped with finish reason ${result.finishReason}.`,
          { usage: mapUsage(result.usage) },
        );
      }

      return {
        value: result.output,
        model: this.modelName,
        finishReason: result.finishReason,
        usage: mapUsage(result.usage),
      };
    } catch (error) {
      if (error instanceof StructuredModelOutputError) {
        throw error;
      }

      if (NoObjectGeneratedError.isInstance(error)) {
        throw new StructuredModelOutputError(
          "The model returned empty, invalid JSON, or schema-invalid structured output.",
          {
            cause: error,
            ...(error.usage === undefined ? {} : { usage: mapUsage(error.usage) }),
          },
        );
      }

      if (NoOutputGeneratedError.isInstance(error)) {
        throw new StructuredModelOutputError("The model returned no structured output.", {
          cause: error,
        });
      }

      throw error;
    }
  }
}

export function createDeepSeekModelProvider(
  options: DeepSeekModelProviderOptions,
): AiSdkModelProvider {
  assertDeepSeekProviderOptions(options);
  const deepseek = createDeepSeek({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
  });

  return new AiSdkModelProvider(deepseek(options.model), options.model, {
    deepseek: {
      thinking: {
        type: options.thinkingMode ?? "disabled",
      },
    },
  });
}

function assertDeepSeekProviderOptions(options: DeepSeekModelProviderOptions): void {
  if (options.apiKey.trim().length === 0) {
    throw new Error("DeepSeek apiKey cannot be empty.");
  }

  if (options.model.trim().length === 0 || hasUnsafeModelCharacter(options.model)) {
    throw new Error("DeepSeek model must be a non-empty identifier without whitespace.");
  }

  const url = new URL(options.baseURL);
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";

  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("DeepSeek baseURL must use HTTPS except for loopback test servers.");
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("DeepSeek baseURL must not contain credentials.");
  }

  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error("DeepSeek baseURL must not contain query parameters or fragments.");
  }

  if (url.pathname.replace(/\/+$/, "").endsWith("/chat/completions")) {
    throw new Error("DeepSeek baseURL must be an API root, not a chat completion endpoint.");
  }
}

function mapUsage(usage: {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
}): NonNullable<ModelResponse["usage"]> {
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
  };
}

function hasUnsafeModelCharacter(model: string): boolean {
  return [...model].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 32 || codePoint === 127);
  });
}
