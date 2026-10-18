/**
 * dsh-dania-voice — Host half.
 *
 * 把 DSH 的助手回复正文交给本地 GPT-SoVITS 合成，浏览器端按需取回播放。
 *
 * 分工：
 *   - Host：监听会话事件拿「最终回复正文」、清洗分段、调 GPT-SoVITS 的 /tts、
 *           落 wav 文件、排队；顺带按需拉起 api_v2.py。
 *   - Browser：一个悬浮开关 + 轮询队列 + 用 <audio> 播放。
 *
 * 播放必须发生在浏览器里：Host 进程没有可听的输出设备，也不该去抢音频焦点。
 *
 * 设计约束（来自 DSH 现有插件的踩坑记录）：
 *   1. `webserver/index-inject` 的行必须在 apply() 同步阶段注册 —— 桌面壳在宿主启动时
 *      一次性收集这张表，晚注册就永远进不了表。
 *   2. 注入行用**内联 script** 去建 `<script src>` 并吞掉 onerror，而不是直接推
 *      `script-src` 行：后者加载失败会 reject 掉 __DSH_BOOT_READY__，把整个应用拖死。
 *   3. 路由一律挂在插件前缀下，并做回环校验。
 *
 * @module dsh-dania-voice
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'

const ROUTE = '/dania-voice'
const CLIENT_ROUTE = `${ROUTE}/client.js`
const STATE_DIRNAME = 'dania-voice'

/**
 * 单轮朗读的总字数上限。
 *
 * 它只是防呆闸：常见回复（几百到一千多字）都在这以内，会完整读完；
 * 真正的分段由 {@link splitSegments} 按 120 字切，逐段入队、边合成边播。
 */
const MAX_CHARS = 4000
/** 一段最长多少字。宁长勿短：短句各自独立合成会让语调断裂、气音变多。 */
const SEGMENT_CHARS = 120
/** 队列里保留多少条，够浏览器追上即可。 */
const QUEUE_KEEP = 40
/** 单次 /tts 请求超时。 */
const TTS_TIMEOUT_MS = 120_000
/** 等服务端口就绪的最长时间（首次加载模型很慢）。 */
const BOOT_TIMEOUT_MS = 180_000

export const DEFAULTS = {
  /** 主动朗读开关。 */
  enabled: true,
  volume: 1,
  speed: 1,
  /** 是否也朗读用户自己的消息。 */
  speakUser: false,
  baseUrl: 'http://127.0.0.1:9880',
  /**
   * 部署根目录。留空 = `$DSH_HOME/dania-voice`。
   *
   * 下面几个路径都从它派生，所以大多数人**不需要填任何路径**：
   * 一键部署会把 GPT-SoVITS、venv、模型都装进这个目录。
   */
  installDir: '',
  /** 以下四项留空即按 installDir 派生；只有手工部署过的人才需要单独指定。 */
  pythonPath: '',
  root: '',
  cacheDir: '',
  ffmpegDir: '',
  refAudio: 'output/slicer_opt/output.wav_0009342720_0009558400.wav',
  promptText: '怎么啊？如果有你在也不放心，那就干脆给我也装个限制器或者炸弹喽。',
  promptLang: 'zh',
  textLang: 'zh',
  autostart: true,
  /**
   * 采样参数。默认值偏保守：
   *   temperature=1 会让语气和呼吸声飘（实测"气音明显"），降到 0.7 稳定很多；
   *   top_k 收窄一点，减少那种突然的怪调。
   */
  temperature: 0.7,
  topK: 10,
  topP: 0.9,
  repetitionPenalty: 1.35,
  /** 句间停顿（秒）。太短会显得赶。 */
  fragmentInterval: 0.4,
  /** 服务端的切句方式；cut2 按标点切，配合我们自己的聚合更稳。 */
  textSplitMethod: 'cut2',
}

