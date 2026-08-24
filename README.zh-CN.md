# 微信 Clawbot 桥接插件

[English](README.md) | 中文

一个常驻的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 宿主插件：通过 iLink 扫码协议绑定一个微信 clawbot，把微信消息桥接到指定工作区的按天会话中，并把 Agent 的回复发回微信。

## 功能特性

- **扫码登录** — `weixin_bind(workspaceId)` 在本地渲染可扫描的二维码（终端字符画 + PNG，保存在 `$DSH_HOME/weixin-clawbot/` 下；绝不发送到第三方图片服务）；`weixin_submit_code` 处理验证码环节。
- **双向桥接** — 长轮询 `getupdates`，把入站的文本 / 语音转文字 / 图片转发到 `weixin-YYYY-MM-DD` 会话，并通过 `sendmessage` 把 Agent 的回复发回微信。
- **持久化** — token / 游标 / 目标工作区保存在 `$DSH_HOME/weixin-clawbot/state.json`（权限 600）。进程重启后自动恢复绑定并继续轮询，无需重新扫码。
- **每日重置** — 每天一个会话；同一天的会话跨重启复用。
- **发送者白名单（TOFU）** — 绑定后第一个来信的微信用户成为唯一受信发送者，其他人的消息一律丢弃（重新绑定或解绑可重置）。用于阻止陌生人向拥有工具权限的 Agent 注入提示。
- **媒体加固** — 图片下载仅允许微信 CDN（`*.qq.com`，仅 https），且大小上限 20 MB。仅在目标模型支持视觉时才内联图片，否则退化为 `[图片]` 标签。
- **人工审批（HITL）** — 当 Agent 提权执行沙箱操作（如 `bash` 带 `sandbox_permissions`）时，插件向微信发送「⚠️ 需要审批 … 回复『允许』或『拒绝』」（含工具参数详情）并阻塞工具，直到你回复。提示要经微信传输，所以参数文本已脱敏：凭证类字段名下的值会被隐去，凭证形状的子串无论出现在哪里都会被隐去，主机 home 目录折叠为 `~`，整体长度受限。运行 `npm test` 可验证脱敏规则。

## 工具

| 工具 | 用途 |
| --- | --- |
| `weixin_list_workspaces` | 列出候选工作区 |
| `weixin_bind(workspaceId)` | 开始扫码绑定 |
| `weixin_submit_code(code)` | 提交微信显示的验证码 |
| `weixin_status()` | 查询绑定状态 |
| `weixin_unbind()` | 解绑并停止轮询 |

## 安装

```sh
npm install   # 安装本地依赖 `qrcode`
```

在 dsh profile 的 patch 层注册，例如 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: weixin-clawbot
      name: '/Users/<you>/github/weixin-clawbot/weixin-clawbot.mjs'
```

然后重启 `dsh web`。

## 使用

在 dsh 对话中说「绑定微信」（或直接调用 `weixin_bind`），用微信扫码确认，然后给 bot 发一条消息，回复会回到微信中。
