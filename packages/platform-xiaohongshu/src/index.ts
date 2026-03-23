import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { PlatformAdapter, PublishContext, PublishResult } from "@social-publisher/core";

export interface XiaohongshuAdapterOptions {
  storageStatePath: string;
  headless?: boolean;
  executablePath?: string;
  keepBrowserOpenOnReview?: boolean;
  onReviewSessionReady?: (session: { browser: Browser; context: BrowserContext; page: Page }) => Promise<string | undefined>;
}

export class XiaohongshuAdapter implements PlatformAdapter {
  readonly platform = "xiaohongshu" as const;

  constructor(private readonly options: XiaohongshuAdapterOptions) {}

  async run(context: PublishContext): Promise<PublishResult> {
    await context.checkpoint("browser:start", "Launching Xiaohongshu browser context");
    const browser = await chromium.launch({
      headless: this.options.headless ?? false,
      executablePath: this.options.executablePath
    });
    const browserContext = await browser.newContext(
      existsSync(this.options.storageStatePath) ? { storageState: this.options.storageStatePath } : undefined
    );

    try {
      const page = await browserContext.newPage();
      await this.openUploadPage(page, context);
      await this.attachVideo(page, context);
      await this.fillMetadata(page, context);

      await context.checkpoint(
        "review:pending",
        "Xiaohongshu flow reached the manual review checkpoint before final publish."
      );

      const reviewSessionId = await this.options.onReviewSessionReady?.({ browser, context: browserContext, page });
      await context.checkpoint(
        "review:holding",
        "Browser left open for Xiaohongshu manual review. Close the browser window yourself when finished."
      );

      return {
        status: "awaiting_review",
        checkpoints: [],
        reviewSessionId
      };
    } finally {
      if (!(this.options.keepBrowserOpenOnReview ?? true)) {
        await browserContext.close();
        await browser.close();
      }
    }
  }

  private async openUploadPage(page: Page, context: PublishContext): Promise<void> {
    await page.goto("https://creator.xiaohongshu.com/publish/publish", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1800);
    await this.dismissBlockingUi(page, context);
    await this.ensureVideoMode(page, context);
    await context.checkpoint("page:upload", "Opened Xiaohongshu publish page");
  }

  private async attachVideo(page: Page, context: PublishContext): Promise<void> {
    const uploadInput = page.locator("input[type='file'][accept*='video'], input[type='file']").first();
    await uploadInput.setInputFiles(context.task.videoPath);
    await context.checkpoint("video:selected", `Attached video ${context.task.videoPath}`);

    if (context.task.input.coverImagePath) {
      const attached = await this.attachCover(page, context.task.input.coverImagePath);
      if (attached) {
        await context.checkpoint("metadata:cover", `Attached cover image ${context.task.input.coverImagePath}`);
      } else {
        await context.checkpoint(
          "metadata:cover:manual",
          `Cover image is ready at ${context.task.input.coverImagePath}, but no dedicated Xiaohongshu cover input was found automatically.`
        );
      }
    }
  }

  private async fillMetadata(page: Page, context: PublishContext): Promise<void> {
    const descriptionText = [
      context.task.input.description,
      ...(context.task.input.tags ?? []).map((tag) => (tag.startsWith("#") ? tag : `#${tag}`)),
      ...(context.task.input.mentions ?? []).map((mention) => (mention.startsWith("@") ? mention : `@${mention}`))
    ]
      .filter(Boolean)
      .join("\n");

    await this.captureEditorDiagnostics(page, context);
    await context.checkpoint(
      "payload:structured",
      `Structured payload ready: title=${context.task.input.title}, descLength=${descriptionText.length}, tags=${(context.task.input.tags ?? []).join(",") || "none"}, mentions=${(context.task.input.mentions ?? []).join(",") || "none"}`
    );

    await context.checkpoint("title:start", "Trying to submit title to Xiaohongshu editor");
    const titleFilled = await this.fillTitle(page, context.task.input.title);
    if (titleFilled) {
      await context.checkpoint("metadata:title", `Filled title "${context.task.input.title}"`);
    } else {
      await context.checkpoint(
        "metadata:title:manual",
        `Title is ready as "${context.task.input.title}", but no stable Xiaohongshu title field was found automatically.`
      );
    }

    if (descriptionText) {
      await context.checkpoint("description:start", "Trying to submit description to Xiaohongshu editor");
      const descriptionFilled = await this.fillDescription(page, descriptionText);
      if (descriptionFilled) {
        await context.checkpoint("metadata:description", "Filled description content");
      } else {
        await context.checkpoint(
          "metadata:description:manual",
          "Description content is ready, but no stable Xiaohongshu description editor was found automatically."
        );
      }
    }
  }

  private async dismissBlockingUi(page: Page, context: PublishContext): Promise<void> {
    const dismissLabels = ["知道了", "我知道了", "稍后再说", "关闭"];
    for (const label of dismissLabels) {
      const button = page.getByRole("button", { name: label }).first();
      if (await button.count()) {
        const visible = await button.isVisible().catch(() => false);
        if (visible) {
          await button.click().catch(() => {});
          await context.checkpoint("page:modal", `Dismissed Xiaohongshu helper modal via "${label}"`);
          await page.waitForTimeout(300);
          return;
        }
      }
    }
  }

  private async ensureVideoMode(page: Page, context: PublishContext): Promise<void> {
    const candidates = [/视频/, /上传视频/, /发布视频/];
    for (const pattern of candidates) {
      const button = page.getByText(pattern).first();
      if (await button.count()) {
        const visible = await button.isVisible().catch(() => false);
        if (visible) {
          await button.click().catch(() => {});
          await page.waitForTimeout(400);
          await context.checkpoint("page:mode", `Ensured Xiaohongshu video mode via "${pattern}"`);
          return;
        }
      }
    }
  }