/**
 * 把配置里的相对路径解析成绝对路径。
 *
 * 所有部署相关的路径都从 `installDir`（默认 `$DSH_HOME/dania-voice`）派生：
 * 这样用户什么都不用填，一键部署装进去就能用。
 * @param {ReturnType<typeof normalizeConfig>} cfg - 已归一化的配置。
 * @param {string} dshHome - DSH 主目录。
 * @returns {{base:string, root:string, pythonPath:string, cacheDir:string, logFile:string}} 绝对路径集合。
 */
export function resolvePaths(cfg, dshHome) {
  const base = cfg.installDir && cfg.installDir.trim() !== ''
    ? cfg.installDir
    : join(dshHome, STATE_DIRNAME)
  const root = cfg.root && cfg.root.trim() !== '' ? cfg.root : join(base, 'gpt-sovits')
  const pythonPath = cfg.pythonPath && cfg.pythonPath.trim() !== ''
    ? cfg.pythonPath
    : join(base, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python')
  const cacheDir = cfg.cacheDir && cfg.cacheDir.trim() !== '' ? cfg.cacheDir : join(base, 'cache')
  return { base, root, pythonPath, cacheDir, logFile: join(base, 'install.log') }
}

/** 只接受有限数字，否则回落。 */
function num(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(value, min), max)
}

/** 把任意输入收敛成合法配置。 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const str = (key) => (typeof input[key] === 'string' ? input[key] : DEFAULTS[key])
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULTS.enabled,
    volume: num(input.volume, DEFAULTS.volume, 0, 1),
    speed: num(input.speed, DEFAULTS.speed, 0.5, 2),
    speakUser: typeof input.speakUser === 'boolean' ? input.speakUser : DEFAULTS.speakUser,
    baseUrl: str('baseUrl'),
    pythonPath: str('pythonPath'),
    root: str('root'),
    refAudio: str('refAudio'),
    promptText: str('promptText'),
    promptLang: str('promptLang'),
    textLang: str('textLang'),
    autostart: typeof input.autostart === 'boolean' ? input.autostart : DEFAULTS.autostart,
    cacheDir: str('cacheDir'),
    temperature: num(input.temperature, DEFAULTS.temperature, 0.05, 2),
    topK: Math.round(num(input.topK, DEFAULTS.topK, 1, 100)),
    topP: num(input.topP, DEFAULTS.topP, 0.05, 1),
    repetitionPenalty: num(input.repetitionPenalty, DEFAULTS.repetitionPenalty, 1, 2),
    fragmentInterval: num(input.fragmentInterval, DEFAULTS.fragmentInterval, 0, 2),
    textSplitMethod: str('textSplitMethod'),
    installDir: str('installDir'),
  }
}

/**
 * 把 markdown 正文处理成「能念」的纯文本。
 *
 * 助手回复里大量内容是代码块、表格、链接、列表符号，直接念会非常难听，所以这里
 * 不是「美化」而是「剔除视觉信息、只留可听的句子」。
 * @param {string} text - 原始 markdown。
 * @returns {string} 可朗读文本。
 */
