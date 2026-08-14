/**
 * WeChat clawbot bridge — persistent host plugin.
 *
 * Loaded from the host composition (web profile). On startup it restores the
 * persisted binding (token / cursor / target workspace) from
 * $DSH_HOME/weixin-clawbot/state.json and resumes the getupdates long-poll, so a
 * process restart never requires re-scanning the QR code.
 *
 * Binding is driven by three model tools (weixin_bind / weixin_status /
 * weixin_unbind); the QR URL is returned to the model, which renders it for the
 * user to scan. Inbound messages are forwarded into the workspace's per-day
 * session (`weixin-YYYY-MM-DD`) and the agent's reply is sent back to WeChat.
 */

import { createDecipheriv } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import QRCode from 'qrcode'

export const name = 'weixin-clawbot'
export const inject = ['timer', 'tools']

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const APP_VERSION = '132102'
const CHANNEL_VERSION = '2.4.6'
const BOT_AGENT = 'QclawLogin/1.0'
const SOURCE_PLUGIN = 'weixin-clawbot'
const LONG_POLL_TIMEOUT_MS = 40_000
const API_TIMEOUT_MS = 15_000
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

export function apply(ctx) {
  // ---- runtime state (restored from disk on startup) ----
  let bound = null // { accountId, token, baseUrl }
  let targetWorkspaceId = null
  let allowedSenders = [] // TOFU: first inbound sender after binding is trusted; others are dropped
  let cursor = ''
  let pendingCode = null
  let login = { phase: 'idle', message: '未绑定' }
  let loginInFlight = false
  let msgInFlight = false

  // ---- durable state location ----
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const stateDir = join(dshHome, 'weixin-clawbot')
  const stateFile = join(stateDir, 'state.json')

  function dateKey() {
    const d = new Date()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${d.getFullYear()}-${m}-${day}`
  }

  function makeId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  function getState() {
    return {
      bound: Boolean(bound),
      accountId: bound ? bound.accountId : null,
      targetWorkspaceId,
      allowedSenders: [...allowedSenders],
      login,
    }
  }

  // ---- durable state ----
  function loadState() {
    try {
      const raw = JSON.parse(readFileSync(stateFile, 'utf-8'))
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  function saveState() {
    try {
      mkdirSync(stateDir, { recursive: true })
      const payload = {
        accountId: bound ? bound.accountId : null,
        baseUrl: bound ? bound.baseUrl : null,
        token: bound ? bound.token : null,
        cursor,
        workspaceId: targetWorkspaceId,
        allowedSenders,
      }
      // mode on create closes the 644→600 chmod race; chmod covers pre-existing files
      writeFileSync(stateFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
      chmodSync(stateFile, 0o600)
    } catch (error) {
      console.error('[weixin] saveState failed:', error)
    }
  }

  function restoreState() {
    const s = loadState()
    if (s && typeof s.token === 'string' && s.token) {
      bound = { accountId: s.accountId || 'unknown', token: s.token, baseUrl: s.baseUrl || DEFAULT_BASE_URL }
      cursor = typeof s.cursor === 'string' ? s.cursor : ''
      targetWorkspaceId = typeof s.workspaceId === 'string' ? s.workspaceId : null
      allowedSenders = Array.isArray(s.allowedSenders) ? s.allowedSenders.filter(v => typeof v === 'string' && v) : []
      login = { phase: 'confirmed', message: `已恢复绑定：${s.accountId || 'unknown'}` }
      console.log('[weixin] restored bound account', s.accountId || 'unknown')
    }
  }

  // ---- HTTP ----
  async function fetchJson(url, { method = 'GET', body, token, timeoutMs = API_TIMEOUT_MS } = {}) {
    const headers = {
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': APP_VERSION,
    }
    let payload
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      headers['AuthorizationType'] = 'ilink_bot_token'
      headers['X-WECHAT-UIN'] = Buffer.from(String(Math.floor(Math.random() * 0x100000000))).toString('base64')
      payload = JSON.stringify(body)
    }
    if (token) headers.Authorization = `Bearer ${token}`

    const controller = new AbortController()
    const timer = ctx.timeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        signal: controller.signal,
      })
      const text = await res.text()
      if (!res.ok || !text) {
        // response body is not included: it may carry tokens or account data
        throw new Error(`HTTP ${res.status}${text ? '' : ' (empty body)'}`)
      }
      return JSON.parse(text)
    } finally {
      timer()
    }
  }

  async function ilink(baseUrl, method, endpoint, body, token, timeoutMs) {
    const base = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    return fetchJson(base + endpoint, { method, body, token, timeoutMs })
  }

  // ---- message shape helpers ----
  function keyToBuffer(aeskeyHex, aesKeyBase64) {
    if (typeof aeskeyHex === 'string' && /^[0-9a-fA-F]{32}$/.test(aeskeyHex)) {
      return Buffer.from(aeskeyHex, 'hex')
    }
    if (typeof aesKeyBase64 === 'string' && aesKeyBase64) {
      try {
        const raw = Buffer.from(aesKeyBase64, 'base64')
        if (raw.length === 16) return raw
        if (raw.length === 32 && /^[0-9a-fA-F]{32}$/.test(raw.toString('ascii'))) {
          return Buffer.from(raw.toString('ascii'), 'hex')
        }
      } catch {
        /* fallthrough */
      }
    }
    return null
  }

  function sniffImageType(bytes) {
    if (!bytes || bytes.length < 12) return null
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
    return null
  }

  function buildText(msg) {
    const items = msg.item_list
    if (!Array.isArray(items)) return ''
    const parts = []
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      if (item.type === 1 && item.text_item && typeof item.text_item.text === 'string' && item.text_item.text) {
        parts.push(item.text_item.text)
      } else if (item.type === 3 && item.voice_item && typeof item.voice_item.text === 'string' && item.voice_item.text) {
        parts.push(`[语音转文字] ${item.voice_item.text}`)
      }
    }
    return parts.join('\n')
  }

  function mediaSummary(item, imageAttached) {
    const t = item.type
    if (t === 2) {
      if (imageAttached) return '[图片]'
      const m = item.image_item && item.image_item.media
      const u = (m && (m.full_url || m.encrypt_query_param)) || (item.image_item && item.image_item.url)
      return u ? `[图片] ${u}` : '[图片]'
    }
    if (t === 3) return '[语音]'
    if (t === 4) {
      const n = item.file_item && item.file_item.file_name
      return n ? `[文件: ${n}]` : '[文件]'
    }
    if (t === 5) return '[视频]'
    if (t === 11) return '[工具调用开始]'
    if (t === 12) return '[工具调用结果]'
    return `[类型 ${t}]`
  }

  // Message-supplied URLs may point anywhere (SSRF); only trust the WeChat CDN.
  function isAllowedMediaUrl(url) {
    try {
      const u = new URL(url)
      return u.protocol === 'https:' && (u.hostname === 'qq.com' || u.hostname.endsWith('.qq.com'))
    } catch {
      return false
    }
  }

  async function readBodyCapped(res, maxBytes) {
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) return null
    const chunks = []
    let total = 0
    for await (const chunk of res.body) {
      total += chunk.length
      if (total > maxBytes) return null
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  async function downloadDecryptImage(item) {
    const img = item.image_item
    if (!img || !img.media) return null
    const media = img.media
    if (!media.full_url && !media.encrypt_query_param) return null
    const url = media.full_url
      || `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
    if (!isAllowedMediaUrl(url)) {
      console.error('[weixin] rejected media url outside WeChat CDN')
      return null
    }
    const key = keyToBuffer(img.aeskey, media.aes_key)
    try {
      const controller = new AbortController()
      const timer = ctx.timeout(() => controller.abort(), API_TIMEOUT_MS)
      let encrypted
      try {
        const res = await fetch(url, { signal: controller.signal })
        if (!res.ok) return null
        encrypted = await readBodyCapped(res, MAX_IMAGE_BYTES)
      } finally {
        timer()
      }
      if (!encrypted) return null
      let data
      if (key) {
        const decipher = createDecipheriv('aes-128-ecb', key, null)
        data = Buffer.concat([decipher.update(encrypted), decipher.final()])
      } else {
        data = encrypted
      }
      const mediaType = sniffImageType(data)
      if (!mediaType) return null
      return { data: new Uint8Array(data), mediaType }
    } catch (error) {
      console.error('[weixin] image download/decrypt failed:', error)
      return null
    }
  }

  function collectAssistantText(events, startSeq) {
    let text = ''
    for (let i = startSeq; i < events.length; i++) {
      const ev = events[i]
      if (!ev || ev.type !== 'assistant/message') continue
      const msg = ev.data && ev.data.message
      if (!msg || !Array.isArray(msg.content)) continue
      const parts = []
      for (const block of msg.content) {
        if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          parts.push(block.text)
        }
      }
      const joined = parts.join('')
      if (joined.trim()) text = joined
    }
    return text.trim()
  }

  // ---- daily session ----
  async function ensureDailyAgent(workspaceId) {
    const agents = ctx.get('agents')
    if (agents === undefined) throw new Error('agents service unavailable')
    const workspaceRegistry = ctx.get('workspaceRegistry')
    const presets = ctx.get('agentPresets')
    const sessionPersistence = ctx.get('sessionPersistence')

    const baseId = `weixin-${dateKey()}`
    let sessionId = baseId
    let existing = agents.get(sessionId)
    if (existing !== undefined && !(existing.options && existing.options.model)) {
      sessionId = `${baseId}-r${Date.now().toString(36)}`
      existing = undefined
    }
    if (existing !== undefined) return existing

    const workspace = workspaceRegistry !== undefined ? workspaceRegistry.get(workspaceId) : undefined
    let cwd = workspace !== undefined ? workspace.path : undefined
    if (!cwd) {
      const sp = ctx.get('sandboxPolicy')
      cwd = sp && sp.workspaceRoot ? sp.workspaceRoot : undefined
    }
    if (!cwd) throw new Error(`cannot resolve workspace cwd for ${workspaceId}`)

    let agentOptions
    const adm = ctx.get('agentDefaultModel')
    if (adm !== undefined) {
      try {
        const sel = adm.currentSelection()
        if (sel && sel.provider && sel.model) agentOptions = { provider: sel.provider, model: sel.model }
      } catch (error) {
        console.error('[weixin] default model resolve failed:', error)
      }
    }

    let presetId
    let setup
    if (presets !== undefined) {
      try {
        const resolved = await presets.resolve(undefined)
        presetId = resolved && resolved.id
        if (presetId) setup = async agentCtx => { await presets.mount(agentCtx, presetId) }
      } catch (error) {
        console.error('[weixin] preset resolve failed; creating without preset:', error)
        presetId = undefined
      }
    }

    let handle
    if (sessionPersistence !== undefined) {
      try {
        const stored = (await sessionPersistence.list()).find(h => h && h.id === sessionId)
        if (stored !== undefined) {
          handle = await agents.resume({
            resumeSessionId: sessionId,
            ...(agentOptions ? { agentOptions } : {}),
            ...(setup ? { setup } : {}),
          })
          return handle.agent
        }
      } catch (error) {
        console.error('[weixin] resume check failed; will create fresh:', error)
      }
    }

    handle = await agents.create({
      sessionId,
      ...(agentOptions ? { agentOptions } : {}),
      meta: { cwd, ...(presetId ? { agentPreset: presetId } : {}) },
      ...(setup ? { setup } : {}),
    })
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(sessionId)
      } catch (error) {
        console.error('[weixin] attach session failed:', error)
      }
    }
    return handle.agent
  }

  // ---- outbound reply ----
  async function sendTextReply(to, contextToken, text) {
    if (!bound) return
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: makeId('wxout'),
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        ...(contextToken ? { context_token: contextToken } : {}),
      },
      base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
    }
    const resp = await ilink(bound.baseUrl, 'POST', '/ilink/bot/sendmessage', body, bound.token, API_TIMEOUT_MS)
    if (resp && resp.ret && resp.ret !== 0) {
      throw new Error(`sendmessage ret=${resp.ret} ${resp.errmsg || ''}`)
    }
  }

  // ---- inbound forwarding ----
  // Prevents the sender header from being spoofed inside message bodies.
  function sanitizeInbound(text) {
    return String(text).replace(/\[微信/g, '［微信')
  }

  // TOFU: the first sender after binding becomes the only trusted one.
  function isTrustedSender(sender) {
    if (allowedSenders.includes(sender)) return true
    if (allowedSenders.length === 0) {
      allowedSenders = [sender]
      saveState()
      console.log('[weixin] trusted first sender', sender)
      return true
    }
    return false
  }

  async function forwardMessage(msg) {
    if (!targetWorkspaceId) {
      console.error('[weixin] no target workspace; dropping message')
      return
    }
    const sender = String(msg.from_user_id || msg.from_user || msg.fromUser || 'unknown')
    const senderLabel = sender.replace(/[\[\]\r\n]/g, '')
    if (!isTrustedSender(sender)) {
      console.error('[weixin] dropping message from untrusted sender', senderLabel)
      return
    }
    const contextToken = typeof msg.context_token === 'string' && msg.context_token ? msg.context_token : null
    const items = Array.isArray(msg.item_list) ? msg.item_list : []
    const text = buildText(msg)

    let attachment = null
    let imageAttached = false
    const imageItem = items.find(i => i && i.type === 2 && i.image_item && i.image_item.media
      && (i.image_item.media.full_url || i.image_item.media.encrypt_query_param))
    if (imageItem) {
      const img = await downloadDecryptImage(imageItem)
      if (img) {
        try {
          const attachments = ctx.get('attachments')
          if (attachments !== undefined) {
            attachment = await attachments.saveImage(img)
            imageAttached = true
          }
        } catch (error) {
          console.error('[weixin] saveImage failed:', error)
          attachment = null
          imageAttached = false
        }
      }
    }

    const head = [`[微信 · ${senderLabel}]`]
    if (text) {
      head.push(sanitizeInbound(text))
    } else {
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        if (item.type === 1 || item.type === 3) continue
        head.push(sanitizeInbound(mediaSummary(item, imageAttached)))
      }
      if (head.length === 1) head.push('(无文本内容)')
    }

    const content = [{ type: 'text', text: head.join('\n') }]
    if (attachment) content.push({ type: 'image', attachment })

    try {
      const agent = await ensureDailyAgent(targetWorkspaceId)
      const startSeq = agent.session.events.length
      agent.followup({
        id: makeId('wxmsg'),
        role: 'user',
        content,
        source: { kind: 'plugin', plugin: SOURCE_PLUGIN },
      })
      await agent.whenIdle()
      const replyText = collectAssistantText(agent.session.events, startSeq)
      if (replyText) {
        try {
          await sendTextReply(sender, contextToken, replyText)
        } catch (error) {
          console.error('[weixin] send reply failed:', error)
        }
      }
    } catch (error) {
      console.error('[weixin] forward failed:', error)
    }
  }

  async function pollMessages() {
    if (msgInFlight || !bound) return
    msgInFlight = true
    try {
      const resp = await ilink(bound.baseUrl, 'POST', '/ilink/bot/getupdates', {
        get_updates_buf: cursor,
        base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
      }, bound.token, LONG_POLL_TIMEOUT_MS)
      const newCursor = resp.get_updates_buf
      if (typeof newCursor === 'string' && newCursor) {
        cursor = newCursor
        saveState()
      }
      const msgs = resp.msgs
      if (Array.isArray(msgs)) {
        for (const m of msgs) {
          if (m && typeof m === 'object') await forwardMessage(m)
        }
      }
    } catch (error) {
      console.error('[weixin] message poll failed:', error)
    } finally {
      msgInFlight = false
    }
  }

  // ---- login state machine ----
  function handleLoginStatus(resp) {
    const status = resp && resp.status
    if (status === 'wait') return
    if (status === 'scaned') {
      pendingCode = null
      if (login.phase !== 'scanned') login = { ...login, phase: 'scanned', message: '已扫码，请在微信中确认' }
      return
    }
    if (status === 'need_verifycode') {
      login = { ...login, phase: 'need_code', message: '请输入微信中显示的验证码' }
      return
    }
    if (status === 'verify_code_blocked') {
      pendingCode = null
      login = { ...login, phase: 'error', message: '验证码错误次数过多，请重新开始绑定' }
      return
    }
    if (status === 'expired') {
      pendingCode = null
      login = { ...login, phase: 'expired', message: '二维码已过期，请重新开始绑定' }
      return
    }
    if (status === 'scaned_but_redirect') {
      if (typeof resp.redirect_host === 'string' && resp.redirect_host) {
        const host = String(resp.redirect_host).replace(/^https?:\/\//, '').replace(/\/+$/, '')
        login = { ...login, baseUrl: `https://${host}`, message: `已跳转主机 ${host}` }
      }
      return
    }
    if (status === 'binded_redirect') {
      login = { ...login, phase: 'error', message: '该 bot 已绑定到其他实例' }
      return
    }
    if (status === 'confirmed') {
      const accountId = resp.ilink_bot_id
      const token = resp.bot_token
      if (typeof accountId === 'string' && accountId && typeof token === 'string' && token) {
        const retBase = typeof resp.baseurl === 'string' && resp.baseurl ? resp.baseurl : (login.baseUrl || DEFAULT_BASE_URL)
        bound = { accountId, token, baseUrl: String(retBase).replace(/\/+$/, '') }
        cursor = ''
        pendingCode = null
        allowedSenders = []
        login = { phase: 'confirmed', message: `绑定成功：${accountId}` }
        saveState()
      } else {
        login = { ...login, phase: 'error', message: '确认响应缺少账号或 token' }
      }
      return
    }
  }

  async function pollLogin() {
    if (loginInFlight) return
    const qr = login.qrcode
    if (!qr) return
    loginInFlight = true
    try {
      let endpoint = `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr)}`
      if (login.phase === 'need_code' && pendingCode) endpoint += `&verify_code=${encodeURIComponent(pendingCode)}`
      const resp = await ilink(login.baseUrl || DEFAULT_BASE_URL, 'GET', endpoint, undefined, undefined, API_TIMEOUT_MS)
      handleLoginStatus(resp)
    } catch {
      // transient; retry next tick
    } finally {
      loginInFlight = false
    }
  }

  async function startLogin(workspaceId) {
    targetWorkspaceId = workspaceId
    pendingCode = null
    try {
      const resp = await ilink(DEFAULT_BASE_URL, 'POST', '/ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: [] }, undefined, API_TIMEOUT_MS)
      const qrcode = resp.qrcode
      const qrContent = resp.qrcode_img_content
      if (typeof qrcode !== 'string' || !qrcode || typeof qrContent !== 'string' || !qrContent) {
        throw new Error(`QR 响应缺少 qrcode 或 qrcode_img_content：${JSON.stringify(resp)}`)
      }
      // QR is generated locally: sending it to a third-party image service would leak the binding credential.
      let qrTerminal = ''
      let qrPngPath = ''
      try {
        qrTerminal = await QRCode.toString(qrContent, { type: 'terminal', small: true })
        mkdirSync(stateDir, { recursive: true })
        qrPngPath = join(stateDir, 'qrcode.png')
        await QRCode.toFile(qrPngPath, qrContent, { width: 280, margin: 2 })
        chmodSync(qrPngPath, 0o600)
      } catch (error) {
        console.error('[weixin] local QR render failed:', error)
      }
      login = { phase: 'waiting', qrcode, qrContent, qrTerminal, qrPngPath, baseUrl: DEFAULT_BASE_URL, message: '请用微信扫码并确认' }
      saveState()
    } catch (error) {
      login = { phase: 'error', message: String(error && error.message ? error.message : error) }
    }
    return getState()
  }

  function submitCode(code) {
    const c = String(code || '').trim()
    if (!c) return getState()
    pendingCode = c
    login = { ...login, message: '验证码已提交，等待确认…' }
    return getState()
  }

  function unbind() {
    bound = null
    cursor = ''
    pendingCode = null
    allowedSenders = []
    login = { phase: 'idle', message: '未绑定' }
    saveState()
    return getState()
  }

  async function tick() {
    const p = login.phase
    if (p === 'waiting' || p === 'scanned' || p === 'need_code') await pollLogin()
    if (bound) await pollMessages()
  }

  // ---- model tools (binding surface) ----
  ctx.tools.register({
    name: 'weixin_bind',
    description: '开始微信 clawbot 扫码绑定：为指定工作区拉取二维码并返回二维码内容 URL，用户扫码确认后消息进入该工作区当天新建的会话。',
    parameters: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: '目标工作区 id（可用 weixin_list_workspaces 查询）。' },
      },
      required: ['workspaceId'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          phase: { type: 'string' },
          message: { type: 'string' },
          qrUrl: { type: 'string' },
          qrTerminal: { type: 'string' },
          qrPngPath: { type: 'string' },
        },
        required: ['phase', 'message'],
      },
      render(_args, value) {
        const parts = [value.message || '']
        if (value.qrTerminal) parts.push(value.qrTerminal)
        if (value.qrPngPath) parts.push(`二维码图片（本地）: ${value.qrPngPath}`)
        if (!value.qrTerminal && !value.qrPngPath && value.qrUrl) parts.push(`二维码URL: ${value.qrUrl}`)
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    async execute(args) {
      const state = await startLogin(String(args.workspaceId || ''))
      return {
        phase: state.login.phase,
        message: state.login.message,
        qrUrl: state.login.qrContent || '',
        qrTerminal: state.login.qrTerminal || '',
        qrPngPath: state.login.qrPngPath || '',
      }
    },
  })

  ctx.tools.register({
    name: 'weixin_submit_code',
    description: '提交微信 clawbot 绑定过程中微信里显示的验证码。',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: '微信中显示的验证码。' } },
      required: ['code'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { phase: { type: 'string' }, message: { type: 'string' } },
        required: ['phase', 'message'],
      },
      render(_args, value) {
        return [{ type: 'text', text: value.message || '' }]
      },
    },
    async execute(args) {
      const state = submitCode(String(args.code || ''))
      return { phase: state.login.phase, message: state.login.message }
    },
  })

  ctx.tools.register({
    name: 'weixin_status',
    description: '查询微信 clawbot 绑定/登录状态（是否已绑定、账号、当前阶段）。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          bound: { type: 'boolean' },
          accountId: { type: 'string' },
          phase: { type: 'string' },
          message: { type: 'string' },
          workspaceId: { type: 'string' },
          allowedSenders: { type: 'array', items: { type: 'string' } },
        },
        required: ['bound', 'phase', 'message'],
      },
      render(_args, value) {
        return [{ type: 'text', text: value.message || '' }]
      },
    },
    async execute() {
      const s = getState()
      return {
        bound: s.bound,
        accountId: s.accountId || '',
        phase: s.login.phase,
        message: s.login.message,
        workspaceId: s.targetWorkspaceId || '',
        allowedSenders: s.allowedSenders,
      }
    },
  })

  ctx.tools.register({
    name: 'weixin_unbind',
    description: '解绑微信 clawbot 并停止消息轮询。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      render(_args, value) {
        return [{ type: 'text', text: value.ok ? '已解绑' : '解绑失败' }]
      },
    },
    async execute() {
      unbind()
      return { ok: true }
    },
  })

  ctx.tools.register({
    name: 'weixin_list_workspaces',
    description: '列出可选的目标工作区（id / 标题 / 路径），用于微信 clawbot 绑定选择。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          workspaces: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, title: { type: 'string' }, path: { type: 'string' } },
              required: ['id'],
            },
          },
        },
        required: ['workspaces'],
      },
      render(_args, value) {
        const list = Array.isArray(value.workspaces) ? value.workspaces : []
        return [{ type: 'text', text: list.map(w => `${w.id}\t${w.title}\t${w.path}`).join('\n') || '(无工作区)' }]
      },
    },
    async execute() {
      const wr = ctx.get('workspaceRegistry')
      if (wr === undefined) return { workspaces: [] }
      const list = wr.list()
      if (!Array.isArray(list)) return { workspaces: [] }
      return { workspaces: list.map(w => ({ id: w.id, title: w.title, path: w.path })) }
    },
  })

  // ---- startup: restore persisted binding, then start the poll loop ----
  restoreState()
  ctx.interval(() => { void tick() }, 2000)
}
