# dsh-dania-voice

**English** | [简体中文](README.zh.md)

Local **GPT-SoVITS** text-to-speech for DeepSeek Harness. It reads assistant replies aloud in a
fine-tuned voice, controlled by a small draggable mascot hanging at the top of the interface.

Everything runs on your machine — no audio, no text leaves it.

## How it works

```
DSH session events (assistant/message + turn/end)
      │  take the reply text: inline code → speakable English,
      │  code blocks → one short cue, tables and links stripped
      ▼
Host: clean + merge into ≤120-char segments
      │  POST http://127.0.0.1:9880/tts
      ▼
GPT-SoVITS api_v2.py (local, GPU)
      │  wav → cache dir → queue
      ▼
Browser: poll /dania-voice/next → Web Audio playback
```

Playback happens in the browser on purpose: the Host process has no audio device, and the voice
should come out of **the machine you are actually sitting at**.

When cleaning, inline code is not dropped — `ops_bash` is spoken as `ops bash`, and long
all-caps words are lowercased so the model reads them as words instead of spelling out
`E X E C U T O R`. Code blocks become a single spoken cue ("there's a code block here")
instead of being read line by line.

## Requirements

| Item | Note |
|---|---|
| DSH | `>= 0.1.7-rc.1` |
| Python | **3.10 – 3.12** (the installer looks for it; it does not install Python) |
| GPU | NVIDIA with 8 GB+ VRAM recommended. CPU works but is several times slower. |
| Disk | ~5 GB (PyTorch + base models + voice model) |

## Install

```sh
dsh plugin --profile web add dsh-dania-voice
```

Then open the mascot panel and click **One-click setup**. The installer runs as a separate
process and reports progress into the same panel:

1. creates a Python venv under the install directory
2. installs PyTorch (CUDA build when `nvidia-smi` is present)
3. installs the inference dependencies
4. downloads GPT-SoVITS source (~50 MB)
5. downloads the pretrained base models (~1.6 GB)
6. downloads the voice model and its reference audio (~320 MB)

It is idempotent — if it fails halfway, click again and completed steps are skipped. That matters
because step 5 is a 1.6 GB download.

The default install directory is `$DSH_HOME/dania-voice`. Override it with `installDir` if you
want it on another drive.

## Usage

A mascot hangs at the top centre of the window:

- **Click** — toggle reading on/off
- **Drag** — move it anywhere; the position is remembered
- **Right-click / Shift+click** — open the settings panel
- While reading, the mascot gently bobs

Panel controls: volume, speed, temperature (lower = steadier, less breathiness), inter-sentence
pause, plus **repeat last reply** and **say a line** for testing.

Changing speed/temperature applies to the next synthesis; audio is cached by `text + parameters`,
so repeating with the same settings is instant.

## Configuration

Written to `$DSH_HOME/dania-voice/config.json` by the panel. The `config:` block in your profile
patch works too and is overridden by the panel.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `volume` / `speed` / `temperature` | `1` / `1` / `0.7` | Playback and sampling |
| `speakUser` | `false` | Also read your own messages |
| `installDir` | `$DSH_HOME/dania-voice` | Where the engine lives |
| `pythonPath` / `root` / `cacheDir` | derived | Only needed for a hand-made install |
| `baseUrl` | `http://127.0.0.1:9880` | GPT-SoVITS endpoint |
| `autostart` | `true` | Start the service when needed |

## Troubleshooting

- **Mascot shows a red border** — the plugin's routes are not answering; check that the plugin is enabled.
- **"Not installed yet"** — click one-click setup, or check `$DSH_HOME/dania-voice/install.log`.
- **No sound but the panel says ready** — the browser blocked autoplay; click the mascot once.
- **Slow first line** — the model takes 20–40 s to load into VRAM; later lines take 1–3 s.

## Credits

- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) by RVC-Boss — MIT.
- Dania voice model by [villia](https://www.modelscope.cn/models/villia/dania) on ModelScope.
  The installer downloads it from the original repository; it is **not** redistributed here.
- Mascot artwork © 夜游人 (this project's author). Background art uses official promotional
  material under the publisher's third-party usage policy.

This is a fan project. Wuthering Waves and its characters belong to Kuro Games.