export function cleanForSpeech(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`([^`]*)`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/**
 * 按句切分，并把过长的句子再按逗号切开。
 * @param {string} text - 已清洗的文本。
 * @param {number} maxLen - 单段上限。
 * @returns {string[]} 分段列表。
 */
export function splitSegments(text, maxLen = SEGMENT_CHARS) {
  const rough = String(text)
    .split(/(?<=[。！？!?；;…\n])/)
    .map((s) => s.trim())
    .filter(Boolean)

  // 先按上限**聚合**，而不是见到句号就切开。
  // 短句独立合成会让每句都重新"起调"，听感上语速忽快忽慢、句尾气音多；
  // 把相邻短句并成一段交给 GPT-SoVITS，它自己按标点断，韵律才连贯。
  const merged = []
  let buffer = ''
  for (const piece of rough) {
    if (buffer !== '' && buffer.length + piece.length > maxLen) {
      merged.push(buffer)
      buffer = ''
    }
    buffer += piece
    if (buffer.length >= maxLen) {
      merged.push(buffer)
      buffer = ''
    }
  }
  if (buffer !== '') merged.push(buffer)

  const out = []
  for (const piece of merged) {
    if (piece.length <= maxLen) {
      out.push(piece)
      continue
    }
    let rest = piece
    while (rest.length > maxLen) {
      const window = rest.slice(0, maxLen)
      const cut = Math.max(
        window.lastIndexOf('，'),
        window.lastIndexOf(','),
        window.lastIndexOf('、'),
      )
      const at = cut > maxLen * 0.4 ? cut + 1 : maxLen
      out.push(rest.slice(0, at).trim())
      rest = rest.slice(at).trim()
    }
    if (rest) out.push(rest)
  }
  return out.filter((s) => s.length > 0)
}

/** TCP 探测，别用 HTTP —— 服务还没就绪时 HTTP 会等很久。 */
function portOpen(port, host = '127.0.0.1', timeout = 700) {
  return new Promise((resolve) => {
    const socket = connect({ port, host })
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch { /* already gone */ }
      resolve(value)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.once('timeout', () => done(false))
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 挂载插件。
 * @param {any} ctx - cordis 插件上下文。
 * @param {any} rawConfig - profile 里这一行的 config。
 */
export function apply(ctx, rawConfig) {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  // 配置文件固定在 $DSH_HOME 下：它是「指向部署目录」的路标，不能跟着部署目录跑。
  const stateDir = join(dshHome, STATE_DIRNAME)
  // 必须先把目录建出来：全新安装时它不存在，而 saveOverrides 往这里写 config.json。
  // 少了这一行，写入会静默失败，开关状态永远存不下来——表现为「关了过一会儿又自己变回彩色」。
  try {
    mkdirSync(stateDir, { recursive: true })
  } catch { /* 建不了的话后面写入会各自报错 */ }

  let config = normalizeConfig(rawConfig)
  const stateFile = join(stateDir, 'config.json')
  const logFile = join(stateDir, 'server.log')

  /** 当前生效的部署路径（全部从 installDir 派生）。 */
  function paths() {
    return resolvePaths(effective(), dshHome)
  }

  /**
   * 音频缓存目录。
   *
   * 跟着配置走、默认落在数据盘：每段 wav 几十到几百 KB，攒起来不该塞进 C 盘。
   * @returns {string} 绝对路径。
   */
  function audioDir() {
    const dir = paths().cacheDir
    try {
      mkdirSync(dir, { recursive: true })
    } catch { /* 写入时各自报错 */ }
    return dir
  }

  /** 读盘上覆盖的配置（设置面板写的），落在 patch 之上。 */
  function loadOverrides() {
    try {
      if (!existsSync(stateFile)) return {}
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  /**
   * 原子写回。
   *
   * 返回是否真的写成功：调用方（/config）要把失败如实告诉浏览器，
   * 否则界面会以为存下了，下一轮轮询又被读回旧值——看起来就是"开关自己弹回去"。
   * @param {object} patch - 要合并进去的字段。
   * @returns {boolean} 写入是否成功。
   */
  function saveOverrides(patch) {
    try {
      mkdirSync(stateDir, { recursive: true })
      const next = { ...loadOverrides(), ...patch }
      const temp = `${stateFile}.tmp`
      writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      renameSync(temp, stateFile)
      return true
    } catch (error) {
      log('warn', `配置写入失败：${error?.message ?? error}`)
      return false
    }
  }
  /** 每次读都合并一次，让设置面板改完立即生效。 */
  function effective() {
    return normalizeConfig({ ...config, ...loadOverrides() })
  }

  function log(level, message) {
    try {
      if (level === 'warn' && typeof ctx.logger?.warn === 'function') ctx.logger.warn(`dsh-dania-voice: ${message}`)
      else if (typeof ctx.logger?.info === 'function') ctx.logger.info(`dsh-dania-voice: ${message}`)
    } catch { /* logging must never break the plugin */ }
  }

  // ── 播放队列 ──────────────────────────────────────────────────────────────
  /** @type {{seq:number,text:string,file:string,url:string,ts:number}[]} */
  const queue = []
  let cursor = 0
  let lastError = ''
  let lastSynthAt = 0
  let charsSpoken = 0
  let speaking = 0
  /** 最近一轮助手回复的正文，供「重读上一段」使用。 */
  let lastTurnText = ''

  /** 实例身份 + 诊断日志：判断是不是有多个实例在各自维护队列。 */
  const INSTANCE = Math.random().toString(36).slice(2, 8)
  function dbg(message) {
    try {
      mkdirSync(join(DEFAULTS.cacheDir, 'state'), { recursive: true })
      writeFileSync(
        join(DEFAULTS.cacheDir, 'state', 'debug.log'),
        `${new Date().toISOString()} [${INSTANCE}] ${message}\n`,
        { flag: 'a' },
      )
    } catch { /* 诊断失败不能影响功能 */ }
  }

  function pushQueue(text, file) {
    cursor += 1
    queue.push({
      seq: cursor,
      text,
      file,
      url: `${ROUTE}/audio/${encodeURIComponent(file)}`,
      ts: Date.now(),
    })
    while (queue.length > QUEUE_KEEP) queue.shift()
    dbg(`push seq=${cursor} len=${queue.length}`)
  }

  // ── TTS 服务管理 ──────────────────────────────────────────────────────────
  /** @type {import('node:child_process').ChildProcess | null} */
  let serverChild = null
  let bootPromise = null
  let disposed = false
  /** 一键部署的子进程；非 null 表示正在装。 */
  let installChild = null

  function serverPort() {
    try {
      return Number(new URL(effective().baseUrl).port || 80)
    } catch {
      return 9880
    }
  }

  async function serverReady() {
    return portOpen(serverPort())
  }

  /** 把子进程输出写进日志文件，出问题时能回看加载失败的真正原因。 */
  function attachLog(child) {
    const sink = (chunk) => {
      try {
        writeFileSync(logFile, chunk.toString(), { flag: 'a' })
      } catch { /* ignore */ }
    }
    child.stdout?.on('data', sink)
    child.stderr?.on('data', sink)
  }

  /** 拉起 api_v2.py，并把「已就绪」缓存成 promise 避免并发重入。 */
  async function ensureServer() {
    if (await serverReady()) return true
    if (bootPromise) return bootPromise
    const cfg = effective()
    const p = paths()
    if (!cfg.autostart) {
      lastError = '服务未启动（自动启动已关闭）'
      return false
    }
    const script = join(p.root, 'api_v2.py')
    if (!existsSync(p.pythonPath)) {
      lastError = `还没部署：找不到 Python（${p.pythonPath}），点面板上的「一键部署」`
      return false
    }
    if (!existsSync(script)) {
      lastError = `还没部署：找不到 api_v2.py（${script}），点面板上的「一键部署」`
      return false
    }

    bootPromise = (async () => {
      log('info', '正在启动 GPT-SoVITS 服务…')
      try {
        writeFileSync(logFile, `\n=== ${new Date().toISOString()} boot ===\n`, { flag: 'a' })
      } catch { /* ignore */ }
      try {
        const pathPrefix = cfg.ffmpegDir && cfg.ffmpegDir.trim() !== '' ? `${cfg.ffmpegDir};` : ''
        serverChild = spawn(
          p.pythonPath,
          ['api_v2.py', '-a', '127.0.0.1', '-p', String(serverPort()), '-c', 'GPT_SoVITS/configs/tts_infer.yaml'],
          {
            cwd: p.root,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            // ffmpeg 在 PATH 里：api_v2 的音频处理会用到它，而从桌面壳继承来的 PATH
            // 不一定含 WinGet 的 shim 目录。
            env: {
              ...process.env,
              PATH: `${pathPrefix}${process.env.PATH ?? ''}`,
            },
          },
        )
        attachLog(serverChild)
        serverChild.on('exit', (code) => {
          log('warn', `GPT-SoVITS 退出，code=${code}`)
          serverChild = null
        })
        serverChild.on('error', (error) => {
          log('warn', `GPT-SoVITS 启动失败：${error?.message ?? error}`)
          serverChild = null
        })
      } catch (error) {
        lastError = `启动失败：${error?.message ?? error}`
        bootPromise = null
        return false
      }

      const deadline = Date.now() + BOOT_TIMEOUT_MS
      while (Date.now() < deadline) {
        if (disposed) return false
        if (await serverReady()) {
          log('info', 'GPT-SoVITS 服务就绪')
          lastError = ''
          return true
        }
        if (serverChild === null) {
          lastError = '服务进程提前退出，详情见 dania-voice/server.log'
          bootPromise = null
          return false
        }
        await sleep(1500)
      }
      lastError = '等待服务就绪超时'
      bootPromise = null
      return false
    })()

    return bootPromise
  }

  /** 调一次 /tts，落盘，返回文件名。 */
  async function synthesize(segment) {
    const cfg = effective()
    // 文件名带上影响音色的参数：改了参数就是另一段音频，重读该重新合成；
    // 参数没变时命中缓存，重读是秒回的（不用再跑一遍 GPU）。
    const fingerprint = `${segment}|${cfg.speed}|${cfg.temperature}|${cfg.topK}|${cfg.topP}|${cfg.fragmentInterval}|${cfg.textSplitMethod}`
    const name = `${createHash('sha1').update(fingerprint).digest('hex').slice(0, 16)}.wav`
    const target = join(audioDir(), name)
    if (existsSync(target)) return name

    const body = {
      text: segment,
      text_lang: cfg.textLang,
      ref_audio_path: cfg.refAudio,
      prompt_text: cfg.promptText,
      prompt_lang: cfg.promptLang,
      text_split_method: cfg.textSplitMethod,
      media_type: 'wav',
      streaming_mode: false,
      speed_factor: cfg.speed,
      batch_size: 1,
      parallel_infer: true,
      repetition_penalty: cfg.repetitionPenalty,
      temperature: cfg.temperature,
      top_k: cfg.topK,
      top_p: cfg.topP,
      fragment_interval: cfg.fragmentInterval,
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS)
    let response
    try {
      response = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`TTS ${response.status}: ${detail.slice(0, 200)}`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length < 1000) throw new Error('TTS 返回的音频为空')
    writeFileSync(target, buffer)
    return name
  }

  /** 串行合成队列：GPU 一次只能跑一个，并发只会互相拖慢。 */
  let chain = Promise.resolve()
  function enqueueSpeech(text) {
    let cleaned = cleanForSpeech(text)
    if (!cleaned) return
    // 超长回复要「分段读完」，而不是切掉后半截。
    // 这里只是给单轮一个总闸（避免一次贴几万字把队列堵死），闸门远高于常见回复长度。
    if (cleaned.length > MAX_CHARS) {
      cleaned = cleaned.slice(0, MAX_CHARS)
      lastError = `本轮文本超过 ${MAX_CHARS} 字，只朗读了前 ${MAX_CHARS} 字`
    }
    const segments = splitSegments(cleaned)
    if (segments.length === 0) return

    chain = chain.then(async () => {
      if (!effective().enabled) return
      const ok = await ensureServer()
      if (!ok) return
      // 长文本里某一段失败不该让后面全部闭嘴：跳过它继续往下念。
      // 只有「连续」失败才说明服务真的挂了，那时才停。
      let failures = 0
      for (const segment of segments) {
        if (!effective().enabled || disposed) return
        try {
          speaking += 1
          const file = await synthesize(segment)
          charsSpoken += segment.length
          lastSynthAt = Date.now()
          lastError = ''
          pushQueue(segment, file)
          failures = 0
        } catch (error) {
          failures += 1
          lastError = String(error?.message ?? error)
          log('warn', `合成失败（第 ${failures} 次）：${lastError}`)
          if (failures >= 3) {
            lastError = `${lastError}（连续失败 3 次，已停止本轮）`
            return
          }
        } finally {
          speaking = Math.max(0, speaking - 1)
        }
      }
    }).catch((error) => {
      lastError = String(error?.message ?? error)
    })
  }

  // ── 会话事件 ──────────────────────────────────────────────────────────────
  /** 每个会话本轮最后一条带正文的助手消息。 */
  const pending = new Map()
  try {
    ctx.on('session/event', (session, event) => {
      try {
        const type = event?.type
        const data = event?.data
        if (!data || typeof data !== 'object') return
        const sid = session?.id ?? 'default'

        if (type === 'assistant/message') {
          const message = data.message
          if (!message || !Array.isArray(message.content)) return
          const texts = []
          for (const block of message.content) {
            if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
              texts.push(block.text)
            }
          }
          if (texts.length > 0) pending.set(sid, { turn: data.turn, text: texts.join('\n') })
          return
        }

        if (type === 'turn/end') {
          const collected = pending.get(sid)
          pending.delete(sid)
          if (!collected) return
          // 记住这一轮的正文，「重读上一段」要用；即使当时关着朗读也记。
          lastTurnText = collected.text
          // 读配置而不是读闭包：设置面板可能在会话进行中把开关关掉。
          if (!effective().enabled) return
          enqueueSpeech(collected.text)
          return
        }

        if (type === 'user/message' && effective().speakUser) {
          const message = data.message
          const text = typeof message?.content === 'string'
            ? message.content
            : Array.isArray(message?.content)
              ? message.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
              : ''
          if (text) enqueueSpeech(text)
        }
      } catch (error) {
        log('warn', `事件处理失败：${error?.message ?? error}`)
      }
    })
  } catch (error) {
    log('warn', `无法监听会话事件：${error?.message ?? error}`)
  }

  // ── 注入（必须同步注册） ──────────────────────────────────────────────────
  try {
    ctx.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (row && row.kind === 'script' && typeof row.text === 'string' && row.text.includes(CLIENT_ROUTE)) return
        }
        table.push({
          kind: 'script',
          placement: 'body',
          text:
            '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;'
            + 'if(document.querySelector("script[data-dania-voice]"))return;'
            + 'var s=document.createElement("script");s.src="' + CLIENT_ROUTE + '?v=' + Date.now() + '";s.async=true;'
            + 's.setAttribute("data-dania-voice","1");s.onerror=function(){};d.appendChild(s)}catch(e){}})()',
        })
      } catch { /* 注入失败不能拖垮启动 */ }
    })
  } catch (error) {
    log('warn', `无法注册注入行：${error?.message ?? error}`)
  }

  // ── 路由 ──────────────────────────────────────────────────────────────────
  ctx.inject(['webServer'], (scoped) => {
    /** 只放行本机回环请求。 */
    const reject = (req, res) => {
      try {
        const connection = typeof scoped.get === 'function' ? scoped.get('connection') : undefined
        if (connection && typeof connection.requestRejection === 'function') {
          const code = connection.requestRejection(req)
          if (code !== undefined) {
            res.writeHead(code)
            res.end()
            return true
          }
        }
      } catch { /* 老宿主没有这个服务，退回自己的判断 */ }
      const host = String(req.headers.host ?? '')
      const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
      const loopback = name === 'localhost' || name === '::1' || name === '127.0.0.1'
        || /^127\.\d+\.\d+\.\d+$/.test(name)
      if (!loopback) {
        res.writeHead(403)
        res.end()
        return true
      }
      return false
    }

    const json = (res, code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }

    const readBody = (req, limit = 64 * 1024) => new Promise((resolveBody) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          req.destroy()
          resolveBody(undefined)
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          resolveBody(undefined)
        }
      })
      req.on('error', () => resolveBody(undefined))
    })

    const status = async () => {
      const cfg = effective()
      const p = paths()
      const ready = await serverReady()
      // 三个必须同时在位才算「装好了」：Python 解释器、api_v2.py、达妮娅模型。
      const installed = existsSync(p.pythonPath)
        && existsSync(join(p.root, 'api_v2.py'))
        && existsSync(join(p.root, 'GPT_SoVITS', 'dania-e15.ckpt'))
      // 部署日志的尾巴：装的过程中面板要能看见"现在到哪一步了"。
      let logTail = ''
      try {
        if (existsSync(p.logFile)) logTail = readFileSync(p.logFile, 'utf8').slice(-1200)
      } catch { /* 读不到就不显示 */ }
      return {
        enabled: cfg.enabled,
        volume: cfg.volume,
        speed: cfg.speed,
        speakUser: cfg.speakUser,
        autostart: cfg.autostart,
        engine: 'GPT-SoVITS · 达妮娅',
        serverReady: ready,
        installed,
        installing: installChild !== null,
        installDir: p.base,
        installLog: p.logFile,
        logTail,
        speaking,
        queueLen: queue.length,
        cursor,
        charsSpoken,
        lastSynthAt,
        lastError,
        model: 'dania-e15.ckpt / dania_e16_s2192.pth',
      }
    }

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: CLIENT_ROUTE,
      handler: (req, res) => {
        if (reject(req, res)) return
        try {
          const file = new URL('./client.js', import.meta.url)
          const body = readFileSync(file, 'utf8')
          res.writeHead(200, {
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(body)
        } catch (error) {
          res.writeHead(500)
          res.end(String(error?.message ?? error))
        }
      },
    }))

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: `${ROUTE}/status`,
      handler: async (req, res) => {
        if (reject(req, res)) return
        json(res, 200, await status())
      },
    }))

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: `${ROUTE}/config`,
      handler: async (req, res) => {
        if (reject(req, res)) return
        if (req.method === 'GET') {
          json(res, 200, effective())
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end()
          return
        }
        const body = await readBody(req)
        if (!body || typeof body !== 'object') {
          json(res, 400, { ok: false })
          return
        }
        const patch = {}
        for (const key of ['enabled', 'volume', 'speed', 'speakUser', 'autostart',
          'temperature', 'topK', 'topP', 'repetitionPenalty', 'fragmentInterval']) {
          if (key in body) patch[key] = body[key]
        }
        const saved = saveOverrides(patch)
        if (!saved) {
          // 写不进去就明确失败：让浏览器知道这次没生效，而不是假装成功后被轮询打脸。
          json(res, 500, { ok: false, error: 'config-write-failed', config: effective() })
          return
        }
        json(res, 200, { ok: true, config: effective() })
      },
    }))

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: `${ROUTE}/next`,
      handler: (req, res) => {
        if (reject(req, res)) return
        const since = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('since'))
        if (!Number.isFinite(since)) {
          // 首次调用：只告诉浏览器当前游标，不重放历史。
          json(res, 200, { items: [], cursor })
          return
        }
        const items = queue.filter((item) => item.seq > since)
        dbg(`next since=${since} cursor=${cursor} len=${queue.length} out=${items.length}`)
        json(res, 200, { items, cursor })
      },
    }))

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: `${ROUTE}/repeat`,
      handler: async (req, res) => {
        if (reject(req, res)) return
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end()
          return
        }
        const text = lastTurnText
        if (!text.trim()) {
          json(res, 200, { ok: false, error: 'nothing-to-repeat' })
          return
        }
        enqueueSpeech(text)
        dbg(`repeat chars=${text.length}`)
        json(res, 200, { ok: true })
      },
    }))

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: `${ROUTE}/say`,
      handler: async (req, res) => {
        if (reject(req, res)) return
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end()
          return
        }
        const body = await readBody(req)
        const text = typeof body?.text === 'string' ? body.text : ''
        if (!text.trim()) {
          json(res, 400, { ok: false, error: 'empty' })
          return
        }
        enqueueSpeech(text)
        dbg(`say chars=${text.length}`)
        json(res, 200, { ok: true })
      },
    }))

    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: `${ROUTE}/start`,
      handler: async (req, res) => {
        if (reject(req, res)) return
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end()
          return
        }
        const ok = await ensureServer()
        json(res, 200, { ok, error: ok ? '' : lastError })
      },
    }))

    // 一键部署：把安装器作为独立子进程跑，进度写进 install.log，面板轮询状态。
    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: `${ROUTE}/setup`,
      handler: async (req, res) => {
        if (reject(req, res)) return
        if (req.method !== 'POST') {
          res.writeHead(405)
          res.end()
          return
        }
        if (installChild !== null) {
          json(res, 200, { ok: true, already: true })
          return
        }
        const p = paths()
        try {
          mkdirSync(p.base, { recursive: true })
          writeFileSync(p.logFile, '', 'utf8')
        } catch { /* 下面启动失败会报出来 */ }
        try {
          installChild = spawn(
            process.execPath,
            [fileURLToPath(new URL('./scripts/install.mjs', import.meta.url))],
            {
              cwd: p.base,
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: {
                ...process.env,
                // DSH 宿主是 Electron：拿它自己当 node 用。
                ELECTRON_RUN_AS_NODE: '1',
                DANIA_INSTALL_DIR: p.base,
                DANIA_LOG: p.logFile,
                DANIA_PYPI: process.env.DANIA_PYPI ?? 'https://mirrors.aliyun.com/pypi/simple/',
                DANIA_HF: process.env.DANIA_HF ?? 'https://hf-mirror.com',
              },
            },
          )
          attachLog(installChild)
          installChild.on('exit', (code) => {
            log('warn', `部署进程退出，code=${code}`)
            installChild = null
          })
          installChild.on('error', (error) => {
            log('warn', `部署进程启动失败：${error?.message ?? error}`)
            installChild = null
          })
          json(res, 200, { ok: true, started: true, log: p.logFile })
        } catch (error) {
          installChild = null
          json(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }))

    // 面板用的贴图（背景与头像）。只放行两个固定文件名，杜绝拿它当文件服务器。
    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: `${ROUTE}/assets`,
      handler: (req, res) => {
        if (reject(req, res)) return
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        let name
        try {
          name = decodeURIComponent(String(req.url ?? '').slice(`${ROUTE}/assets`.length).replace(/^\//, '').split('?')[0])
        } catch {
          res.writeHead(400)
          res.end()
          return
        }
        if (name !== 'bg.jpg' && name !== 'icon.png' && name !== 'rope-tile.png') {
          res.writeHead(404)
          res.end()
          return
        }
        try {
          const body = readFileSync(new URL(`./assets/${name}`, import.meta.url))
          res.writeHead(200, {
            'content-type': name.endsWith('.png') ? 'image/png' : 'image/jpeg',
            'content-length': String(body.length),
            // 这两张图会被替换（换头像、换背景），别让浏览器长期缓存旧版本。
            'cache-control': 'no-cache, must-revalidate',
          })
          res.end(req.method === 'HEAD' ? undefined : body)
        } catch {
          res.writeHead(404)
          res.end()
        }
      },
    }))

    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: `${ROUTE}/audio`,
      handler: (req, res) => {
        if (reject(req, res)) return
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        let name
        try {
          name = decodeURIComponent(String(req.url ?? '').slice(`${ROUTE}/audio`.length).replace(/^\//, '').split('?')[0])
        } catch {
          res.writeHead(400)
          res.end()
          return
        }
        // 只放行我们自己写进去的文件名，杜绝路径穿越。
        if (!/^[a-f0-9]{16}\.wav$/.test(name)) {
          res.writeHead(404)
          res.end()
          return
        }
        const file = join(audioDir(), name)
        if (!existsSync(file)) {
          res.writeHead(404)
          res.end()
          return
        }
        const size = statSync(file).size
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': String(size),
          'cache-control': 'no-store',
        })
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        createReadStream(file).pipe(res)
      },
    }))
  })

  // 插件卸载时收掉自己拉起的服务进程，别留孤儿进程占显存。
  ctx.effect(() => () => {
    disposed = true
    try {
      if (serverChild) serverChild.kill()
    } catch { /* already gone */ }
    serverChild = null
  })

  // 预热：插件挂载后静默探一次，服务没起就按配置拉起，避免第一句话等太久。
  setTimeout(() => {
    ensureServer().catch(() => {})
  }, 3000)

  log('info', '已挂载（达妮娅语音）')
  dbg('mounted')
}

export default {
  name: 'dania-voice',
  apply,
}
