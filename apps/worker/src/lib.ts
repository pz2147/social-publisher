import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { InMemoryCheckpointStore, createCheckpointLogger } from "@social-publisher/core";
import { DouyinAdapter } from "@social-publisher/platform-douyin";
import { WechatChannelsAdapter } from "@social-publisher/platform-wechat-channels";
import { XiaohongshuAdapter } from "@social-publisher/platform-xiaohongshu";
import { YoutubeAdapter } from "@social-publisher/platform-youtube";
import type { PublishResult } from "@social-publisher/core";
import type { PlatformId, PublishTask, TaskCheckpoint } from "@social-publisher/shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");

export interface WorkerRunInput {
  platform?: PlatformId;
  videoPath: string;
  coverImagePath?: string;
  markdown?: string;
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
}

export interface WorkerRunOutput {
  result: PublishResult;
  checkpoints: TaskCheckpoint[];
}

export interface LoginRunInput {
  platform?: PlatformId;
  executablePath?: string;
  headless?: boolean;
}

export interface ActiveLoginSession {
  id: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  platform: PlatformId;
}

const activeLoginSessions = new Map<string, ActiveLoginSession>();

export interface ActiveReviewSession {
  id: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  platform: PlatformId;
}

const activeReviewSessions = new Map<string, ActiveReviewSession>();

export interface StoredCookieSummary {
  name: string;
  domain: string;
  expiresAt: string | null;
  expiresInText: string;
}

export interface StorageStateSummary {
  exists: boolean;
  filePath: string;
  fileSizeBytes: number;
  cookieCount: number;
  activeCookieCount: number;
  sessionCookieCount: number;
  keyCookies: string[];
  soonestExpiryAt: string | null;
  soonestExpiryInText: string;
  latestExpiryAt: string | null;
  latestExpiryInText: string;
  cookies: StoredCookieSummary[];
}

export interface LoginVerificationSummary {
  platform: PlatformId;
  storageStatePath: string;
  verifiedAt: string;
  isLoggedIn: boolean;
  currentUrl: string;
  pageTitle: string;
  reason: string;
}

export interface SessionSaveSummary {
  platform: PlatformId;
  storageStatePath: string;
  cookieCount: number;
  currentUrl: string;
}

interface StorageCookie {
  name: string;
  value: string;
  domain: string;
  expires: number;
}

export function resolveDefaultExecutablePath(): string {
  const preferredPaths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    path.join(
      repoRoot,
      ".local-browsers/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    )
  ];

  const matchedPath = preferredPaths.find((candidatePath) => existsSync(candidatePath));
  return matchedPath ?? preferredPaths[0];
}

export function resolveDefaultStorageStatePath(platform: PlatformId = "douyin"): string {
  return path.join(repoRoot, `storage/state/${platform}-auth.json`);
}

function getPlatformLoginUrl(platform: PlatformId): string {
  switch (platform) {
    case "douyin":
      return "https://creator.douyin.com/creator-micro/content/upload";
    case "wechat_channels":
      return "https://channels.weixin.qq.com/platform/post/create";
    case "xiaohongshu":
      return "https://creator.xiaohongshu.com/publish/publish";
    case "youtube":
      return "https://studio.youtube.com";
    default:
      return "https://creator.douyin.com/creator-micro/content/upload";
  }
}

function getPlatformLoginSignals(platform: PlatformId) {
  switch (platform) {
    case "douyin":
      return {
        loggedOutPattern: /扫码登录|手机号登录|验证码登录|登录后即可发布|登录后体验/,
        loggedInKeywords: ["创作者中心", "发布视频", "上传视频"]
      };
    case "wechat_channels":
      return {
        loggedOutPattern: /登录|扫码登录|微信扫码/,
        loggedInKeywords: ["发表视频", "视频号助手", "发表内容"]
      };
    case "xiaohongshu":
      return {
        loggedOutPattern: /登录|扫码登录|手机登录/,
        loggedInKeywords: ["发布笔记", "创作中心", "小红书"]
      };
    case "youtube":
      return {
        loggedOutPattern: /Sign in|登录|Choose your channel/i,
        loggedInKeywords: ["YouTube Studio", "Create", "Upload videos"]
      };
    default:
      return {
        loggedOutPattern: /登录/,
        loggedInKeywords: []
      };
  }
}

function normalizeMarkdown(markdown?: string): string {
  return (markdown ?? "").trim();
}

interface ParsedMarkdownFields {
  title: string;
  description: string;
  tags: string[];
  mentions: string[];
}

