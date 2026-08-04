import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  createDeepSeekModelSnapshot,
  resolveDeepSeekRuntimeConfig,
} from "./ai-runtime-command.js";

describe("DeepSeek runtime configuration", () => {
  it("uses safe defaults without including the API key in the model snapshot", () => {
    const config = resolveDeepSeekRuntimeConfig({
      DEEPSEEK_API_KEY: " local-secret ",
    });
    const snapshot = createDeepSeekModelSnapshot(config);

    expect(config).toEqual({
      apiKey: "local-secret",
      baseURL: DEFAULT_DEEPSEEK_BASE_URL,
      model: DEFAULT_DEEPSEEK_MODEL,
    });
    expect(JSON.stringify(snapshot)).not.toContain("local-secret");
    expect(JSON.stringify(snapshot)).not.toContain(DEFAULT_DEEPSEEK_BASE_URL);
  });

  it("accepts a custom API root but rejects a complete chat endpoint", () => {
    expect(
      resolveDeepSeekRuntimeConfig({
        DEEPSEEK_API_KEY: "secret",
        DEEPSEEK_BASE_URL: "https://gateway.example.com/deepseek/v1/",
        DEEPSEEK_MODEL: "custom-model",
      }),
    ).toEqual({
      apiKey: "secret",
      baseURL: "https://gateway.example.com/deepseek/v1",
      model: "custom-model",
    });

    expect(() =>
      resolveDeepSeekRuntimeConfig({
        DEEPSEEK_API_KEY: "secret",
        DEEPSEEK_BASE_URL: "https://api.deepseek.com/chat/completions",
      }),
    ).toThrow("must be the API root");
  });

  it("requires a local API key without echoing a secret value", () => {
    expect(() => resolveDeepSeekRuntimeConfig({})).toThrow(
      "DEEPSEEK_API_KEY is required for run-ai",
    );
  });

  it("never sends a bearer key over non-loopback HTTP", () => {
    expect(() =>
      resolveDeepSeekRuntimeConfig({
        DEEPSEEK_API_KEY: "secret",
        DEEPSEEK_BASE_URL: "http://gateway.example.com/v1",
      }),
    ).toThrow("must use HTTPS");

    expect(
      resolveDeepSeekRuntimeConfig({
        DEEPSEEK_API_KEY: "secret",
        DEEPSEEK_BASE_URL: "http://127.0.0.1:8080/v1",
      }).baseURL,
    ).toBe("http://127.0.0.1:8080/v1");
  });
});
