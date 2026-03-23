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
    await page.waitForTimeout(1500);
    await this.dismissBlockingModal(page, context);
    await context.checkpoint("page:upload", "Opened Douyin upload page");
  }

  private async attachVideo(page: Page, context: PublishContext): Promise<void> {
    const fileInputs = page.locator("input[type='file']");
    await fileInputs.first().setInputFiles(context.task.videoPath);
    await context.checkpoint("video:selected", `Attached video ${context.task.videoPath}`);

    if (context.task.input.coverImagePath) {
      await context.checkpoint("cover:start", "Trying to attach cover image");
      const attached = await this.attachCoverImage(page, context.task.input.coverImagePath);

      if (attached) {
        await context.checkpoint("metadata:cover", `Attached cover image ${context.task.input.coverImagePath}`);
      } else {
        await context.checkpoint(
          "metadata:cover:manual",
          `Cover image is ready at ${context.task.input.coverImagePath}, but no dedicated cover upload input was found automatically.`
        );
      }
    }
  }

  private async fillMetadata(page: Page, context: PublishContext): Promise<void> {
    await this.captureEditorDiagnostics(page, context);

    await context.checkpoint(
      "payload:structured",
      `Structured payload ready: title=${context.task.input.title}, descLength=${context.task.input.description?.length ?? 0}, tags=${(context.task.input.tags ?? []).join(",") || "none"}, mentions=${(context.task.input.mentions ?? []).join(",") || "none"}`
    );

    await context.checkpoint("title:start", "Trying to submit title to Douyin editor");
    await this.fillTitleField(page, context.task.input.title);
    await context.checkpoint("metadata:title", `Filled title "${context.task.input.title}"`);

    const descriptionText = [
      context.task.input.description,
      ...(context.task.input.tags ?? []).map((tag) => (tag.startsWith("#") ? tag : `#${tag}`)),
      ...(context.task.input.mentions ?? []).map((mention) => (mention.startsWith("@") ? mention : `@${mention}`))
    ]
      .filter(Boolean)
      .join("\n");

    if (descriptionText) {
      await context.checkpoint("description:start", "Trying to submit description to Douyin editor");
      await this.fillDescriptionField(page, descriptionText);
      await context.checkpoint("metadata:description", "Filled description content");
    }

    await context.checkpoint(
      "metadata:settings",
      `Prepared settings: visibility=${context.task.input.visibility ?? "public"}, coverMode=${context.task.input.coverMode ?? "auto"}, original=${String(context.task.input.declareOriginal ?? false)}, comments=${String(context.task.input.allowComments ?? true)}, duet=${String(context.task.input.allowDuet ?? true)}, stitch=${String(context.task.input.allowStitch ?? true)}, download=${String(context.task.input.allowDownload ?? false)}, location=${context.task.input.location ?? "none"}, scheduledAt=${context.task.input.scheduledAt ?? "immediate"}`
    );
  }

  private async fillTitleField(page: Page, title: string): Promise<void> {
    const titlePlaceholder = page.getByText("填写作品标题，为作品获得更多流量", { exact: true }).first();
    if (await titlePlaceholder.count()) {
      await titlePlaceholder.click();
      await page.waitForTimeout(200);
      await page.keyboard.type(title, { delay: 25 });
      return;
    }

    const titleInputCandidates = [
      page.locator("input[placeholder*='标题']").first(),
      page.locator("textarea[placeholder*='标题']").first(),
      page.locator("input").first(),
      page.locator("textarea").first(),
      page.locator("[contenteditable='true']").first()
    ];

    for (const candidate of titleInputCandidates) {
      if (await candidate.count()) {
        const tagName = await candidate.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
        await candidate.click();
        await page.waitForTimeout(200);
        if (tagName === "input" || tagName === "textarea") {
          await candidate.fill(title);
        } else {
          await page.keyboard.type(title, { delay: 25 });
        }
        return;
      }
    }

    throw new Error("Could not find Douyin title field.");
  }

  private async fillDescriptionField(page: Page, description: string): Promise<void> {
    const descriptionPlaceholder = page.getByText("添加作品简介", { exact: true }).first();
    if (await descriptionPlaceholder.count()) {
      await descriptionPlaceholder.click();
      await page.waitForTimeout(200);
      await page.keyboard.type(description, { delay: 20 });
      return;
    }

    const descriptionCandidates = [
      page.locator("textarea[placeholder*='简介']").first(),
      page.locator("[contenteditable='true']").nth(1),
      page.locator("textarea").nth(1)
    ];

    for (const candidate of descriptionCandidates) {
      if (await candidate.count()) {
        const tagName = await candidate.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
        await candidate.click();
        await page.waitForTimeout(200);
        if (tagName === "input" || tagName === "textarea") {
          await candidate.fill(description);
        } else {
          await page.keyboard.type(description, { delay: 20 });
        }
        return;
      }
    }

    throw new Error("Could not find Douyin description field.");
  }

  private async dismissBlockingModal(page: Page, context: PublishContext): Promise<void> {
    const acknowledgeButton = page.getByRole("button", { name: "我知道了" });
    if (await acknowledgeButton.count()) {
      const firstButton = acknowledgeButton.first();
      if (await firstButton.isVisible().catch(() => false)) {
        await firstButton.click();
        await context.checkpoint("page:modal", "Dismissed preview helper modal");
      }
    }
  }

  private async attachCoverImage(page: Page, coverImagePath: string): Promise<boolean> {
    const coverButtons = page.getByText("选择封面", { exact: true });
    const imageInputs = page.locator("input[type='file'][accept*='image'], input[type='file'][accept='image/*']");

    if (await imageInputs.count()) {
      await imageInputs.first().setInputFiles(coverImagePath);
      return true;
    }

    if (await coverButtons.count()) {
      const beforeCount = await page.locator("input[type='file']").count();
      await coverButtons.first().click();
      await page.waitForTimeout(500);
      const allFileInputs = page.locator("input[type='file']");
      const afterCount = await allFileInputs.count();

      if (afterCount > beforeCount) {
        await allFileInputs.nth(afterCount - 1).setInputFiles(coverImagePath);
        return true;
      }
    }

    return false;
  }

  private async captureEditorDiagnostics(page: Page, context: PublishContext): Promise<void> {
    const titlePlaceholderCount = await page.getByText("填写作品标题，为作品获得更多流量", { exact: true }).count().catch(() => 0);
    const descPlaceholderCount = await page.getByText("添加作品简介", { exact: true }).count().catch(() => 0);
    const contentEditableCount = await page.locator("[contenteditable='true']").count().catch(() => 0);
    const inputCount = await page.locator("input").count().catch(() => 0);
    const textareaCount = await page.locator("textarea").count().catch(() => 0);
    const fileInputCount = await page.locator("input[type='file']").count().catch(() => 0);
    const snapshot = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      const editableNodes = Array.from(document.querySelectorAll("[contenteditable='true'], input, textarea"))
        .slice(0, 12)
        .map((node) => {
          const el = node as HTMLElement;
          return {
            tag: el.tagName.toLowerCase(),
            placeholder: el.getAttribute("placeholder") || "",
            text: (el.textContent || "").trim().slice(0, 60),
            contenteditable: el.getAttribute("contenteditable") || "",
            className: (el.getAttribute("class") || "").slice(0, 80)
          };
        });

      return {
        activeTag: active?.tagName?.toLowerCase() || "",
        activePlaceholder: active?.getAttribute?.("placeholder") || "",
        activeClassName: active?.getAttribute?.("class") || "",
        editableNodes
      };
    });

    await context.checkpoint(
      "debug:editors",
      `titlePlaceholder=${titlePlaceholderCount}, descPlaceholder=${descPlaceholderCount}, contenteditable=${contentEditableCount}, input=${inputCount}, textarea=${textareaCount}, fileInput=${fileInputCount}, activeTag=${snapshot.activeTag || "none"}, activePlaceholder=${snapshot.activePlaceholder || "none"}`
    );
    await context.checkpoint(
      "debug:editable-snapshot",
      JSON.stringify(snapshot.editableNodes)
    );
  }
}