function parseTaggedMarkdown(markdown?: string, fallbackTitle: string = "Playwright 上传流程演示"): ParsedMarkdownFields {
  const normalized = normalizeMarkdown(markdown);
  if (!normalized) {
    return {
      title: fallbackTitle,
      description: "",
      tags: [],
      mentions: []
    };
  }

  const lines = normalized.split(/\r?\n/);
  const fields: Record<string, string[]> = {
    title: [],
    desc: [],
    tags: [],
    mentions: []
  };
  let currentField: "title" | "desc" | "tags" | "mentions" | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const fieldMatch = line.match(/^(title|desc|tags|mentions)\s*:\s*(.*)$/i);

    if (fieldMatch) {
      currentField = fieldMatch[1].toLowerCase() as "title" | "desc" | "tags" | "mentions";
      const initialValue = fieldMatch[2].trim();
      if (initialValue) {
        fields[currentField].push(initialValue);
      }
      continue;
    }

    if (currentField) {
      fields[currentField].push(line);
    }
  }

  const title = fields.title.join(" ").trim() || fallbackTitle;
  const description = fields.desc.join("\n").trim();
  const tags = fields.tags
    .join(" ")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.startsWith("#") ? item.slice(1) : item));
  const mentions = fields.mentions
    .join(" ")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.startsWith("@") ? item.slice(1) : item));

  return {
    title: title.slice(0, 55),
    description,
    tags,
    mentions
  };
}

function formatDurationFromNow(targetEpochSeconds: number): string {
  const diffSeconds = Math.floor(targetEpochSeconds - Date.now() / 1000);
  if (diffSeconds <= 0) {
    return "已过期";
  }

  const days = Math.floor(diffSeconds / 86400);
  const hours = Math.floor((diffSeconds % 86400) / 3600);
  const minutes = Math.floor((diffSeconds % 3600) / 60);

  if (days > 0) {
    return `${days}天${hours}小时`;
  }

  if (hours > 0) {
    return `${hours}小时${minutes}分钟`;
  }

  return `${Math.max(minutes, 1)}分钟`;
}

export async function inspectStorageState(
  storageStatePath: string = resolveDefaultStorageStatePath()
): Promise<StorageStateSummary> {
  if (!existsSync(storageStatePath)) {
    return {
      exists: false,
      filePath: storageStatePath,
      fileSizeBytes: 0,
      cookieCount: 0,
      activeCookieCount: 0,
      sessionCookieCount: 0,
      keyCookies: [],
      soonestExpiryAt: null,
      soonestExpiryInText: "无",
      latestExpiryAt: null,
      latestExpiryInText: "无",
      cookies: []
    };
  }

  const raw = await readFile(storageStatePath, "utf8");
  const parsed = JSON.parse(raw) as { cookies?: StorageCookie[] };
  const cookies = parsed.cookies ?? [];
  const nowEpochSeconds = Date.now() / 1000;
  const expiringCookies = cookies.filter((cookie) => cookie.expires > 0);
  const activeCookieCount = cookies.filter(
    (cookie) => cookie.value && (cookie.expires === -1 || cookie.expires > nowEpochSeconds)
  ).length;
  const sessionCookieCount = cookies.filter((cookie) => cookie.expires === -1).length;
  const soonestExpiry = expiringCookies
    .filter((cookie) => cookie.expires > nowEpochSeconds)
    .sort((left, right) => left.expires - right.expires)[0];
  const latestExpiry = expiringCookies.sort((left, right) => right.expires - left.expires)[0];
  const keyCookies = cookies
    .map((cookie) => cookie.name)
    .filter((name, index, array) => array.indexOf(name) === index)
    .filter((name) =>
      /(session|passport|csrf|uid|sid|ttwid|odin)/i.test(name)
    );

  return {
    exists: true,
    filePath: storageStatePath,
    fileSizeBytes: Buffer.byteLength(raw),
    cookieCount: cookies.length,
    activeCookieCount,
    sessionCookieCount,
    keyCookies,
    soonestExpiryAt: soonestExpiry ? new Date(soonestExpiry.expires * 1000).toISOString() : null,
    soonestExpiryInText: soonestExpiry ? formatDurationFromNow(soonestExpiry.expires) : "无",
    latestExpiryAt: latestExpiry ? new Date(latestExpiry.expires * 1000).toISOString() : null,
    latestExpiryInText: latestExpiry ? formatDurationFromNow(latestExpiry.expires) : "无",
    cookies: cookies.slice(0, 12).map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      expiresAt: cookie.expires > 0 ? new Date(cookie.expires * 1000).toISOString() : null,
      expiresInText: cookie.expires === -1 ? "会话级" : formatDurationFromNow(cookie.expires)
    }))
  };
}

