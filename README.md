# WeChat Clawbot Bridge

English | [中文](README.zh-CN.md)

A persistent [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) host plugin that binds a WeChat clawbot via the iLink QR protocol and bridges its messages into a per-day session of a chosen workspace.

## Features

- **QR login** — `weixin_bind(workspaceId)` renders a scannable QR locally (terminal art + PNG under `$DSH_HOME/weixin-clawbot/`; never sent to third-party image services); `weixin_submit_code` handles the verify-code step.
- **Bidirectional bridge** — long-polls `getupdates`, forwards inbound text / voice transcription / images into a `weixin-YYYY-MM-DD` session, and sends the agent's reply back to WeChat via `sendmessage`.
- **Persistence** — token / cursor / target workspace are stored in `$DSH_HOME/weixin-clawbot/state.json` (mode 600). On restart the plugin restores the binding and resumes polling automatically — no re-scan.
- **Daily reset** — one session per day; the same day's session is resumed across restarts.
- **Sender allowlist (TOFU)** — the first WeChat sender after binding becomes the only trusted one; messages from anyone else are dropped (re-bind or unbind to reset). This blocks prompt injection from strangers into a tool-capable agent.
- **Media hardening** — image downloads are restricted to the WeChat CDN (`*.qq.com`, https only) and capped at 20 MB. Images are attached inline only when the target model supports vision; otherwise they degrade to a `[图片]` label.
- **Human-in-the-loop (HITL) approval** — when the agent escalates a sandboxed action (e.g. `bash` with `sandbox_permissions`), the plugin sends a `⚠️ 需要审批 … 回复「允许」或「拒绝」` prompt (including the tool's arguments) to WeChat and blocks the tool until you reply. The prompt travels over WeChat, so the argument rendering is redacted: values held by a credential-named key are withheld, credential-shaped substrings are withheld wherever they appear, the host home directory collapses to `~`, and the rendering is length-capped. Run `npm test` to exercise the redaction rules.

## Tools

| Tool | Purpose |
| --- | --- |
| `weixin_list_workspaces` | list candidate workspaces |
| `weixin_bind(workspaceId)` | start QR binding |
| `weixin_submit_code(code)` | submit the WeChat verify code |
| `weixin_status()` | query binding status |
| `weixin_unbind()` | unbind and stop polling |

## Install

```sh
npm install   # installs the local `qrcode` dependency
```

Register it in the dsh profile's patch layer, e.g. `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: weixin-clawbot
      name: '/Users/<you>/github/weixin-clawbot/weixin-clawbot.mjs'
```

Then restart `dsh web`.

## Usage

In a dsh conversation: say "绑定微信" (or call `weixin_bind` directly), scan the QR with WeChat, then send the bot a message. Replies come back into WeChat.
