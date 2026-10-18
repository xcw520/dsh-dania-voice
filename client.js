/**
 * dsh-dania-voice — Browser half.
 *
 * 一个悬浮开关 + 播放队列。真正的合成在 Host 侧（本地 GPT-SoVITS），这里只负责
 * 「把已经合成好的 wav 播出来」和「让用户能一键关掉」。
 *
 * 为什么用 Web Audio 而不是 <audio>：
 *   播放发生在 poll 回调里（setTimeout），那时「用户手势」早已过期，Chromium 的
 *   自动播放策略会静默拒绝 <audio>.play()——表现就是「点了试听没声音，也没有报错」。
 *   AudioContext 只要在真实点击里 resume 过一次，之后在回调里 start() 不受该限制。
 */

(function () {
  if (window.__DSH_DANIA_VOICE__) return
  window.__DSH_DANIA_VOICE__ = true

  const ROUTE = '/dania-voice'
  const POLL_MS = 1500
  /** 面板上显示，用来确认浏览器加载的是哪一版脚本。 */
  const CLIENT_VERSION = 'v15-rope'

  const state = {
    enabled: true,
    volume: 1,
    speed: 1,
    temperature: 0.7,
    fragmentInterval: 0.4,
    serverReady: false,
    /** 部署是否完成；false 时面板显示「一键部署」。 */
    installed: true,
    installing: false,
    logTail: '',
    speaking: 0,
    queueLen: 0,
    lastError: '',
    lastPlayNote: '',
    cursor: null,
  }

  /** 待播放列表，串行播放，避免几段叠在一起。 */
  const pending = []
  let playing = false
  /** 持久保存：这是绕过自动播放限制的关键。 */
  let audioCtx = null
  let currentSource = null
  /**
   * 专用于 `/next` 增量的游标。
   *
   * **绝不能**复用 state.cursor：/status 也带 cursor，而 tick 会用 status 覆盖 state，
   * 于是每次轮询前游标都被拉到 host 最新值，刚合成好的条目正好落在跳过的区间里
   * （实测现象：push seq=1,2 之后客户端立刻 since=2 → out=0，永远拿不到音频）。
   */
  let nextCursor = null
  /** 被「重载脚本」停掉后，旧实例不再轮询/播放。 */
  let stopped = false
  window.__DSH_DANIA_VOICE_STOP__ = () => {
    stopped = true
    try {
      currentSource?.stop()
    } catch { /* 已经停了 */ }
    try {
      host.remove()
    } catch { /* 已经移除 */ }
  }

  // ── UI ────────────────────────────────────────────────────────────────────
  const host = document.createElement('div')
  host.id = 'dsh-dania-voice-root'
  host.style.cssText = 'position:fixed;z-index:2147483000;right:22px;bottom:118px;'
  const shadow = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = `
    :host { all: initial; }
    .wrap { font: 13px/1.5 "Microsoft YaHei", system-ui, sans-serif; color: #f2f5f8; }
    /*
     * 可拉伸的延伸绳：接在挂件图片上方，往下拉时变长、松手回弹。
     *
     * 对齐要点（不然交界处一眼看出是两截）：
     *   1. 宽度按原图里绳子的实际占比换算，绳身粗细要一致；
     *   2. left 让绳子的**中心线**与原图重合；
     *   3. 向下重叠 3px，把接缝压在图片底下；
     *   4. background-position 用 bottom，让纹理的相位从交界处往下数，编织纹连续。
     */
    .rope {
      position: absolute; left: 22%; bottom: 100%; width: 7.8%; height: 0;
      background: url('/dania-voice/assets/rope-tile.png?v=9') repeat-y center bottom / 100% auto;
      pointer-events: none; display: none;
      transition: filter .2s ease, opacity .2s ease;
    }
    /* 关闭时绳子也要跟着褪色，否则会出现"人灰了、绳还亮着" */
    .rope.dim { filter: grayscale(1); opacity: .52; }
    .rope.pulling { display: block; }
    /* 挂件就是那张图本身：绳子和角色都画在里面，不加任何外发光/投影 */
    .btn {
      width: 100px; height: 112px; padding: 0; cursor: grab; border: none;
      background: transparent url('/dania-voice/assets/icon.png?v=8') center bottom / contain no-repeat;
      transition: transform .12s ease, filter .2s ease, opacity .2s ease;
      touch-action: none; user-select: none;
    }
    .btn:active { cursor: grabbing; }
    .btn:hover { transform: translateY(-2px); }
    /* 开着：纯彩色，不加任何光；关着：整只变黑白（这是状态区分，不是特效） */
    .btn.on { filter: none; }
    /*
     * 关闭态不用压暗（压暗会把细节糊成一团灰），改成「去色 + 淡出」：
     * 保留原来的明暗层次，只是整体退到背景里，一眼能看出"没在念"。
     */
    .btn.off { filter: grayscale(1); opacity: .52; }
    /*
     * 正在念：整只挂件绕**绳子顶端**摆动，像钟摆。
     *
     * 不能让 .btn 自己 translateY —— 那样按钮在动、绳子不动，接缝处会裂开。
     * 旋转中心定在绳子的顶锚点（x=23.9%），绳子与按钮就作为一个整体摆。
     */
    .wrap.busy { animation: sway 1.7s ease-in-out infinite; transform-origin: 23.9% 0; }
    .btn.dead { filter: grayscale(1) brightness(.7); opacity: .4; }
    @keyframes sway {
      0%, 100% { transform: rotate(-1.3deg); }
      50% { transform: rotate(1.3deg); }
    }
    .panel {
      position: absolute; right: 0; bottom: 70px; width: 258px; padding: 0 0 12px;
      border: 1px solid rgba(255,140,190,.35); border-radius: 14px; overflow: hidden;
      box-shadow: 0 14px 34px rgba(0,0,0,.5); display: none;
      background: #14161d url('/dania-voice/assets/bg.jpg?v=3') center top / cover no-repeat;
    }
    /* 按钮被拖到屏幕上半部分时，面板改到下方，否则会被窗口顶边切掉 */
    .panel.below { bottom: auto; top: 70px; }
    .panel.open { display: block; }
    /* 压暗一层，保证标题和正文在任何背景色上都读得清 */
    .panel::before {
      content: ''; position: absolute; inset: 0; pointer-events: none;
      background: linear-gradient(180deg, rgba(16,18,25,.7) 0%, rgba(16,18,25,.9) 42%, rgba(16,18,25,.96) 100%);
    }
    .panel > * { position: relative; }
    .head { padding: 12px 14px 9px; border-bottom: 1px solid rgba(255,255,255,.1); margin-bottom: 9px; }
    .title { font-size: 17px; font-weight: 700; letter-spacing: 4px; color: #ffd6e8; text-shadow: 0 0 12px rgba(255,122,176,.6); }
    .sub { font-size: 11px; color: #cba6ba; letter-spacing: 1px; margin-top: 3px; }
    .body { padding: 0 14px; }
    .link { display: block; margin: 10px 14px 0; color: #6d7686; font-size: 11px; text-align: right; cursor: pointer; }
    .link:hover { color: #9aa4b2; text-decoration: underline; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 6px 0; }
    .k { color: #9aa4b2; flex: 0 0 auto; }
    .v { color: #fff; text-align: right; word-break: break-all; }
    .ok { color: #7ee787; }
    .bad { color: #ff9d9d; }
    .hint { color: #9aa4b2; font-size: 12px; margin-top: 8px; line-height: 1.45; }
    .setup { display: none; margin: 6px 0 2px; }
    .log {
      max-height: 116px; overflow: auto; margin: 8px 0 0; padding: 6px 8px;
      background: rgba(0,0,0,.5); border: 1px solid rgba(255,255,255,.1); border-radius: 8px;
      font: 11px/1.45 Consolas, "Courier New", monospace; color: #b9c2cf;
      white-space: pre-wrap; word-break: break-all;
    }
    .log:empty { display: none; }
    .err { color: #ff9d9d; font-size: 12px; margin-top: 6px; line-height: 1.45; word-break: break-all; }
    input[type=range] { width: 100%; accent-color: #ff7ab0; }
    button.mini {
      width: 100%; margin-top: 8px; padding: 6px 8px; border-radius: 8px; cursor: pointer;
      border: 1px solid rgba(255,255,255,.2); background: rgba(255,255,255,.08); color: #e8edf3;
      font: inherit;
    }
    button.mini:hover { background: rgba(255,255,255,.14); }
  `

  const wrap = document.createElement('div')
  wrap.className = 'wrap'

  const panel = document.createElement('div')
  panel.className = 'panel'
  panel.innerHTML = `
    <div class="head">
      <div class="title">达妮娅</div>
      <div class="sub">星炬学院 · 虚质科学部</div>
    </div>
    <div class="body">
      <div class="row"><span class="k">状态</span><span class="v" data-f="enabled"></span></div>
      <div class="row"><span class="k">本地服务</span><span class="v" data-f="server"></span></div>
      <!-- 未部署时只显示这一段：一键部署 + 进度日志 -->
      <div class="setup" data-f="setup">
        <div class="hint">还没部署本地语音引擎。点下面开始自动安装
          （Python 环境 + GPT-SoVITS + 达妮娅模型，约 4 GB 下载）。</div>
        <button class="mini" data-f="install">一键部署</button>
        <pre class="log" data-f="log"></pre>
      </div>
      <div class="tuning" data-f="tuning">
        <div class="row"><span class="k">音量</span><span class="v" data-f="vol"></span></div>
        <input type="range" min="0" max="1" step="0.05" data-f="volrange" />
        <div class="row"><span class="k">语速</span><span class="v" data-f="spd"></span></div>
        <input type="range" min="0.5" max="1.5" step="0.05" data-f="spdrange" />
        <div class="row"><span class="k">温度</span><span class="v" data-f="tmp"></span></div>
        <input type="range" min="0.3" max="1.2" step="0.05" data-f="tmprange" />
        <div class="row"><span class="k">句间停顿</span><span class="v" data-f="fint"></span></div>
        <input type="range" min="0" max="1" step="0.05" data-f="fintrange" />
        <button class="mini" data-f="repeat">重读上一段</button>
        <button class="mini" data-f="test">让她说一句</button>
      </div>
      <div class="hint" data-f="hint"></div>
      <div class="err" data-f="err"></div>
    </div>
    <div class="link" data-f="reload">重载脚本</div>
  `

  const btn = document.createElement('button')
  btn.className = 'btn off'
  btn.type = 'button'
  btn.title = '达妮娅语音朗读'

  const rope = document.createElement('div')
  rope.className = 'rope'

  wrap.appendChild(rope)
  wrap.appendChild(panel)
  wrap.appendChild(btn)
  shadow.appendChild(style)
  shadow.appendChild(wrap)

  function mount() {
    if (!document.body) {
      setTimeout(mount, 300)
      return
    }
    document.body.appendChild(host)
    restorePos()
  }
  mount()

  // ── 拖动、拉绳与位置记忆 ──────────────────────────────────────────────────
  const POS_KEY = 'dsh-dania-voice-pos'
  /** 最多能往下拽多远（像素）。再长绳子就细得不成样子了。 */
  const MAX_PULL = 220
  /** @type {{ dx:number, dy:number, moved:boolean, x:number, y:number, baseLeft:number } | null} */
  let drag = null
  /** 拖动结束后紧跟的那次 click 要吞掉，否则一拖就顺手把开关切了。 */
  let suppressClick = false

  /**
   * 把挂件放到水平位置 left，垂直方向永远贴在窗口顶边。
   *
   * 挂件是"吊"着的，所以 y 恒为 0；竖直方向的位移只发生在拉拽过程中，
   * 松手就回弹到 0。
   * @param {number} left - 左边缘坐标。
   */
  function place(left) {
    const w = host.offsetWidth || 100
    const maxLeft = Math.max(0, window.innerWidth - w)
    const x = Math.min(Math.max(0, left), maxLeft)
    host.style.left = `${Math.round(x)}px`
    host.style.top = '0px'
    host.style.right = 'auto'
    host.style.bottom = 'auto'
  }

  function restorePos() {
    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
      if (saved && Number.isFinite(saved.left)) {
        place(saved.left)
        return
      }
    } catch { /* 记录损坏就回落默认位置 */ }
    // 默认挂在顶部正中：绳子顶端正好贴住窗口上沿。
    const w = host.offsetWidth || 100
    place(window.innerWidth / 2 - w / 2)
  }

  function savePos() {
    const rect = host.getBoundingClientRect()
    try {
      // 只记水平位置：竖直方向是"拉绳"，不持久化。
      localStorage.setItem(POS_KEY, JSON.stringify({ left: rect.left }))
    } catch { /* 存不下就算了，下次回到默认位置 */ }
  }

  /** 面板默认在按钮上方；按钮在上半屏时翻到下方，避免被窗口顶边裁掉。 */
  function placePanel() {
    const rect = host.getBoundingClientRect()
    panel.classList.toggle('below', rect.top < window.innerHeight / 2)
  }

  btn.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    const rect = host.getBoundingClientRect()
    drag = {
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
      moved: false,
      x: event.clientX,
      y: event.clientY,
      baseLeft: rect.left,
    }
    try {
      btn.setPointerCapture(event.pointerId)
    } catch { /* 老浏览器没有指针捕获 */ }
  })

  btn.addEventListener('pointermove', (event) => {
    if (drag === null) return
    const dxTotal = event.clientX - drag.x
    const dyTotal = event.clientY - drag.y
    // 移动超过 4px 才算拖动，否则就是一次普通点击。
    if (!drag.moved && Math.hypot(dxTotal, dyTotal) < 4) return
    drag.moved = true

    // 水平：跟着鼠标走，夹在视口内。这是"把挂件挂到别处"。
    const width = host.offsetWidth || 100
    const left = Math.min(Math.max(0, drag.baseLeft + dxTotal), window.innerWidth - width)
    host.style.left = `${Math.round(left)}px`
    host.style.right = 'auto'
    host.style.bottom = 'auto'

    // 垂直：只往下拉，像拽绳子。挂件下移多少，延伸绳就补多长，
    // 绳子顶端因此始终钉在窗口上沿。
    const pull = Math.max(0, Math.min(dyTotal, MAX_PULL))
    host.style.top = `${Math.round(pull)}px`
    rope.classList.add('pulling')
    rope.style.height = `${Math.round(pull)}px`
  })

  btn.addEventListener('pointerup', (event) => {
    if (drag === null) return
    const moved = drag.moved
    drag = null
    try {
      btn.releasePointerCapture(event.pointerId)
    } catch { /* ignore */ }
    if (moved) {
      suppressClick = true
      savePos()
      // 松手回弹：top 与绳长一起归零，cubic-bezier 带一点过冲，像被拉过的绳子。
      const spring = 'cubic-bezier(.22,1.35,.36,1)'
      host.style.transition = `top .55s ${spring}`
      rope.style.transition = `height .55s ${spring}`
      host.style.top = '0px'
      rope.style.height = '0px'
      window.setTimeout(() => {
        host.style.transition = ''
        rope.style.transition = ''
        rope.classList.remove('pulling')
        rope.style.height = '0'
      }, 620)
      // click 紧跟 pointerup 同步触发，这里等它走完再解除抑制。
      setTimeout(() => {
        suppressClick = false
      }, 0)
    }
  })

  btn.addEventListener('pointercancel', () => {
    drag = null
  })

  window.addEventListener('resize', () => {
    const rect = host.getBoundingClientRect()
    place(rect.left)
  })

  // ── 音频 ──────────────────────────────────────────────────────────────────
  /** 在真实点击里创建/恢复 AudioContext —— 只做一次，之后一直有效。 */
  function unlock() {
    try {
      if (audioCtx === null) {
        const Ctor = window.AudioContext || window.webkitAudioContext
        if (Ctor) audioCtx = new Ctor()
      }
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
    } catch (error) {
      state.lastError = `音频上下文创建失败：${error.message}`
    }
  }

  function next() {
    if (playing) return
    const item = pending.shift()
    if (!item) {
      render()
      return
    }
    playItem(item)
  }

  /** 立刻停声：掐掉当前音源、清空队列、把状态复位。 */
  function stopPlayback() {
    try {
      currentSource?.stop()
    } catch { /* 已经停了 */ }
    currentSource = null
    playing = false
    pending.length = 0
  }

  async function playItem(item) {
    playing = true
    render()
    try {
      unlock()
      if (!audioCtx) throw new Error('浏览器不支持 Web Audio')
      if (audioCtx.state === 'suspended') await audioCtx.resume()

      const response = await fetch(item.url, { cache: 'no-store' })
      if (!response.ok) throw new Error(`取音频失败 HTTP ${response.status}`)
      const raw = await response.arrayBuffer()
      const buffer = await audioCtx.decodeAudioData(raw.slice(0))

      const source = audioCtx.createBufferSource()
      source.buffer = buffer
      const gain = audioCtx.createGain()
      gain.gain.value = state.volume
      source.connect(gain)
      gain.connect(audioCtx.destination)
      source.onended = () => {
        playing = false
        currentSource = null
        next()
      }
      currentSource = source
      source.start()
      state.lastError = ''
      state.lastPlayNote = `播放 ${buffer.duration.toFixed(1)}s`
      render()
    } catch (error) {
      playing = false
      state.lastError = `播放失败：${error.message}`
      state.lastPlayNote = '播放失败'
      render()
      // 这一段放不出来就跳过，别堵住后面的。
      setTimeout(next, 300)
    }
  }

  // ── 轮询 ──────────────────────────────────────────────────────────────────
  async function getConfig() {
    const res = await fetch(`${ROUTE}/config`, { cache: 'no-store' })
    if (!res.ok) throw new Error(String(res.status))
    return res.json()
  }

  async function getStatus() {
    const res = await fetch(`${ROUTE}/status`, { cache: 'no-store' })
    if (!res.ok) throw new Error(String(res.status))
    return res.json()
  }

  async function pollQueue() {
    if (nextCursor === null) {
      const res = await fetch(`${ROUTE}/next`, { cache: 'no-store' })
      const data = await res.json()
      nextCursor = data.cursor ?? 0
      return
    }
    const since = nextCursor
    const res = await fetch(`${ROUTE}/next?since=${since}`, { cache: 'no-store' })
    const data = await res.json()
    nextCursor = data.cursor ?? since
    const got = data.items ?? []
    for (const item of got) pending.push(item)
    if (got.length > 0) state.lastPlayNote = `收到 ${got.length} 段`
    else state.lastPlayNote = `空 sp=${since} 回=${data.cursor} n=${got.length}`
    if (pending.length > 0) next()
  }

  let online = true
  let pollCount = 0
  let pollNote = ''
  async function tick() {
    if (stopped) return
    pollCount += 1
    const started = Date.now()
    try {
      // 递归 setTimeout 的致命问题：一次 fetch 挂住，整个轮询就永远停了。
      // 所以每一步都加超时，宁可报错也不许卡死。
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000))
      const [status, conf] = await Promise.race([Promise.all([getStatus(), getConfig()]), timeout])
      Object.assign(state, status, {
        enabled: conf.enabled,
        volume: conf.volume,
        speed: conf.speed,
        temperature: conf.temperature,
        fragmentInterval: conf.fragmentInterval,
      })
      online = true
      pollNote = `#${pollCount} ${Date.now() - started}ms`
      if (conf.enabled) await Promise.race([pollQueue(), timeout])
    } catch (error) {
      online = false
      pollNote = `#${pollCount} 失败:${error.message}`
    }
    render()
    setTimeout(tick, POLL_MS)
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────────
  function render() {
    const on = state.enabled
    const busy = playing || state.speaking > 0
    btn.className = `btn ${on ? 'on' : 'off'}${online ? '' : ' dead'}`
    // 摆动交给外层 .wrap：绳子和按钮要作为一个整体绕绳子顶端摆，否则接缝会裂开。
    wrap.classList.toggle('busy', busy)
    // 延伸绳是独立元素，不在 .btn 的滤镜范围里，状态得单独同步。
    rope.classList.toggle('dim', !on)
    btn.title = !online
      ? '达妮娅语音：插件未响应'
      : on
        ? '达妮娅语音：开（点击关闭）'
        : '达妮娅语音：关（点击开启）'

    const q = (name) => panel.querySelector(`[data-f="${name}"]`)
    q('enabled').textContent = !online ? '插件未响应' : on ? '已开启' : '已关闭'
    q('enabled').className = `v ${!online ? 'bad' : on ? 'ok' : ''}`
    q('server').textContent = state.serverReady ? '已就绪' : (state.speaking > 0 ? '合成中…' : '未启动')
    q('server').className = `v ${state.serverReady ? 'ok' : 'bad'}`
    q('vol').textContent = `${Math.round(state.volume * 100)}%`
    q('spd').textContent = `${state.speed.toFixed(2)}×`
    q('tmp').textContent = state.temperature.toFixed(2)
    q('fint').textContent = `${state.fragmentInterval.toFixed(2)}s`
    for (const [key, field] of [
      ['volrange', 'volume'],
      ['spdrange', 'speed'],
      ['tmprange', 'temperature'],
      ['fintrange', 'fragmentInterval'],
    ]) {
      const el = q(key)
      // 正在拖动的滑块不要被轮询覆盖，否则手感会跳。
      if (el && document.activeElement !== el) el.value = String(state[field])
    }

    q('hint').textContent = !online
      ? '插件路由没有响应，检查插件是否启用。'
      : !state.installed
        ? ''
        : !state.serverReady
          ? '第一次朗读会先拉起本地 GPT-SoVITS（约 20~40 秒），之后每句只要 1~3 秒。'
          : '回复写完后会自动朗读。点这里可以试听。'
    q('err').textContent = state.lastError || ''

    // 没装好时只露出部署面板，参数滑块先藏起来，避免一堆点了没反应的控件。
    q('setup').style.display = state.installed ? 'none' : 'block'
    q('tuning').style.display = state.installed ? 'block' : 'none'
    if (!state.installed) {
      const log = q('log')
      log.textContent = state.logTail || ''
      log.scrollTop = log.scrollHeight
      const installBtn = q('install')
      installBtn.textContent = state.installing ? '安装中…（首次约 10~30 分钟）' : '一键部署'
      installBtn.disabled = state.installing
    }
  }

  // ── 交互 ──────────────────────────────────────────────────────────────────
  btn.addEventListener('click', async (event) => {
    // 刚拖过位置：这次 click 是拖动的尾巴，不当作开关操作。
    if (suppressClick) {
      suppressClick = false
      return
    }
    if (event.shiftKey) {
      placePanel()
      panel.classList.toggle('open')
      return
    }
    unlock()
    state.enabled = !state.enabled
    if (!state.enabled) {
      // 关掉要**立刻**闭嘴：掐掉正在播的那一段，清空待播队列，
      // 再把游标对齐到 host 的最新位置——否则关闭期间合成好的段落
      // 会在下次打开时一口气全部补播出来。
      stopPlayback()
      fetch(`${ROUTE}/next`, { cache: 'no-store' })
        .then((res) => res.json())
        .then((data) => {
          if (Number.isFinite(data.cursor)) nextCursor = data.cursor
        })
        .catch(() => { /* 拿不到就等下次轮询对齐 */ })
    }
    render()
    try {
      const res = await fetch(`${ROUTE}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: state.enabled }),
      })
      if (!res.ok) {
        // 存不下就直说：否则下一轮轮询会把开关刷回旧值，看起来像"自己弹回去了"。
        state.lastError = '开关状态没存下来：检查 $DSH_HOME 的写入权限'
      } else {
        state.lastError = ''
      }
    } catch { /* 下次轮询会纠正 */ }
    render()
  })

  btn.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    unlock()
    placePanel()
    panel.classList.toggle('open')
  })

  panel.addEventListener('click', async (event) => {
    const target = event.target
    if (target && target.getAttribute && target.getAttribute('data-f') === 'repeat') {
      unlock()
      try {
        const res = await fetch(`${ROUTE}/repeat`, { method: 'POST' })
        const data = await res.json()
        if (data.ok !== true) {
          throw new Error(data.error === 'nothing-to-repeat' ? '还没有可重读的内容' : '请求失败')
        }
        state.lastError = ''
      } catch (error) {
        state.lastError = `重读失败：${error.message}`
      }
      render()
      return
    }
    if (target && target.getAttribute && target.getAttribute('data-f') === 'reload') {
      try {
        window.__DSH_DANIA_VOICE_STOP__?.()
        delete window.__DSH_DANIA_VOICE__
        for (const old of document.querySelectorAll('script[data-dania-voice]')) old.remove()
        const script = document.createElement('script')
        script.src = `${ROUTE}/client.js?r=${Date.now()}`
        script.setAttribute('data-dania-voice', '1')
        document.body.appendChild(script)
      } catch (error) {
        state.lastError = `重载失败：${error.message}`
        render()
      }
      return
    }
    if (target && target.getAttribute && target.getAttribute('data-f') === 'beep') {
      unlock()
      try {
        if (!audioCtx) throw new Error('没有 AudioContext')
        const osc = audioCtx.createOscillator()
        const gain = audioCtx.createGain()
        gain.gain.value = Math.max(0.2, state.volume * 0.5)
        osc.frequency.value = 880
        osc.connect(gain)
        gain.connect(audioCtx.destination)
        osc.start()
        osc.stop(audioCtx.currentTime + 0.4)
        state.lastError = `已发测试音（ctx=${audioCtx.state} ${audioCtx.sampleRate}Hz）`
      } catch (error) {
        state.lastError = `测试音失败：${error.message}`
      }
      render()
      return
    }
    if (target && target.getAttribute && target.getAttribute('data-f') === 'install') {
      state.lastError = ''
      try {
        const res = await fetch(`${ROUTE}/setup`, { method: 'POST' })
        const data = await res.json()
        if (data.ok !== true) throw new Error(data.error || '启动失败')
        state.installing = true
      } catch (error) {
        state.lastError = `部署启动失败：${error.message}`
      }
      render()
      return
    }
    if (target && target.getAttribute && target.getAttribute('data-f') === 'test') {
      // 这个点击同时承担「解锁音频」的作用，必须在手势里同步调用。
      unlock()
      state.lastError = ''
      render()
      try {
        const res = await fetch(`${ROUTE}/say`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: '喂，听得见吗？我是达妮娅。有话就说，别在那儿磨磨蹭蹭的。' }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      } catch (error) {
        state.lastError = `试听请求失败：${error.message}`
        render()
      }
    }
  })

  panel.addEventListener('input', (event) => {
    const target = event.target
    const key = target && target.getAttribute && target.getAttribute('data-f')
    const map = {
      volrange: 'volume',
      spdrange: 'speed',
      tmprange: 'temperature',
      fintrange: 'fragmentInterval',
    }
    const field = map[key]
    if (!field) return
    state[field] = Number(target.value)
    render()
    fetch(`${ROUTE}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [field]: state[field] }),
    }).catch(() => {})
  })

  render()
  setTimeout(tick, 800)
})()
