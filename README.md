# social-publisher

Multi-platform social media publishing workspace built around `TypeScript + Playwright`.

## Current scope

This repository starts with a worker-oriented architecture:

- `apps/worker`: runs upload jobs
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

## Notes

- The first milestone is intentionally `upload + fill metadata + pause before final publish`.
- Final submit should stay behind a manual confirmation step until the flow is proven stable.
