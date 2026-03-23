import { existsSync } from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { PlatformAdapter, PublishContext, PublishResult } from "@social-publisher/core";

export interface DouyinAdapterOptions {
  storageStatePath: string;
  headless?: boolean;
}

export class DouyinAdapter implements PlatformAdapter {
  readonly platform = "douyin" as const;

  constructor(private readonly options: DouyinAdapterOptions) {}

  async run(context: PublishContext): Promise<PublishResult> {
    await context.checkpoint("browser:start", "Launching browser context");

    const browser = await chromium.launch({ headless: this.options.headless ?? false });
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

      return {
        status: "awaiting_review",
        checkpoints: []
      };
    } finally {
      await browserContext.close();
      await browser.close();
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
    const editor = page.getByRole("textbox").first();
    await editor.fill(context.task.input.title);
    await context.checkpoint("metadata:title", `Filled title "${context.task.input.title}"`);
  }
}
