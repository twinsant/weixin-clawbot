# WeChat Clawbot Bridge

A persistent [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) host plugin that binds a WeChat clawbot via the iLink QR protocol and bridges its messages into a per-day session of a chosen workspace.

## Features

- **QR login** — `weixin_bind(workspaceId)` returns a scannable QR; `weixin_submit_code` handles the verify-code step.
- **Bidirectional bridge** — long-polls `getupdates`, forwards inbound text / voice transcription / images into a `weixin-YYYY-MM-DD` session, and sends the agent's reply back to WeChat via `sendmessage`.
- **Persistence** — token / cursor / target workspace are stored in `$DSH_HOME/weixin-clawbot/state.json` (mode 600). On restart the plugin restores the binding and resumes polling automatically — no re-scan.
- **Daily reset** — one session per day; the same day's session is resumed across restarts.

## Tools

| Tool | Purpose |
| --- | --- |
| `weixin_list_workspaces` | list candidate workspaces |
| `weixin_bind(workspaceId)` | start QR binding |
| `weixin_submit_code(code)` | submit the WeChat verify code |
| `weixin_status()` | query binding status |
| `weixin_unbind()` | unbind and stop polling |

## Install

Register it in the dsh profile's patch layer, e.g. `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: weixin-clawbot
      name: '/Users/<you>/github/weixin-clawbot/weixin-clawbot.mjs'
```

Then restart `dsh web`.

## Usage

In a dsh conversation: say "绑定微信" (or call `weixin_bind` directly), scan the QR with WeChat, then send the bot a message. Replies come back into WeChat.