  private async fillTitle(page: Page, title: string): Promise<boolean> {
    const candidates = [
      page.getByPlaceholder(/填写标题|输入标题|标题/).first(),
      page.locator("input[placeholder*='标题']").first(),
      page.locator("textarea[placeholder*='标题']").first(),
      page.locator("input[maxlength], textarea[maxlength]").first(),
      page.locator("input").first()
    ];

    for (const candidate of candidates) {
      if (await candidate.count()) {
        await candidate.click().catch(() => {});
        await candidate.fill(title).catch(() => {});
        const value = await candidate.inputValue().catch(() => "");
        if (value.includes(title)) {
          return true;
        }
      }
    }

    const editableCandidates = page.locator("[contenteditable='true']");
    const editableCount = await editableCandidates.count();
    for (let index = 0; index < Math.min(editableCount, 3); index += 1) {
      const candidate = editableCandidates.nth(index);
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      await candidate.click().catch(() => {});
      await page.waitForTimeout(150);
      await page.keyboard.press("Meta+A").catch(() => {});
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});
      await page.keyboard.type(title, { delay: 20 });
      const text = await candidate.textContent().catch(() => "");
      if ((text ?? "").includes(title)) {
        return true;
      }
    }

    return false;
  }

  private async fillDescription(page: Page, description: string): Promise<boolean> {
    const candidates = [
      page.getByPlaceholder(/输入正文|添加正文|写下你的想法|描述/).first(),
      page.locator("textarea[placeholder*='正文']").first(),
      page.locator("textarea[placeholder*='描述']").first(),
      page.locator("textarea").last()
    ];

    for (const candidate of candidates) {
      if (await candidate.count()) {
        const tagName = await candidate.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
        await candidate.click().catch(() => {});
        await page.waitForTimeout(200);

        if (tagName === "textarea" || tagName === "input") {
          await candidate.fill(description).catch(() => {});
          const value = await candidate.inputValue().catch(() => "");
          if (value.includes(description.slice(0, Math.min(12, description.length)))) {
            return true;
          }
        } else {
          await page.keyboard.press("Meta+A").catch(() => {});
          await page.keyboard.press("Control+A").catch(() => {});
          await page.keyboard.press("Backspace").catch(() => {});
          await page.keyboard.type(description, { delay: 20 });
          return true;
        }
      }
    }

    const editableCandidates = page.locator("[contenteditable='true']");
    const editableCount = await editableCandidates.count();
    for (let index = Math.min(editableCount - 1, 2); index >= 0; index -= 1) {
      const candidate = editableCandidates.nth(index);
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      await candidate.click().catch(() => {});
      await page.waitForTimeout(200);
      await page.keyboard.press("Meta+A").catch(() => {});
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});
      await page.keyboard.type(description, { delay: 16 });
      const text = await candidate.textContent().catch(() => "");
      if ((text ?? "").includes(description.slice(0, Math.min(12, description.length)))) {
        return true;
      }
    }

    return false;
  }

  private async attachCover(page: Page, coverImagePath: string): Promise<boolean> {
    const imageInputs = page.locator("input[type='file'][accept*='image'], input[type='file'][accept='image/*']");
    if (await imageInputs.count()) {
      await imageInputs.first().setInputFiles(coverImagePath);
      return true;
    }

    const coverButtons = page.getByText(/封面|上传封面|更换封面/);
    if (await coverButtons.count()) {
      const allInputs = page.locator("input[type='file']");
      const before = await allInputs.count();
      await coverButtons.first().click().catch(() => {});
      await page.waitForTimeout(500);
      const after = await allInputs.count();
      if (after > before) {
        await allInputs.nth(after - 1).setInputFiles(coverImagePath);
        return true;
      }
    }

    return false;
  }

  private async captureEditorDiagnostics(page: Page, context: PublishContext): Promise<void> {
    const diagnostics = await page.evaluate(() => {
      const visible = (element: Element) => {
        const rect = (element as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(element as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };

      const inputs = Array.from(document.querySelectorAll("input, textarea, [contenteditable='true']"))
        .filter((element) => visible(element))
        .slice(0, 8)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          type: element.getAttribute("type") || "",
          placeholder: element.getAttribute("placeholder") || "",
          text: (element.textContent || "").trim().slice(0, 40),
          className: (element.getAttribute("class") || "").slice(0, 80)
        }));

      return {
        titleHints: Array.from(document.querySelectorAll("*"))
          .filter((node) => visible(node))
          .map((node) => (node.textContent || "").trim())
          .filter((text) => /标题/.test(text))
          .slice(0, 5),
        descriptionHints: Array.from(document.querySelectorAll("*"))
          .filter((node) => visible(node))
          .map((node) => (node.textContent || "").trim())
          .filter((text) => /正文|描述/.test(text))
          .slice(0, 5),
        editableCount: document.querySelectorAll("[contenteditable='true']").length,
        textInputCount: document.querySelectorAll("input, textarea").length,
        fileInputCount: document.querySelectorAll("input[type='file']").length,
        inputs
      };
    });

    await context.checkpoint(
      "debug:editors",
      `Xiaohongshu editors: editable=${diagnostics.editableCount}, textInputs=${diagnostics.textInputCount}, fileInputs=${diagnostics.fileInputCount}, titleHints=${diagnostics.titleHints.join(" | ") || "none"}, descriptionHints=${diagnostics.descriptionHints.join(" | ") || "none"}`
    );
    await context.checkpoint("debug:editable-snapshot", JSON.stringify(diagnostics.inputs, null, 2));
  }
}