export async function verifyDouyinLogin(input: {
  platform?: PlatformId;
  storageStatePath?: string;
  executablePath?: string;
  headless?: boolean;
} = {}): Promise<LoginVerificationSummary> {
  const platform = input.platform ?? "douyin";
  const storageStatePath = input.storageStatePath ?? resolveDefaultStorageStatePath(platform);
  const executablePath = input.executablePath ?? resolveDefaultExecutablePath();

  if (!existsSync(storageStatePath)) {
    return {
      platform,
      storageStatePath,
      verifiedAt: new Date().toISOString(),
      isLoggedIn: false,
      currentUrl: "",
      pageTitle: "",
      reason: "未找到登录态文件"
    };
  }

  if (!existsSync(executablePath)) {
    throw new Error(
      `Browser executable not found: ${executablePath}. Update PLAYWRIGHT_EXECUTABLE_PATH or use the local Chrome for Testing bundle.`
    );
  }

  const browser = await chromium.launch({
    headless: input.headless ?? true,
    executablePath
  });

  const context = await browser.newContext({
    storageState: storageStatePath
  });

  try {
    const page = await context.newPage();
    await page.goto(getPlatformLoginUrl(platform), {
      waitUntil: "domcontentloaded"
    });
    await page.waitForTimeout(2500);

    const currentUrl = page.url();
    const pageTitle = await page.title().catch(() => "");
    const pageText = await page.locator("body").innerText().catch(() => "");
    const hasUploadInput = (await page.locator("input[type='file']").count().catch(() => 0)) > 0;
    const signals = getPlatformLoginSignals(platform);
    const looksLoggedOut =
      signals.loggedOutPattern.test(pageText) ||
      /login|passport/i.test(currentUrl);
    const looksLoggedIn =
      hasUploadInput ||
      signals.loggedInKeywords.some((keyword) => pageText.includes(keyword));

    return {
      platform,
      storageStatePath,
      verifiedAt: new Date().toISOString(),
      isLoggedIn: looksLoggedIn && !looksLoggedOut,
      currentUrl,
      pageTitle,
      reason: looksLoggedIn && !looksLoggedOut ? "已进入创作者中心/上传页" : "页面看起来仍然要求登录"
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

export async function startDouyinLogin(input: LoginRunInput = {}): Promise<{ sessionId: string }> {
  const platform = input.platform ?? "douyin";
  const executablePath = input.executablePath ?? resolveDefaultExecutablePath();

  if (!existsSync(executablePath)) {
    throw new Error(
      `Browser executable not found: ${executablePath}. Update PLAYWRIGHT_EXECUTABLE_PATH or use the local Chrome for Testing bundle.`
    );
  }

  const browser = await chromium.launch({
    headless: input.headless ?? false,
    executablePath
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(getPlatformLoginUrl(platform), {
      waitUntil: "domcontentloaded"
    });

    const sessionId = randomUUID();
    activeLoginSessions.set(sessionId, {
      id: sessionId,
      browser,
      context,
      page,
      platform
    });

    return { sessionId };
  } catch (error) {
    await context.close();
    await browser.close();
    throw error;
  }
}

export async function completeDouyinLogin(input: {
  sessionId: string;
  storageStatePath?: string;
}): Promise<SessionSaveSummary> {
  const session = activeLoginSessions.get(input.sessionId);
  if (!session) {
    throw new Error("Login session not found. Please click '登录抖音' again.");
  }

  const storageStatePath = input.storageStatePath ?? resolveDefaultStorageStatePath(session.platform);

  try {
    return await saveSessionStorageState(session, storageStatePath);
  } finally {
    activeLoginSessions.delete(input.sessionId);
    await session.context.close();
    await session.browser.close();
  }
}

async function saveSessionStorageState(
  session: { context: BrowserContext; page: Page; platform?: PlatformId },
  storageStatePath: string
): Promise<SessionSaveSummary> {
  const platform = session.platform ?? "douyin";
  const currentUrl = session.page.url();
  const cookies = await session.context.cookies();
  const hasSessionCookie = cookies.some(
    (cookie) => cookie.value && (cookie.expires === -1 || cookie.expires > Date.now() / 1000)
  );
  const pageText = await session.page.locator("body").innerText().catch(() => "");
  const signals = getPlatformLoginSignals(platform);
  const looksLoggedIn =
    hasSessionCookie &&
    !signals.loggedOutPattern.test(pageText) &&
    (signals.loggedInKeywords.some((keyword) => pageText.includes(keyword)) || /creator|studio|channels|xiaohongshu/i.test(currentUrl));

  if (!looksLoggedIn) {
    throw new Error(
      "还没有检测到有效登录。请在浏览器里完成扫码，并确认已经进入创作者中心/上传页后，再点击保存状态。"
    );
  }

  await session.context.storageState({ path: storageStatePath });

  return {
    platform,
    storageStatePath,
    cookieCount: cookies.length,
    currentUrl
  };
}

export async function saveReviewSessionStorageState(input: {
  sessionId: string;
  storageStatePath?: string;
}): Promise<SessionSaveSummary> {
  const session = activeReviewSessions.get(input.sessionId);
  if (!session) {
    throw new Error("Upload review session not found. Please start the upload flow again.");
  }

  const storageStatePath = input.storageStatePath ?? resolveDefaultStorageStatePath(session.platform);
  return saveSessionStorageState(session, storageStatePath);
}

export async function runPublishTask(input: WorkerRunInput): Promise<WorkerRunOutput> {
  const platform = input.platform ?? "douyin";
  const videoPath = input.videoPath;
  const markdown = normalizeMarkdown(input.markdown);
  const parsedMarkdown = parseTaggedMarkdown(markdown);
  const title = input.title ?? parsedMarkdown.title;
  const description = input.description ?? parsedMarkdown.description;
  const storageStatePath = input.storageStatePath ?? resolveDefaultStorageStatePath(platform);
  const executablePath = input.executablePath ?? resolveDefaultExecutablePath();

  if (platform !== "douyin" && platform !== "xiaohongshu" && platform !== "youtube" && platform !== "wechat_channels") {
    throw new Error(
      `Platform "${platform}" is not implemented yet. Available now: douyin, wechat_channels, xiaohongshu, youtube.`
    );
  }

  if (!existsSync(videoPath)) {
    throw new Error(
      `Video file not found: ${videoPath}. Update the video path to an existing local file and try again.`
    );
  }

  if (!existsSync(executablePath)) {
    throw new Error(
      `Browser executable not found: ${executablePath}. Update PLAYWRIGHT_EXECUTABLE_PATH or use the local Chrome for Testing bundle.`
    );
  }

  const task: PublishTask = {
    id: `task-${Date.now()}`,
    platform,
    accountId: "local-account",
    videoPath,
    input: {
      title,
      markdown,
      description,
      tags: input.tags ?? parsedMarkdown.tags,
      mentions: input.mentions ?? parsedMarkdown.mentions,
      location: input.location,
      coverImagePath: input.coverImagePath,
      visibility: input.visibility ?? "public",
      coverMode: input.coverMode ?? "auto",
      declareOriginal: input.declareOriginal ?? false,
      allowComments: input.allowComments ?? true,
      allowDuet: input.allowDuet ?? true,
      allowStitch: input.allowStitch ?? true,
      allowDownload: input.allowDownload ?? false,
      scheduledAt: input.scheduledAt
    },
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const checkpoints = new InMemoryCheckpointStore();
  const checkpoint = createCheckpointLogger(checkpoints, task);

  const onReviewSessionReady = async ({ browser, context, page }: { browser: Browser; context: BrowserContext; page: Page }) => {
    const reviewSessionId = randomUUID();
    activeReviewSessions.set(reviewSessionId, {
      id: reviewSessionId,
      browser,
      context,
      page,
      platform
    });
    return reviewSessionId;
  };

  const commonAdapterOptions = {
    storageStatePath,
    headless: input.headless ?? false,
    executablePath,
    keepBrowserOpenOnReview: true,
    onReviewSessionReady
  };

  const adapter =
    platform === "douyin"
      ? new DouyinAdapter(commonAdapterOptions)
      : platform === "wechat_channels"
        ? new WechatChannelsAdapter(commonAdapterOptions)
      : platform === "xiaohongshu"
        ? new XiaohongshuAdapter(commonAdapterOptions)
        : new YoutubeAdapter(commonAdapterOptions);

  const result = await adapter.run({
    task,
    checkpoint
  });

  return {
    result,
    checkpoints: checkpoints.list()
  };
}
