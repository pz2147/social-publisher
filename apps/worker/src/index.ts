import { InMemoryCheckpointStore, createCheckpointLogger } from "@social-publisher/core";
import { DouyinAdapter } from "@social-publisher/platform-douyin";
import type { PublishTask } from "@social-publisher/shared";

async function main() {
  const task: PublishTask = {
    id: "demo-task-1",
    platform: "douyin",
    accountId: "local-account",
    videoPath: "./storage/videos/demo.mp4",
    input: {
      title: "Playwright 上传流程演示"
    },
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const checkpoints = new InMemoryCheckpointStore();
  const checkpoint = createCheckpointLogger(checkpoints, task);

  const adapter = new DouyinAdapter({
    storageStatePath: "./storage/state/douyin-auth.json",
    headless: false
  });

  const result = await adapter.run({
    task,
    checkpoint
  });

  console.log("publish result", result.status);
  console.table(checkpoints.list());
}

main().catch((error) => {
  console.error("worker failed", error);
  process.exitCode = 1;
});
