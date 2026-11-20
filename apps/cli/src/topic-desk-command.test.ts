import { describe, expect, it } from "vitest";

import { resolveTopicDeskRuntime } from "./topic-desk-command.js";
import { assertLoopbackHost } from "./topic-desk-server.js";

describe("topic desk runtime", () => {
  it("stays on the labeled local stub when a model key is present", () => {
    const runtime = resolveTopicDeskRuntime({
      DEEPSEEK_API_KEY: "not-used",
      TOPIC_DESK_STUB_FAILURES: "2",
    });

    expect(runtime.mode).toBe("e2e");
    expect(runtime.model.mode).toBe("stub");
    expect(runtime.model.label).toBe("local-stub/topic-desk-stub@1");
  });

  it("refuses live model mode without the explicit gate", () => {
    expect(() =>
      resolveTopicDeskRuntime({
        TOPIC_DESK_MODE: "live",
        DEEPSEEK_API_KEY: "not-used",
      }),
    ).toThrow(/TOPIC_DESK_ALLOW_LIVE_MODEL/);
  });

  it("refuses stub fault injection in live mode", () => {
    expect(() =>
      resolveTopicDeskRuntime({
        TOPIC_DESK_MODE: "live",
        TOPIC_DESK_ALLOW_LIVE_MODEL: "1",
        TOPIC_DESK_STUB_FAILURES: "1",
        DEEPSEEK_API_KEY: "not-used",
      }),
    ).toThrow(/e2e mode/);
  });

  it("listens only on loopback", () => {
    expect(assertLoopbackHost("localhost")).toBe("127.0.0.1");
    expect(() => assertLoopbackHost("0.0.0.0")).toThrow(/loopback/);
  });
});
