---
name: aitoearn-publish
description: Create and publish content to social media platforms via AiToEarn API. Use when the campaign lifecycle reaches CREATE or LAUNCH phase, or when asked to generate content, publish posts, check publishing status, or view social media analytics.
metadata:
  openclaw:
    emoji: "\U0001F680"
    requires:
      bins: [curl, jq]
---

# AiToEarn Content Publishing

Integrates with the AiToEarn platform for AI content generation and multi-platform publishing.

## Prerequisites

Environment variables must be set on the gateway (or in auth profiles):

- `AITOEARN_BASE_URL` — AiToEarn API gateway (default: `http://localhost:8080`)
- `AITOEARN_TOKEN` — JWT auth token

## Common Headers

Every API call needs:

```
Authorization: Bearer $AITOEARN_TOKEN
Content-Type: application/json
```

## Workflow Integration

This skill maps to campaign-lifecycle phases:

| Phase   | Action               | API                                   |
| ------- | -------------------- | ------------------------------------- |
| CREATE  | Generate content     | AI Chat / AI Image / Draft Generation |
| CREATE  | Adapt for platforms  | Content Adaptation                    |
| LAUNCH  | Publish to platforms | Publishing API                        |
| ANALYZE | Check performance    | Analytics API                         |

## Step-by-Step Procedures

### 1. Generate Content (Phase: CREATE)

**Text content** — use AI chat:

```bash
curl -s -X POST "${AITOEARN_BASE_URL}/api/ai/chat" \
  -H "Authorization: Bearer $AITOEARN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "<content brief from campaign-brief skill>"}],
    "model": "gemini-3-flash-preview"
  }' | jq .
```

**Image content** — use AI image generation:

```bash
curl -s -X POST "${AITOEARN_BASE_URL}/api/ai/image/generate/async" \
  -H "Authorization: Bearer $AITOEARN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "<visual description>",
    "model": "gemini-3.1-flash-image-preview"
  }' | jq .
```

Check image task status:

```bash
curl -s "${AITOEARN_BASE_URL}/api/ai/image/task/${LOG_ID}" \
  -H "Authorization: Bearer $AITOEARN_TOKEN" | jq .
```

**Video content**:

```bash
curl -s -X POST "${AITOEARN_BASE_URL}/api/ai/video/generations" \
  -H "Authorization: Bearer $AITOEARN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "<video description>"
  }' | jq .
```

### 2. Adapt Content for Platforms (Phase: CREATE)

Adapt a single piece of content for multiple platforms:

```bash
curl -s -X POST "${AITOEARN_BASE_URL}/api/ai/material-adaptation/" \
  -H "Authorization: Bearer $AITOEARN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "<original content>",
    "platforms": ["tiktok", "youtube", "xiaohongshu", "twitter"]
  }' | jq .
```

Retrieve adaptations:

```bash
curl -s "${AITOEARN_BASE_URL}/api/ai/material-adaptation/${MATERIAL_ID}" \
  -H "Authorization: Bearer $AITOEARN_TOKEN" | jq .
```

### 3. Publish Content (Phase: LAUNCH)

**List connected accounts** (check which platforms are available):

```bash
curl -s "${AITOEARN_BASE_URL}/api/account/list/all" \
  -H "Authorization: Bearer $AITOEARN_TOKEN" | jq '.data[] | {id, platform, name}'
```

**Create publish task**:

```bash
curl -s -X POST "${AITOEARN_BASE_URL}/api/plat/publish/create" \
  -H "Authorization: Bearer $AITOEARN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "accountIds": ["<account-id-1>", "<account-id-2>"],
    "content": "<post content>",
    "mediaUrls": ["<media-url>"],
    "scheduledAt": null
  }' | jq .
```

**Publish immediately**:

```bash
curl -s -X POST "${AITOEARN_BASE_URL}/api/plat/publish/nowPubTask/${TASK_ID}" \
  -H "Authorization: Bearer $AITOEARN_TOKEN" | jq .
```

**Check publish status**:

```bash
curl -s -X POST "${AITOEARN_BASE_URL}/api/plat/publish/statuses/published/posts" \
  -H "Authorization: Bearer $AITOEARN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' | jq .
```

### 4. View Analytics (Phase: ANALYZE)

**Account analytics**:

```bash
curl -s "${AITOEARN_BASE_URL}/api/channel/dataCube/accountDataCube/${ACCOUNT_ID}" \
  -H "Authorization: Bearer $AITOEARN_TOKEN" | jq .
```

**Post comments**:

```bash
curl -s -X POST "${AITOEARN_BASE_URL}/api/channel/engagement/post/comments" \
  -H "Authorization: Bearer $AITOEARN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"postId": "<post-id>"}' | jq .
```

**AI-generated reply to comments**:

```bash
curl -s -X POST "${AITOEARN_BASE_URL}/api/channel/engagement/comment/ai-generate" \
  -H "Authorization: Bearer $AITOEARN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"commentId": "<comment-id>", "prompt": "friendly and professional"}' | jq .
```

## Supported Platforms

TikTok, YouTube, Instagram, Twitter/X, Facebook, Pinterest, LinkedIn, Douyin, Xiaohongshu, WeChat, Bilibili, Kwai

## Error Handling

- If `AITOEARN_TOKEN` is expired (401), inform the user to re-authenticate
- If AiToEarn server is unreachable, check both endpoints (use `$AITOEARN_BASE_URL`, not hardcoded localhost):
  - User API: `curl -sf ${AITOEARN_BASE_URL}/api/user/mine -H "Authorization: Bearer $AITOEARN_TOKEN"`
  - AI API: `curl -sf -X POST ${AITOEARN_BASE_URL}/api/ai/chat -H "Authorization: Bearer $AITOEARN_TOKEN" -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":"ping"}],"model":"gemini-3-flash-preview"}'`
  - Both must succeed for AI generation path availability. User API alone does not guarantee AI service is working. Publishing and analytics endpoints require additional verification (connected social accounts).
- Async tasks (image/video generation) require polling — check status every 5-10 seconds

## Notes

- **Operator-only skill**: Requires `exec` tools (curl). NOT available on customer gateways (exec=deny). Do NOT add to customer manifest skills lists.
- For customer gateways, a future OpenClaw plugin extension would register AiToEarn API as native tools (no exec needed)
- AiToEarn must be running locally via Docker (`cd ~/dev/AiToEarn && docker compose up -d`)
- **Daemon env vars**: The gateway daemon (LaunchAgent) does NOT inherit shell env vars. To make `AITOEARN_BASE_URL` and `AITOEARN_TOKEN` available to the daemon, either:
  1. Add them to the operator's runtime config env section, OR
  2. Write a wrapper script that sources the vars before invoking curl (recommended for JWT tokens that expire)
