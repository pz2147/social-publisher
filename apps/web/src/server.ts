import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { Readable } from "node:stream";
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
const uploadsDir = path.join(__dirname, "../../../storage/uploads");

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

function openPathInFinder(targetPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("open", [targetPath], (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function serveStatic(response: ServerResponse): Promise<void> {
  const html = await readFile(path.join(publicDir, "index.html"), "utf8");
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

async function parseMultipartForm(request: IncomingMessage): Promise<FormData> {
  const url = `http://${host}:${port}${request.url ?? "/"}`;
  const webRequest = new Request(url, {
    method: request.method,
    headers: request.headers as HeadersInit,
    body: Readable.toWeb(request) as ReadableStream,
    duplex: "half"
  } as RequestInit & { duplex: "half" });

  return webRequest.formData();
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^\w.\-()\u4e00-\u9fa5]+/g, "_");
}

async function persistUploadedFile(file: File, prefix: string): Promise<string> {
  await mkdir(uploadsDir, { recursive: true });
  const extension = path.extname(file.name || "") || ".bin";
  const baseName = sanitizeFilename(path.basename(file.name || `${prefix}${extension}`, extension));
  const targetPath = path.join(uploadsDir, `${prefix}-${baseName}-${randomUUID()}${extension}`);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(targetPath, buffer);
  return targetPath;
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/") {
      await serveStatic(response);
      return;
    }

    if (request.method === "POST" && request.url === "/api/run") {
      const form = await parseMultipartForm(request);
      const platform = (form.get("platform")?.toString() as "douyin" | "wechat_channels" | "xiaohongshu" | "youtube" | null) ?? "douyin";
      const videoFile = form.get("videoFile");
      const coverFile = form.get("coverFile");

      if (!(videoFile instanceof File) || videoFile.size === 0) {
        sendJson(response, 400, { error: "videoFile is required" });
        return;
      }

      const videoPath = await persistUploadedFile(videoFile, "video");
      const coverImagePath =
        coverFile instanceof File && coverFile.size > 0 ? await persistUploadedFile(coverFile, "cover") : undefined;

      const output = await runPublishTask({
        platform,
        videoPath,
        coverImagePath,
        markdown: form.get("markdown")?.toString() ?? "",
        storageStatePath: form.get("storageStatePath")?.toString() || resolveDefaultStorageStatePath(platform),
        executablePath: form.get("executablePath")?.toString() || resolveDefaultExecutablePath(),
        headless: false
      });

      sendJson(response, 200, output);
      return;
    }

    if (request.method === "POST" && request.url === "/api/login") {
      const rawBody = await readBody(request);
      const body = rawBody
        ? (JSON.parse(rawBody) as {
            platform?: "douyin" | "wechat_channels" | "xiaohongshu" | "youtube";
            executablePath?: string;
          })
        : {};

      const output = await startDouyinLogin({
        platform: body.platform ?? "douyin",
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
      sendJson(response, 200, {
        platforms: [
          { id: "douyin", label: "抖音", status: "implemented" },
          { id: "wechat_channels", label: "微信视频号", status: "scaffold" },
          { id: "xiaohongshu", label: "小红书", status: "scaffold" },
          { id: "youtube", label: "YouTube", status: "scaffold" }
        ],
        executablePath: resolveDefaultExecutablePath(),
        port
      });
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/api/session")) {
      const requestUrl = new URL(request.url, `http://${host}:${port}`);
      const platform = (requestUrl.searchParams.get("platform") as "douyin" | "wechat_channels" | "xiaohongshu" | "youtube" | null) ?? "douyin";
      const storageStatePath = requestUrl.searchParams.get("storageStatePath") || resolveDefaultStorageStatePath(platform);
      const session = await inspectStorageState(storageStatePath);
      sendJson(response, 200, session);
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/api/login-status")) {
      const requestUrl = new URL(request.url, `http://${host}:${port}`);
      const platform = (requestUrl.searchParams.get("platform") as "douyin" | "wechat_channels" | "xiaohongshu" | "youtube" | null) ?? "douyin";
      const storageStatePath = requestUrl.searchParams.get("storageStatePath") || resolveDefaultStorageStatePath(platform);
      const executablePath = requestUrl.searchParams.get("executablePath") || resolveDefaultExecutablePath();
      const verification = await verifyDouyinLogin({
        platform,
        storageStatePath,
        executablePath,
        headless: true
      });
      sendJson(response, 200, verification);
      return;
    }

    if (request.method === "POST" && request.url === "/api/open-folder") {
      const rawBody = await readBody(request);
      const body = JSON.parse(rawBody) as {
        targetPath?: string;
      };

      if (!body.targetPath) {
        sendJson(response, 400, { error: "targetPath is required" });
        return;
      }

      await openPathInFinder(path.dirname(body.targetPath));
      sendJson(response, 200, { ok: true });
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
