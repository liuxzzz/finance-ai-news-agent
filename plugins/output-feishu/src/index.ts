import { createHash, createHmac } from "node:crypto";

import type {
  DeliveryContext,
  DeliveryReceipt,
  OutputPlugin,
  PluginManifest,
  RenderedArtifact,
} from "@finance-ai-news-agent/plugin-sdk";
import { z } from "zod";

const MAX_REQUEST_BYTES = 20 * 1_024;
const DEFAULT_TIMEOUT_MS = 10_000;

const FeishuResponseSchema = z
  .object({
    code: z.number().int(),
    msg: z.string(),
  })
  .passthrough();

export interface FeishuWebhookOutputOptions {
  webhookUrl: string;
  signingSecret?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

export class FeishuWebhookOutputPlugin implements OutputPlugin {
  readonly deliverySemantics = "idempotent-by-key" as const;

  readonly manifest: PluginManifest = {
    id: "output-feishu-webhook",
    name: "Feishu Custom Bot Webhook",
    version: "0.0.0",
    kind: "output",
    coreCompatibility: ">=0.0.0",
  };

  readonly target: string;

  private readonly webhookUrl: URL;
  private readonly signingSecret: string | undefined;
  private readonly timeoutMs: number;
  private readonly request: typeof fetch;
  private readonly now: () => Date;

  constructor(options: FeishuWebhookOutputOptions) {
    this.webhookUrl = validateFeishuWebhookUrl(options.webhookUrl);
    this.signingSecret = trimmedOptional(options.signingSecret);
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.request = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.target = `feishu-webhook:${fingerprint(this.webhookUrl.toString())}`;
  }

  async deliver(artifact: RenderedArtifact, context: DeliveryContext): Promise<DeliveryReceipt> {
    const message = renderFeishuText(artifact.content);
    const body: Record<string, unknown> = {
      msg_type: "text",
      content: { text: message },
    };

    if (this.signingSecret !== undefined) {
      const timestamp = Math.floor(this.now().getTime() / 1_000).toString();
      body.timestamp = timestamp;
      body.sign = createFeishuSignature(timestamp, this.signingSecret);
    }

    const encoded = JSON.stringify(body);

    if (Buffer.byteLength(encoded, "utf8") > MAX_REQUEST_BYTES) {
      throw new Error(
        `Feishu webhook payload exceeds ${MAX_REQUEST_BYTES} bytes; render a shorter digest before delivery.`,
      );
    }

    const response = await this.request(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: encoded,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(`Feishu webhook returned HTTP ${response.status}.`);
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(responseText);
    } catch (error) {
      throw new Error("Feishu webhook returned invalid JSON.", { cause: error });
    }

    const result = FeishuResponseSchema.parse(parsed);

    if (result.code !== 0) {
      throw new Error(
        `Feishu webhook rejected the message with code ${result.code}: ${result.msg}`,
      );
    }

    return {
      deliveryId: `feishu-${fingerprint(context.deliveryKey)}`,
      target: this.target,
      deliveredAt: this.now().toISOString(),
    };
  }
}

export function validateFeishuWebhookUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("FEISHU_BOT_WEBHOOK_URL must be a valid URL.");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "open.feishu.cn" ||
    !/^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]+$/.test(url.pathname) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("FEISHU_BOT_WEBHOOK_URL must be an official Feishu V2 custom bot webhook URL.");
  }

  return url;
}

export function createFeishuSignature(timestamp: string, secret: string): string {
  return createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
}

export function renderFeishuText(markdown: string): string {
  const content = markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)]\(<([^>]+)>\)/g, "$1\n$2")
    .replace(/\[([^\]]+)]\((https?:\/\/[^)]+)\)/g, "$1\n$2")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return `Finance AI News Agent\n\n${content}`;
}

function trimmedOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
