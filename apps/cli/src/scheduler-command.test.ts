import { describe, expect, it } from "vitest";

import { renderLaunchdPlist } from "./scheduler-command.js";

describe("launchd scheduler", () => {
  it("renders a daily job with escaped paths and no secrets", () => {
    const plist = renderLaunchdPlist({
      label: "com.example.agent",
      projectDirectory: "/tmp/finance & ai",
      scriptPath: "/tmp/finance & ai/run.sh",
      nodePath: "/opt/homebrew/bin/node",
      pnpmPath: "/opt/homebrew/bin/pnpm",
      stdoutPath: "/tmp/agent.out.log",
      stderrPath: "/tmp/agent.err.log",
      hour: 8,
      minute: 30,
    });

    expect(plist).toContain("<integer>8</integer>");
    expect(plist).toContain("<integer>30</integer>");
    expect(plist).toContain("/tmp/finance &amp; ai/run.sh");
    expect(plist).not.toContain("WEBHOOK");
    expect(plist).not.toContain("API_KEY");
  });

  it("rejects invalid calendar values", () => {
    expect(() =>
      renderLaunchdPlist({
        label: "agent",
        projectDirectory: "/tmp",
        scriptPath: "/tmp/run.sh",
        nodePath: "/bin/node",
        pnpmPath: "/bin/pnpm",
        stdoutPath: "/tmp/out",
        stderrPath: "/tmp/err",
        hour: 24,
        minute: 0,
      }),
    ).toThrow("hour must be an integer from 0 to 23");
  });
});
