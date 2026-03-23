# social-publisher

Multi-platform social media publishing workspace built around `TypeScript + Playwright`.

## Current scope

This repository starts with a worker-oriented architecture:

- `apps/worker`: runs upload jobs
- `apps/web`: local control panel for launching upload jobs
- `packages/shared`: shared types used across all packages
- `packages/core`: platform adapter contracts and checkpoint helpers
- `packages/platform-douyin`: first Playwright-based platform adapter
- `storage/`: local runtime state for videos, screenshots, and browser auth

## Architecture

The design keeps platform-specific logic isolated behind adapters so the same job model can later support Douyin, Bilibili, Xiaohongshu, Kuaishou, WeChat Channels, and YouTube.

```text
Publish task
  -> worker
  -> core adapter contract
  -> platform adapter
  -> Playwright browser flow
  -> checkpoint logs + screenshots
```

## Why TypeScript

- Best-fit ecosystem for Playwright
- Strong typing for platform adapters and task models
- Easier long-term maintenance as more platforms are added

## MVP roadmap

1. Save and refresh browser login state for each platform account
2. Run Douyin upload flow to the manual review checkpoint
3. Persist checkpoints and screenshots to SQLite or JSON storage
4. Add a lightweight web console for queue management
5. Introduce more platform adapters behind the same interface

## Getting started

```bash
npm install
npm run check
npm run dev:worker
```

Before running the worker, provide a real local video path:

```bash
PUBLISH_VIDEO_PATH="/absolute/path/to/your-video.mp4" npm run start
```

## Local browser setup

This project can run against a manually downloaded `Chrome for Testing` bundle to avoid slow browser downloads. By default the worker uses:

`/Users/zmjun/Documents/codex/upload-video/social-publisher/.local-browsers/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`

You can override it with:

```bash
PLAYWRIGHT_EXECUTABLE_PATH="/absolute/path/to/browser" npm run start
```

## Local control panel

Run the local UI:

```bash
npm run build
npm run start:web
```

Then open:

`http://localhost:3100`

The page lets you paste:

- channel
- local video path
- publish title
- browser executable path
- Douyin storage state path

When you submit the form, the server runs the same Playwright flow as the CLI worker and returns the checkpoints in the browser.

Right now only `Douyin` is implemented. `WeChat`, `Xiaohongshu`, and `YouTube` are visible in the UI as upcoming channels and will return a clear not-implemented message if selected.

## Notes

- The first milestone is intentionally `upload + fill metadata + pause before final publish`.
- Final submit should stay behind a manual confirmation step until the flow is proven stable.
- The Douyin browser window now stays open at the review checkpoint so you can inspect the page manually before closing it yourself.
