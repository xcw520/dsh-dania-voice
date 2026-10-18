#!/usr/bin/env node
/**
 * dsh-dania-voice — 一键部署脚本。
 *
 * 目标：从零把 GPT-SoVITS + 达妮娅模型装到 `DANIA_INSTALL_DIR`，装完插件直接能用。
 * 它是**独立子进程**，由插件用 `ELECTRON_RUN_AS_NODE=1` 拉起，进度写到 `DANIA_LOG`。
 *
 * 步骤：
 *   1. 找 Python 3.10~3.12
 *   2. 建 venv
 *   3. 装 torch（有 NVIDIA 卡就装 cu128）与推理依赖
 *   4. 下 GPT-SoVITS 源码
 *   5. 下预训练底模（s1v3 / s2Gv2ProPlus / roberta / hubert / sv）
 *   6. 下达妮娅模型与参考音频
 *   7. 写 tts_infer.yaml 与运行时补丁
 *
 * 每一步都可重入：失败后重跑会跳过已完成的部分。
 */

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, cpSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'

const INSTALL_DIR = process.env.DANIA_INSTALL_DIR || join(homedir(), '.dsh', 'dania-voice')
const LOG = process.env.DANIA_LOG || join(INSTALL_DIR, 'install.log')
const PYPI = process.env.DANIA_PYPI || 'https://mirrors.aliyun.com/pypi/simple/'
const HF = process.env.DANIA_HF || 'https://hf-mirror.com'

const ROOT = join(INSTALL_DIR, 'gpt-sovits')
const VENV = join(INSTALL_DIR, 'venv')
const MODELS = join(ROOT, 'GPT_SoVITS', 'pretrained_models')
const DOWNLOADS = join(INSTALL_DIR, 'downloads')

const GSV_ZIP = 'https://codeload.github.com/RVC-Boss/GPT-SoVITS/zip/refs/heads/main'
const HF_REPO = `${HF}/lj1995/GPT-SoVITS/resolve/main`
const MS_REPO = 'https://www.modelscope.cn/models/villia/dania/resolve/master'

/** 预训练底模：v2ProPlus 推理需要这五个。 */
const PRETRAINED = [
  { url: `${HF_REPO}/s1v3.ckpt`, to: 's1v3.ckpt', min: 100 * 1024 * 1024 },
  { url: `${HF_REPO}/v2Pro/s2Gv2ProPlus.pth`, to: 'v2Pro/s2Gv2ProPlus.pth', min: 150 * 1024 * 1024 },
  { url: `${HF_REPO}/chinese-roberta-wwm-ext-large/pytorch_model.bin`, to: 'chinese-roberta-wwm-ext-large/pytorch_model.bin', min: 500 * 1024 * 1024 },
  { url: `${HF_REPO}/chinese-roberta-wwm-ext-large/config.json`, to: 'chinese-roberta-wwm-ext-large/config.json' },
  { url: `${HF_REPO}/chinese-roberta-wwm-ext-large/tokenizer.json`, to: 'chinese-roberta-wwm-ext-large/tokenizer.json' },
  { url: `${HF_REPO}/chinese-hubert-base/pytorch_model.bin`, to: 'chinese-hubert-base/pytorch_model.bin', min: 100 * 1024 * 1024 },
  { url: `${HF_REPO}/chinese-hubert-base/config.json`, to: 'chinese-hubert-base/config.json' },
  { url: `${HF_REPO}/chinese-hubert-base/preprocessor_config.json`, to: 'chinese-hubert-base/preprocessor_config.json' },
  { url: `${HF_REPO}/sv/pretrained_eres2netv2w24s4ep4.ckpt`, to: 'sv/pretrained_eres2netv2w24s4ep4.ckpt', min: 90 * 1024 * 1024 },
]

