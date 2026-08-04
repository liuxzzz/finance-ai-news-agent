import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("daily scheduler script", () => {
  it("retries a failed live run and exits after the next success", async () => {
    const fixture = await createFixture("fail-once");
    const result = await execFileAsync("/bin/zsh", [fixture.script], {
      cwd: fixture.root,
      env: schedulerEnvironment(fixture),
    });
    const calls = await readFile(fixture.log, "utf8");

    expect(result.stderr).toContain("attempt 1 failed; retrying in 0s");
    expect(calls.match(/run-live/g)).toHaveLength(2);
    expect(calls).not.toContain("notify-failure");
  });

  it("sends one failure alert after exhausting the retry budget", async () => {
    const fixture = await createFixture("always-fail");
    let exitCode: number | string | undefined;

    try {
      await execFileAsync("/bin/zsh", [fixture.script], {
        cwd: fixture.root,
        env: { ...schedulerEnvironment(fixture), AGENT_SCHEDULE_MAX_ATTEMPTS: "2" },
      });
    } catch (error) {
      exitCode = (error as { code?: number | string }).code;
    }

    const calls = await readFile(fixture.log, "utf8");
    expect(exitCode).toBe(1);
    expect(calls.match(/run-live/g)).toHaveLength(2);
    expect(calls.match(/notify-failure/g)).toHaveLength(1);
  });
});

async function createFixture(mode: "always-fail" | "fail-once") {
  const root = await mkdtemp(resolve(tmpdir(), "finance-ai-daily-test-"));
  temporaryRoots.push(root);
  const scriptsDirectory = resolve(root, "scripts");
  const binDirectory = resolve(root, "bin");
  const script = resolve(scriptsDirectory, "run-daily.sh");
  const log = resolve(root, "calls.log");
  const counter = resolve(root, "counter");
  await mkdir(scriptsDirectory, { recursive: true });
  await mkdir(binDirectory, { recursive: true });
  await mkdir(resolve(root, "apps/cli/dist"), { recursive: true });
  await copyFile(resolve(process.cwd(), "../../scripts/run-daily.sh"), script);
  await chmod(script, 0o755);

  const pnpm = resolve(binDirectory, "pnpm");
  await writeFile(pnpm, '#!/bin/zsh\nprint -r -- "pnpm $*" >> "$TEST_CALL_LOG"\nexit 0\n');
  await chmod(pnpm, 0o755);

  const node = resolve(binDirectory, "node");
  await writeFile(
    node,
    [
      "#!/bin/zsh",
      'print -r -- "node $*" >> "$TEST_CALL_LOG"',
      'if [[ "$*" == *"notify-failure"* ]]; then exit 0; fi',
      'if [[ "$*" != *"run-live"* ]]; then exit 0; fi',
      mode === "always-fail"
        ? "exit 1"
        : 'if [[ ! -f "$TEST_COUNTER" ]]; then print 1 > "$TEST_COUNTER"; exit 1; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  await chmod(node, 0o755);

  return { root, script, log, counter, node, pnpm };
}

function schedulerEnvironment(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return {
    ...process.env,
    NODE_BIN: fixture.node,
    PNPM_BIN: fixture.pnpm,
    TEST_CALL_LOG: fixture.log,
    TEST_COUNTER: fixture.counter,
    AGENT_SCHEDULE_EDITION: "test-daily",
    AGENT_SCHEDULE_MAX_ATTEMPTS: "3",
    AGENT_SCHEDULE_RETRY_BASE_SECONDS: "0",
  };
}
