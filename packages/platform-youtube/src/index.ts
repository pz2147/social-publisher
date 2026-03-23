import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { PlatformAdapter, PublishContext, PublishResult } from "@social-publisher/core";

export interface YoutubeAdapterOptions {
  storageStatePath: string;
  headless?: boolean;
  executablePath?: string;
  keepBrowserOpenOnReview?: boolean;
  onReviewSessionReady?: (session: { browser: Browser; context: BrowserContext; page: Page }) => Promise<string | undefined>;
}

export class YoutubeAdapter implements PlatformAdapter {
  readonly platform = "youtube" as const;

  constructor(private readonly options: YoutubeAdapterOptions) {}

  async run(context: PublishContext): Promise<PublishResult> {
    await context.checkpoint("browser:start", "Launching YouTube browser context");
    const browser = await chromium.launch({
      headless: this.options.headless ?? false,
      executablePath: this.options.executablePath
    });
    const browserContext = await browser.newContext(
      existsSync(this.options.storageStatePath) ? { storageState: this.options.storageStatePath } : undefined
    );

    try {
      const page = await browserContext.newPage();
      await page.goto("https://studio.youtube.com", { waitUntil: "domcontentloaded" });
      await context.checkpoint("page:upload", "Opened YouTube Studio");
      await context.checkpoint("skeleton:media", `Video ready at ${context.task.videoPath}`);
      if (context.task.input.coverImagePath) {
        await context.checkpoint("skeleton:cover", `Thumbnail ready at ${context.task.input.coverImagePath}`);
      }
      await context.checkpoint("skeleton:title", `Prepared title "${context.task.input.title}"`);
      await context.checkpoint("skeleton:description", `Prepared description length ${context.task.input.description?.length ?? 0}`);

      const reviewSessionId = await this.options.onReviewSessionReady?.({ browser, context: browserContext, page });
      await context.checkpoint(
        "review:holding",
        "YouTube skeleton opened Studio and left the browser available for manual verification."
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
