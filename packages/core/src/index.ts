import type { PublishTask, TaskCheckpoint } from "@social-publisher/shared";

export interface PublishResult {
  status: PublishTask["status"];
  checkpoints: TaskCheckpoint[];
  reviewSessionId?: string;
}

export interface PublishContext {
  task: PublishTask;
  checkpoint(step: string, message: string, screenshotPath?: string): Promise<void>;
}

export interface PlatformAdapter {
  readonly platform: PublishTask["platform"];
  run(context: PublishContext): Promise<PublishResult>;
}

export class InMemoryCheckpointStore {
  private readonly checkpoints: TaskCheckpoint[] = [];

  async add(checkpoint: TaskCheckpoint): Promise<void> {
    this.checkpoints.push(checkpoint);
  }

  list(): TaskCheckpoint[] {
    return [...this.checkpoints];
  }
}

export function createCheckpointLogger(store: InMemoryCheckpointStore, task: PublishTask) {
  return async (step: string, message: string, screenshotPath?: string) => {
    await store.add({
      taskId: task.id,
      step,
      message,
      screenshotPath,
      createdAt: new Date().toISOString()
    });
  };
}
