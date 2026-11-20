import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { TopicDeskError, type TopicDesk, type TopicDraftInput } from "@finance-ai-news-agent/core";
import type { TopicFeed } from "@finance-ai-news-agent/plugin-sdk";

import { topicDeskPage } from "./topic-desk-page.js";

export interface TopicDeskCatalogFeed {
  id: string;
  name: string;
  url: string;
  topic: string;
}

export interface TopicDeskServer {
  url: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 32_000;

export async function startTopicDeskServer(options: {
  desk: TopicDesk;
  catalog: readonly TopicDeskCatalogFeed[];
  mode: "e2e" | "live";
  modelLabel: string;
  host: string;
  port: number;
}): Promise<TopicDeskServer> {
  const host = assertLoopbackHost(options.host);
  const server = createServer((request, response) => {
    void handleRequest(request, response, { ...options, host }).catch((error: unknown) => {
      sendJson(response, 500, { error: { message: errorMessage(error) } });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Topic desk did not bind a TCP port.");
  }

  return {
    url: `http://${host === "::1" ? "[::1]" : host}:${address.port}`,
    async close() {
      await options.desk.settle();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

export function assertLoopbackHost(host: string): string {
  if (host === "localhost") {
    return "127.0.0.1";
  }

  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("Topic desk only listens on the local loopback interface.");
  }

  return host;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    desk: TopicDesk;
    catalog: readonly TopicDeskCatalogFeed[];
    mode: "e2e" | "live";
    modelLabel: string;
    host: string;
  },
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";

  try {
    const topicRuns = matchPath(url.pathname, /^\/api\/topics\/([^/]+)\/runs$/);
    const topic = matchPath(url.pathname, /^\/api\/topics\/([^/]+)$/);
    const runExport = matchPath(url.pathname, /^\/api\/runs\/([^/]+)\/export$/);
    const run = matchPath(url.pathname, /^\/api\/runs\/([^/]+)$/);
    if (method === "GET" && url.pathname === "/") {
      const html = topicDeskPage();
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(html),
      });
      response.end(html);
      return;
    }

    if (method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, {
        ok: true,
        mode: options.mode,
        modelLabel: options.modelLabel,
        liveModel: options.mode === "live",
        notifications: "disabled",
        host: options.host,
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/catalog") {
      sendJson(response, 200, options.catalog);
      return;
    }

    if (method === "GET" && url.pathname === "/api/topics") {
      sendJson(response, 200, await options.desk.listTopics());
      return;
    }

    if (method === "POST" && url.pathname === "/api/topics") {
      const draft = resolveDraft(await readJson(request), options.catalog);
      sendJson(response, 201, await options.desk.createTopic(draft));
      return;
    }

    if (topic !== null && method === "GET") {
      sendJson(response, 200, await options.desk.getTopic(topic));
      return;
    }

    if (topic !== null && method === "PATCH") {
      const draft = resolveDraft(await readJson(request), options.catalog);
      sendJson(response, 200, await options.desk.updateTopic(topic, draft));
      return;
    }

    if (topicRuns !== null && method === "GET") {
      sendJson(response, 200, await options.desk.listRuns(topicRuns));
      return;
    }

    if (topicRuns !== null && method === "POST") {
      sendJson(response, 202, await options.desk.startRun(topicRuns));
      return;
    }

    if (run !== null && method === "GET") {
      sendJson(response, 200, await options.desk.getRunDetail(run));
      return;
    }

    if (runExport !== null && method === "GET") {
      const detail = await options.desk.getRunDetail(runExport);

      if (detail.briefing === null) {
        sendJson(response, 404, { error: { message: "This run has no briefing to export." } });
        return;
      }

      response.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="topic-briefing-${detail.run.id}.md"`,
        "cache-control": "no-store",
      });
      response.end(detail.briefing.markdown);
      return;
    }

    sendJson(response, 404, { error: { message: "Not found." } });
  } catch (error) {
    const status = error instanceof TopicDeskError ? error.statusCode : 500;
    sendJson(response, status, { error: { message: errorMessage(error) } });
  }
}

function resolveDraft(body: unknown, catalog: readonly TopicDeskCatalogFeed[]): TopicDraftInput {
  if (!isRecord(body)) {
    throw new TopicDeskError(400, "Topic body must be a JSON object.");
  }

  const feedIds = stringArray(body.feedIds, "feedIds");
  const customFeeds = feedArray(body.customFeeds);
  const catalogById = new Map(catalog.map((feed) => [feed.id, feed]));
  const feeds: TopicFeed[] = [];

  for (const id of feedIds) {
    const feed = catalogById.get(id);

    if (feed === undefined) {
      throw new TopicDeskError(400, `Unknown catalog feed: ${id}.`);
    }

    feeds.push({ id: feed.id, url: feed.url, name: feed.name });
  }

  feeds.push(...customFeeds);
  const windowHours =
    body.windowHours === undefined ? undefined : finiteNumber(body.windowHours, "windowHours");
  const lookbackDays =
    body.lookbackDays === undefined ? undefined : finiteNumber(body.lookbackDays, "lookbackDays");

  return {
    name: requiredString(body.name, "name"),
    keywords: stringArray(body.keywords, "keywords"),
    feeds,
    ...(windowHours === undefined ? {} : { windowHours }),
    ...(lookbackDays === undefined ? {} : { lookbackDays }),
    ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
  };
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TopicDeskError(400, `${label} must be a string array.`);
  }

  return value;
}

function feedArray(value: unknown): TopicFeed[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new TopicDeskError(400, "customFeeds must be an array.");
  }

  return value.map((item) => {
    if (!isRecord(item)) {
      throw new TopicDeskError(400, "Each custom feed must be an object.");
    }

    const name =
      item.name === undefined ? undefined : requiredString(item.name, "custom feed name");
    return {
      id: requiredString(item.id, "custom feed id"),
      url: requiredString(item.url, "custom feed url"),
      ...(name === undefined ? {} : { name }),
    };
  });
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TopicDeskError(400, `${label} must be a string.`);
  }

  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TopicDeskError(400, `${label} must be a number.`);
  }

  return value;
}

function matchPath(pathname: string, pattern: RegExp): string | null {
  const match = pattern.exec(pathname);
  const id = match?.[1];

  if (id === undefined) {
    return null;
  }

  const decoded = decodeURIComponent(id);

  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/.test(decoded)) {
    throw new TopicDeskError(400, "Identifier is invalid.");
  }

  return decoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;

    if (size > MAX_BODY_BYTES) {
      throw new TopicDeskError(400, "Topic body is too large.");
    }

    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new TopicDeskError(400, "Topic body must be JSON.");
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) {
    return;
  }

  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
