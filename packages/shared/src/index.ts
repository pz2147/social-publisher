export type PlatformId = "douyin" | "bilibili" | "xiaohongshu" | "kuaishou" | "wechat_channels" | "youtube";

export type PublishStatus =
  | "queued"
  | "running"
  | "awaiting_review"
  | "published"
  | "failed";

export interface PublishInput {
  title: string;
  description?: string;
  tags?: string[];
  mentions?: string[];
  location?: string;
  scheduledAt?: string;
  visibility?: "public" | "private" | "friends";
  coverMode?: "auto" | "custom";
  declareOriginal?: boolean;
  allowComments?: boolean;
  allowDuet?: boolean;
  allowStitch?: boolean;
  allowDownload?: boolean;
}

export interface PublishTask {
  id: string;
  platform: PlatformId;
  accountId: string;
  videoPath: string;
  input: PublishInput;
  status: PublishStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TaskCheckpoint {
  taskId: string;
  step: string;
  message: string;
  screenshotPath?: string;
  createdAt: string;
}