/** 达妮娅的音色模型与参考音频。 */
const DANIA = [
  { url: `${MS_REPO}/dania-e15.ckpt`, to: join('GPT_SoVITS', 'dania-e15.ckpt'), min: 100 * 1024 * 1024 },
  { url: `${MS_REPO}/dania_e16_s2192.pth`, to: join('GPT_SoVITS', 'dania_e16_s2192.pth'), min: 100 * 1024 * 1024 },
  { url: `${MS_REPO}/output.wav_0009342720_0009558400.wav`, to: join('output', 'slicer_opt', 'output.wav_0009342720_0009558400.wav'), min: 100 * 1024 },
]

const PIP_DEPS = [
  'numpy<2.0', 'scipy', 'librosa==0.10.2', 'transformers==4.51.3', 'sentencepiece', 'peft<0.18.0',
  'cn2an', 'pypinyin', 'g2p_en', 'modelscope', 'chardet', 'PyYAML', 'psutil', 'jieba', 'split-lang',
  'fast_langdetect', 'wordsegment', 'rotary_embedding_torch', 'ToJyutping', 'ko_pron', 'opencc',
  'fastapi', 'uvicorn', 'pydantic<=2.10.6', 'ctranslate2', 'av', 'tqdm', 'onnxruntime',
  'matplotlib', 'ffmpeg-python', 'pytorch-lightning', 'torchmetrics', 'lightning-utilities',
  'x_transformers', 'resampy', 'python-multipart',
]

// ── 日志 ────────────────────────────────────────────────────────────────────
function say(message) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${message}`
  process.stdout.write(`${line}\n`)
  try {
    appendFileSync(LOG, `${line}\n`)
  } catch { /* 日志写不了也要继续装 */ }
}

const step = (n, total, text) => say(`(${n}/${total}) ${text}`)

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    ...options,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.status !== 0) {
    const detail = (result.stderr || '').trim().split('\n').slice(-6).join('\n')
    throw new Error(`${command} ${args.join(' ')} 失败（code=${result.status}）\n${detail}`)
  }
  return result.stdout ?? ''
}

// ── 下载 ────────────────────────────────────────────────────────────────────
/**
 * 下载到文件，已存在且大小达标的直接跳过（可重入）。
 * @param {string} url - 下载地址。
 * @param {string} target - 目标文件。
 * @param {number} [minBytes] - 低于这个大小视为没下完整。
 */
function download(url, target, minBytes = 1024) {
  if (existsSync(target) && statSync(target).size >= minBytes) {
    say(`  已存在，跳过：${target}`)
    return
  }
  mkdirSync(join(target, '..'), { recursive: true })
  say(`  下载 ${url}`)
  const tmp = `${target}.part`
  const client = url.startsWith('https') ? httpsGet : httpGet
  const file = createWriteStream(tmp)
  return new Promise((resolve, reject) => {
    const request = client(url, { headers: { 'User-Agent': 'dsh-dania-voice-installer' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close()
        rmSync(tmp, { force: true })
        download(response.headers.location, target, minBytes).then(resolve, reject)
        return
      }
      if (response.statusCode !== 200) {
        file.close()
        rmSync(tmp, { force: true })
        reject(new Error(`HTTP ${response.statusCode}：${url}`))
        return
      }
      response.pipe(file)
      file.on('finish', () => {
        file.close()
        const size = statSync(tmp).size
        if (size < minBytes) {
          rmSync(tmp, { force: true })
          reject(new Error(`文件不完整（${size} < ${minBytes}）：${url}`))
          return
        }
        rmSync(target, { force: true })
        cpSync(tmp, target)
        rmSync(tmp, { force: true })
        say(`  完成 ${(size / 1024 / 1024).toFixed(1)} MB`)
        resolve()
      })
    })
    request.on('error', (error) => {
      file.close()
      rmSync(tmp, { force: true })
      reject(error)
    })
    request.setTimeout(120000, () => {
      request.destroy(new Error('下载超时'))
    })
  })
}

/** 解压 zip（Windows 用 PowerShell，其他平台用 unzip）。 */
function unzip(file, target) {
  mkdirSync(target, { recursive: true })
  if (process.platform === 'win32') {
    run('powershell.exe', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${file}' -DestinationPath '${target}' -Force`])
  } else {
    run('unzip', ['-qo', file, '-d', target])
  }
}

