import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  completeDouyinLogin,
  inspectStorageState,
  resolveDefaultExecutablePath,
  resolveDefaultStorageStatePath,
  saveReviewSessionStorageState,
  startDouyinLogin,
  runPublishTask,
  verifyDouyinLogin
} from "@social-publisher/worker/lib.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "../public");
const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST ?? "127.0.0.1";

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

async function serveStatic(response: ServerResponse): Promise<void> {
  const html = await readFile(path.join(publicDir, "index.html"), "utf8");
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/") {
      await serveStatic(response);
      return;
    }

    if (request.method === "POST" && request.url === "/api/run") {
      const rawBody = await readBody(request);
      const body = JSON.parse(rawBody) as {
        platform?: "douyin" | "wechat_channels" | "xiaohongshu" | "youtube";
        videoPath?: string;
        title?: string;
        description?: string;
        tags?: string[];
        mentions?: string[];
        location?: string;
        visibility?: "public" | "private" | "friends";
        coverMode?: "auto" | "custom";
        declareOriginal?: boolean;
        allowComments?: boolean;
        allowDuet?: boolean;
        allowStitch?: boolean;
        allowDownload?: boolean;
        scheduledAt?: string;
        storageStatePath?: string;
        executablePath?: string;
        headless?: boolean;
      };

      if (!body.videoPath) {
        sendJson(response, 400, { error: "videoPath is required" });
        return;
      }

      const output = await runPublishTask({
        platform: body.platform ?? "douyin",
        videoPath: body.videoPath,
        title: body.title,
        description: body.description,
        tags: body.tags,
        mentions: body.mentions,
        location: body.location,
        visibility: body.visibility,
        coverMode: body.coverMode,
        declareOriginal: body.declareOriginal,
        allowComments: body.allowComments,
        allowDuet: body.allowDuet,
        allowStitch: body.allowStitch,
        allowDownload: body.allowDownload,
        scheduledAt: body.scheduledAt,
        storageStatePath: body.storageStatePath || resolveDefaultStorageStatePath(),
        executablePath: body.executablePath || resolveDefaultExecutablePath(),
        headless: body.headless ?? false
      });

      sendJson(response, 200, output);
      return;
    }

    if (request.method === "POST" && request.url === "/api/login") {
      const rawBody = await readBody(request);
      const body = rawBody
        ? (JSON.parse(rawBody) as {
            executablePath?: string;
          })
        : {};

      const output = await startDouyinLogin({
        executablePath: body.executablePath || resolveDefaultExecutablePath(),
        headless: false
      });

      sendJson(response, 200, output);
      return;
    }

    if (request.method === "POST" && request.url === "/api/login/complete") {
      const rawBody = await readBody(request);
      const body = JSON.parse(rawBody) as {
        sessionId?: string;
        storageStatePath?: string;
      };

      if (!body.sessionId) {
        sendJson(response, 400, { error: "sessionId is required" });
        return;
      }

      const output = await completeDouyinLogin({
        sessionId: body.sessionId,
        storageStatePath: body.storageStatePath || resolveDefaultStorageStatePath()
      });

      sendJson(response, 200, output);
      return;
    }

    if (request.method === "POST" && request.url === "/api/session/save") {
      const rawBody = await readBody(request);
      const body = JSON.parse(rawBody) as {
        sessionId?: string;
        storageStatePath?: string;
      };

      if (!body.sessionId) {
        sendJson(response, 400, { error: "sessionId is required" });
        return;
      }

      const output = await saveReviewSessionStorageState({
        sessionId: body.sessionId,
        storageStatePath: body.storageStatePath || resolveDefaultStorageStatePath()
      });

      sendJson(response, 200, output);
      return;
    }

    if (request.method === "GET" && request.url === "/api/defaults") {
      const storageStatePath = resolveDefaultStorageStatePath();
      const session = await inspectStorageState(storageStatePath);
      sendJson(response, 200, {
        platforms: [
          { id: "douyin", label: "抖音", status: "available" },
          { id: "wechat_channels", label: "微信", status: "coming_soon" },
          { id: "xiaohongshu", label: "小红书", status: "coming_soon" },
          { id: "youtube", label: "YouTube", status: "coming_soon" }
        ],
        executablePath: resolveDefaultExecutablePath(),
        storageStatePath,
        session,
        port
      });
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/api/session")) {
      const requestUrl = new URL(request.url, `http://${host}:${port}`);
      const storageStatePath = requestUrl.searchParams.get("storageStatePath") || resolveDefaultStorageStatePath();
      const session = await inspectStorageState(storageStatePath);
      sendJson(response, 200, session);
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/api/login-status")) {
      const requestUrl = new URL(request.url, `http://${host}:${port}`);
      const storageStatePath = requestUrl.searchParams.get("storageStatePath") || resolveDefaultStorageStatePath();
      const executablePath = requestUrl.searchParams.get("executablePath") || resolveDefaultExecutablePath();
      const verification = await verifyDouyinLogin({
        storageStatePath,
        executablePath,
        headless: true
      });
      sendJson(response, 200, verification);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    sendJson(response, 500, { error: message });
  }
});

server.listen(port, host, () => {
  console.log(`social-publisher web ui listening on http://${host}:${port}`);
});
