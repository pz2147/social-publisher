import {
  resolveDefaultExecutablePath,
  resolveDefaultStorageStatePath,
  runPublishTask
} from "./lib.js";

async function main() {
  const output = await runPublishTask({
    platform:
      (process.env.PUBLISH_PLATFORM as "douyin" | "wechat_channels" | "xiaohongshu" | "youtube" | undefined) ??
      "douyin",
    videoPath: process.env.PUBLISH_VIDEO_PATH ?? "",
    title: process.env.PUBLISH_TITLE,
    storageStatePath:
      process.env.PLATFORM_STORAGE_STATE_PATH ??
      process.env.DOUYIN_STORAGE_STATE_PATH ??
      resolveDefaultStorageStatePath(
        (process.env.PUBLISH_PLATFORM as "douyin" | "wechat_channels" | "xiaohongshu" | "youtube" | undefined) ??
          "douyin"
      ),
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? resolveDefaultExecutablePath(),
    headless: false
  });

  console.log("publish result", output.result.status);
  console.table(output.checkpoints);
}

main().catch((error) => {
  console.error("worker failed", error);
  process.exitCode = 1;
});