// ── Python ──────────────────────────────────────────────────────────────────
/** 找一个可用的 python（3.10+），返回可执行文件路径。 */
function findPython() {
  if (process.env.DANIA_PYTHON && existsSync(process.env.DANIA_PYTHON)) return process.env.DANIA_PYTHON
  const candidates = process.platform === 'win32'
    ? [['python', []], ['py', ['-3.12']], ['py', ['-3.11']], ['py', ['-3.10']]]
    : [['python3', []], ['python', []]]
  for (const [command, prefix] of candidates) {
    const probe = spawnSync(command, [...prefix, '-c', 'import sys;print(sys.version_info[0],sys.version_info[1])'], {
      encoding: 'utf8',
    })
    if (probe.status !== 0) continue
    const [major, minor] = String(probe.stdout).trim().split(/\s+/).map(Number)
    if (major === 3 && minor >= 10 && minor <= 12) {
      say(`  Python ${major}.${minor}：${command} ${prefix.join(' ')}`)
      return [command, prefix]
    }
  }
  return null
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const TOTAL = 7

async function main() {
  say('=== 达妮娅语音插件 · 一键部署 ===')
  say(`安装目录：${INSTALL_DIR}`)
  mkdirSync(INSTALL_DIR, { recursive: true })
  mkdirSync(DOWNLOADS, { recursive: true })

  // 1. Python
  step(1, TOTAL, '检查 Python（需要 3.10~3.12）')
  const python = findPython()
  if (python === null) {
    throw new Error('没找到 Python 3.10~3.12。请先安装（winget install Python.Python.3.12），或设 DANIA_PYTHON 指向解释器。')
  }

  // 2. venv
  step(2, TOTAL, '创建虚拟环境')
  const venvPython = process.platform === 'win32'
    ? join(VENV, 'Scripts', 'python.exe')
    : join(VENV, 'bin', 'python')
  if (!existsSync(venvPython)) {
    run(python[0], [...python[1], '-m', 'venv', VENV])
  } else {
    say('  已存在，跳过')
  }

  // 3. 依赖
  step(3, TOTAL, '安装 PyTorch（有 NVIDIA 显卡则装 CUDA 版，约 2.6 GB）')
  const hasNvidia = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf8' }).status === 0
  const torchInstalled = spawnSync(venvPython, ['-c', 'import torch'], { encoding: 'utf8' }).status === 0
  if (torchInstalled) {
    say('  torch 已安装，跳过')
  } else if (hasNvidia) {
    say('  检测到 NVIDIA 显卡，安装 cu128 版')
    run(venvPython, ['-m', 'pip', 'install', '--no-cache-dir',
      'torch', 'torchaudio', '--index-url', 'https://download.pytorch.org/whl/cu128'])
  } else {
    say('  未检测到 NVIDIA 显卡，安装 CPU 版（合成会明显变慢）')
    run(venvPython, ['-m', 'pip', 'install', '--no-cache-dir', 'torch', 'torchaudio',
      '-i', PYPI, '--trusted-host', new URL(PYPI).host])
  }

  say('安装其余推理依赖…')
  run(venvPython, ['-m', 'pip', 'install', '--no-cache-dir',
    '--extra-index-url', PYPI, '--trusted-host', new URL(PYPI).host, ...PIP_DEPS])

  // 4. 源码
  step(4, TOTAL, '下载 GPT-SoVITS 源码')
  if (existsSync(join(ROOT, 'api_v2.py'))) {
    say('  已存在，跳过')
  } else {
    const zip = join(DOWNLOADS, 'gpt-sovits.zip')
    await download(GSV_ZIP, zip, 1024 * 1024)
    const staging = join(DOWNLOADS, 'gsv')
    rmSync(staging, { recursive: true, force: true })
    unzip(zip, staging)
    const inner = join(staging, 'GPT-SoVITS-main')
    if (!existsSync(inner)) throw new Error('源码包结构异常，找不到 GPT-SoVITS-main')
    cpSync(inner, ROOT, { recursive: true })
    say('  源码就位')
  }

  // 5. 预训练底模
  step(5, TOTAL, '下载预训练底模（约 1.6 GB，可反复重跑续装）')
  for (const item of PRETRAINED) {
    await download(item.url, join(MODELS, item.to), item.min)
  }

  // 6. 达妮娅模型
  step(6, TOTAL, '下载达妮娅音色模型（约 320 MB）')
  for (const item of DANIA) {
    await download(item.url, join(ROOT, item.to), item.min)
  }

  // 7. 配置与补丁
  step(7, TOTAL, '写入推理配置与运行时补丁')
  const configDir = join(ROOT, 'GPT_SoVITS', 'configs')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'tts_infer.yaml'), `custom:
  bert_base_path: GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large
  cnhuhbert_base_path: GPT_SoVITS/pretrained_models/chinese-hubert-base
  device: ${hasNvidia ? 'cuda' : 'cpu'}
  is_half: ${hasNvidia ? 'true' : 'false'}
  t2s_weights_path: GPT_SoVITS/dania-e15.ckpt
  version: v2ProPlus
  vits_weights_path: GPT_SoVITS/dania_e16_s2192.pth
`, 'utf8')

  // jieba_fast 在 py3.12 上要编译，这里用转发层顶上。
  const shimDir = join(VENV, process.platform === 'win32' ? 'Lib/site-packages' : 'lib/python3.12/site-packages', 'jieba_fast')
  mkdirSync(shimDir, { recursive: true })
  writeFileSync(join(shimDir, '__init__.py'),
    'import jieba as _jieba\nfrom jieba import *\nfrom jieba import setLogLevel, lcut, cut, cut_for_search, load_userdict, tokenize\n__version__ = "0.0.0-jieba-shim"\n', 'utf8')
  writeFileSync(join(shimDir, 'posseg.py'),
    'from jieba import load_userdict\nfrom jieba.posseg import *\nfrom jieba.posseg import POSTokenizer, cut, dt, lcut\n', 'utf8')

  // torchaudio 2.9+ 的解码迁到了 torchcodec（需要 FFmpeg 共享库），这里让
  // 参考音频走 soundfile，绕开这个依赖。
  patchAudioLoader()

  say('=== 部署完成 ===')
  say('插件会自动拉起服务；首次合成要等模型加载 20~40 秒。')
}

