import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { PlatformAdapter, PublishContext, PublishResult } from "@social-publisher/core";

export interface WechatChannelsAdapterOptions {
  storageStatePath: string;
  headless?: boolean;
  executablePath?: string;
  keepBrowserOpenOnReview?: boolean;
  onReviewSessionReady?: (session: { browser: Browser; context: BrowserContext; page: Page }) => Promise<string | undefined>;
}

export class WechatChannelsAdapter implements PlatformAdapter {
  readonly platform = "wechat_channels" as const;

  constructor(private readonly options: WechatChannelsAdapterOptions) {}

  async run(context: PublishContext): Promise<PublishResult> {
    await context.checkpoint("browser:start", "Launching WeChat Channels browser context");
    const browser = await chromium.launch({
      headless: this.options.headless ?? false,
      executablePath: this.options.executablePath
    });
    const browserContext = await browser.newContext(
      existsSync(this.options.storageStatePath) ? { storageState: this.options.storageStatePath } : undefined
    );

    try {
      const page = await browserContext.newPage();
      await page.goto("https://channels.weixin.qq.com/platform/post/create", { waitUntil: "domcontentloaded" });
      await context.checkpoint("page:upload", "Opened WeChat Channels publish page");
      await context.checkpoint("skeleton:media", `Video ready at ${context.task.videoPath}`);
      if (context.task.input.coverImagePath) {
        await context.checkpoint("skeleton:cover", `Cover ready at ${context.task.input.coverImagePath}`);
      }
      await context.checkpoint("skeleton:title", `Prepared title "${context.task.input.title}"`);
      await context.checkpoint("skeleton:description", `Prepared description length ${context.task.input.description?.length ?? 0}`);

      const reviewSessionId = await this.options.onReviewSessionReady?.({ browser, context: browserContext, page });
      await context.checkpoint(
        "review:holding",
        "WeChat Channels skeleton opened the composer and left the browser available for manual verification."
      );

      return { status: "awaiting_review", checkpoints: [], reviewSessionId };
    } finally {
      if (!(this.options.keepBrowserOpenOnReview ?? true)) {
        await browserContext.close();
        await browser.close();
      }
    }
  }
}
