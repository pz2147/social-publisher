import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { PlatformAdapter, PublishContext, PublishResult } from "@social-publisher/core";

export interface DouyinAdapterOptions {
  storageStatePath: string;
  headless?: boolean;
  executablePath?: string;
  keepBrowserOpenOnReview?: boolean;
  onReviewSessionReady?: (session: { browser: Browser; context: BrowserContext; page: Page }) => Promise<string | undefined>;
}

export class DouyinAdapter implements PlatformAdapter {
  readonly platform = "douyin" as const;

  constructor(private readonly options: DouyinAdapterOptions) {}

  async run(context: PublishContext): Promise<PublishResult> {
    await context.checkpoint("browser:start", "Launching browser context");

    const browser = await chromium.launch({
      headless: this.options.headless ?? false,
      executablePath: this.options.executablePath
    });
    const browserContext = await browser.newContext(
      existsSync(this.options.storageStatePath)
        ? { storageState: this.options.storageStatePath }
        : undefined
    );

    try {
      const page = await browserContext.newPage();

      await this.openUploadPage(page, context);
      await this.attachVideo(page, context);
      await this.fillMetadata(page, context);

      await context.checkpoint(
        "review:pending",
        "Upload flow reached manual review checkpoint before final submit"
      );

      if (this.options.keepBrowserOpenOnReview ?? true) {
        const reviewSessionId = await this.options.onReviewSessionReady?.({
          browser,
          context: browserContext,
          page
        });

        await context.checkpoint(
          "review:holding",
          "Browser left open for manual review. Close the browser window yourself when finished."
        );

        return {
          status: "awaiting_review",
          checkpoints: [],
          reviewSessionId
        };
      }

      return {
        status: "awaiting_review",
        checkpoints: []
      };
    } finally {
      if (!(this.options.keepBrowserOpenOnReview ?? true)) {
        await browserContext.close();
        await browser.close();
      }
    }
  }

  private async openUploadPage(page: Page, context: PublishContext): Promise<void> {
    await page.goto("https://creator.douyin.com/creator-micro/content/upload", {
      waitUntil: "domcontentloaded"
    });
    await context.checkpoint("page:upload", "Opened Douyin upload page");
  }

  private async attachVideo(page: Page, context: PublishContext): Promise<void> {
    const fileInput = page.locator("input[type='file']").first();
    await fileInput.setInputFiles(context.task.videoPath);
    await context.checkpoint("video:selected", `Attached video ${context.task.videoPath}`);
  }

  private async fillMetadata(page: Page, context: PublishContext): Promise<void> {
    const lines = [
      context.task.input.title,
      context.task.input.description,
      ...(context.task.input.tags ?? []).map((tag) => (tag.startsWith("#") ? tag : `#${tag}`)),
      ...(context.task.input.mentions ?? []).map((mention) => (mention.startsWith("@") ? mention : `@${mention}`))
    ].filter(Boolean);

    const editor = page.getByRole("textbox").first();
    await editor.fill(lines.join("\n"));
    await context.checkpoint("metadata:title", `Filled title "${context.task.input.title}"`);

    if (context.task.input.description) {
      await context.checkpoint("metadata:description", "Filled description content");
    }

    await context.checkpoint(
      "metadata:settings",
      `Prepared settings: visibility=${context.task.input.visibility ?? "public"}, coverMode=${context.task.input.coverMode ?? "auto"}, original=${String(context.task.input.declareOriginal ?? false)}, comments=${String(context.task.input.allowComments ?? true)}, duet=${String(context.task.input.allowDuet ?? true)}, stitch=${String(context.task.input.allowStitch ?? true)}, download=${String(context.task.input.allowDownload ?? false)}, location=${context.task.input.location ?? "none"}, scheduledAt=${context.task.input.scheduledAt ?? "immediate"}`
    );
  }
}