/**
 * 给 GPT-SoVITS 打一个本地补丁：把 `torchaudio.load` 换成 soundfile。
 *
 * 纯文本替换，找不到锚点就跳过并提示——升级源码后补丁可能失效，但不该让安装失败。
 */
function patchAudioLoader() {
  const file = join(ROOT, 'GPT_SoVITS', 'TTS_infer_pack', 'TTS.py')
  if (!existsSync(file)) {
    say('  跳过音频加载补丁：找不到 TTS.py')
    return
  }
  let source = readFileSync(file, 'utf8')
  if (source.includes('def _load_audio(path)')) {
    say('  音频加载补丁已存在，跳过')
    return
  }
  const anchor = 'def load_audio_gpu(path, target_sr'
  const injection = `def _load_audio(path):
    """读音频：torchaudio 2.9+ 需要 torchcodec（依赖 FFmpeg 共享库），这里用 soundfile 顶上。"""
    try:
        import soundfile as sf

        data, sr = sf.read(str(path), always_2d=True, dtype="float32")
        return torch.from_numpy(data.T.copy()), int(sr)
    except Exception:
        audio, sr = torchaudio.load(path)
        return audio, int(sr)


${anchor}`
  if (!source.includes(anchor)) {
    say('  跳过音频加载补丁：锚点未找到（上游可能改过）')
    return
  }
  source = source.replace(anchor, injection)
  source = source.replace('audio, source_sr = torchaudio.load(path)', 'audio, source_sr = _load_audio(path)')
  source = source.replace('raw_audio, raw_sr = torchaudio.load(ref_audio_path)', 'raw_audio, raw_sr = _load_audio(ref_audio_path)')
  writeFileSync(file, source, 'utf8')
  say('  音频加载补丁已应用')
}

main().catch((error) => {
  say(`部署失败：${error?.message ?? error}`)
  process.exitCode = 1
})
