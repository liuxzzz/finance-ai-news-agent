import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { projectRoot } from "./runtime-command.js";

const execFileAsync = promisify(execFile);
const SCHEDULER_LABEL = "com.finance-ai-news-agent.daily";

export interface LaunchdScheduleOptions {
  label: string;
  projectDirectory: string;
  scriptPath: string;
  nodePath: string;
  pnpmPath: string;
  stdoutPath: string;
  stderrPath: string;
  hour: number;
  minute: number;
}

export async function manageDailySchedule(args: string[]): Promise<void> {
  const normalizedArgs = args.filter((argument) => argument !== "--");
  const action = normalizedArgs[0] ?? "status";

  if (process.platform !== "darwin") {
    throw new Error("The built-in scheduler installer currently supports macOS launchd only.");
  }

  if (action === "install") {
    await installDailySchedule(normalizedArgs.slice(1));
    return;
  }

  if (action === "status") {
    await showDailyScheduleStatus();
    return;
  }

  if (action === "uninstall") {
    await uninstallDailySchedule();
    return;
  }

  throw new Error("Schedule action must be install, status, or uninstall.");
}

export function renderLaunchdPlist(options: LaunchdScheduleOptions): string {
  const hour = calendarValue(options.hour, 0, 23, "hour");
  const minute = calendarValue(options.minute, 0, 59, "minute");
  const string = (value: string) => `<string>${escapeXml(value)}</string>`;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  ${string(options.label)}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    "    <string>/bin/zsh</string>",
    `    ${string(options.scriptPath)}`,
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  ${string(options.projectDirectory)}`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>NODE_BIN</key>",
    `    ${string(options.nodePath)}`,
    "    <key>PNPM_BIN</key>",
    `    ${string(options.pnpmPath)}`,
    "  </dict>",
    "  <key>StartCalendarInterval</key>",
    "  <dict>",
    "    <key>Hour</key>",
    `    <integer>${hour}</integer>`,
    "    <key>Minute</key>",
    `    <integer>${minute}</integer>`,
    "  </dict>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>RunAtLoad</key>",
    "  <false/>",
    "  <key>StandardOutPath</key>",
    `  ${string(options.stdoutPath)}`,
    "  <key>StandardErrorPath</key>",
    `  ${string(options.stderrPath)}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

async function installDailySchedule(args: string[]): Promise<void> {
  const hour = optionInteger(args, "--hour", 8, 0, 23);
  const minute = optionInteger(args, "--minute", 0, 0, 59);
  const root = projectRoot();
  const scriptPath = resolve(root, "scripts/run-daily.sh");
  const artifactsDirectory = resolve(root, ".artifacts");
  const launchAgentsDirectory = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(launchAgentsDirectory, `${SCHEDULER_LABEL}.plist`);
  const nodePath = process.execPath;
  const pnpmPath = await resolveExecutable("pnpm");

  await readFile(scriptPath, "utf8");
  await mkdir(artifactsDirectory, { recursive: true });
  await mkdir(launchAgentsDirectory, { recursive: true });
  await chmod(scriptPath, 0o755);
  await writeFile(
    plistPath,
    renderLaunchdPlist({
      label: SCHEDULER_LABEL,
      projectDirectory: root,
      scriptPath,
      nodePath,
      pnpmPath,
      stdoutPath: resolve(artifactsDirectory, "scheduler.stdout.log"),
      stderrPath: resolve(artifactsDirectory, "scheduler.stderr.log"),
      hour,
      minute,
    }),
    { encoding: "utf8", mode: 0o600 },
  );

  await ignoreLaunchctlFailure(["bootout", launchdDomain(), plistPath]);
  await execFileAsync("/bin/launchctl", ["bootstrap", launchdDomain(), plistPath]);
  await execFileAsync("/bin/launchctl", ["enable", `${launchdDomain()}/${SCHEDULER_LABEL}`]);
  process.stdout.write(`Daily schedule installed for ${pad(hour)}:${pad(minute)} local time.\n`);
}

async function showDailyScheduleStatus(): Promise<void> {
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${SCHEDULER_LABEL}.plist`);

  try {
    await readFile(plistPath, "utf8");
    const result = await execFileAsync("/bin/launchctl", [
      "print",
      `${launchdDomain()}/${SCHEDULER_LABEL}`,
    ]);
    const state = /state = ([^\n]+)/.exec(result.stdout)?.[1]?.trim() ?? "loaded";
    process.stdout.write(`Daily schedule is installed (${state}).\n`);
  } catch {
    process.stdout.write("Daily schedule is not installed.\n");
  }
}

async function uninstallDailySchedule(): Promise<void> {
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${SCHEDULER_LABEL}.plist`);
  await ignoreLaunchctlFailure(["bootout", launchdDomain(), plistPath]);
  await rm(plistPath, { force: true });
  process.stdout.write("Daily schedule uninstalled.\n");
}

async function resolveExecutable(name: string): Promise<string> {
  const result = await execFileAsync("/usr/bin/which", [name]);
  const value = result.stdout.trim();

  if (value.length === 0) {
    throw new Error(`${name} is not available on PATH.`);
  }

  return value;
}

async function ignoreLaunchctlFailure(args: string[]): Promise<void> {
  try {
    await execFileAsync("/bin/launchctl", args);
  } catch {
    // An absent or unloaded job is the expected first-install state.
  }
}

function optionInteger(
  args: string[],
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const index = args.indexOf(name);

  if (index === -1) {
    return fallback;
  }

  const text = args[index + 1];

  if (text === undefined || !/^\d+$/.test(text)) {
    throw new Error(`${name} requires an integer value.`);
  }

  return calendarValue(Number(text), minimum, maximum, name);
}

function calendarValue(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }

  return value;
}

function launchdDomain(): string {
  const uid = process.getuid?.();

  if (uid === undefined) {
    throw new Error("Cannot determine the current macOS user ID.");
  }

  return `gui/${uid}`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
