# dsh-dania-voice

[English](README.md) | **简体中文**

给 DeepSeek Harness 用的**本地 GPT-SoVITS** 语音朗读插件：把助手的回复用达妮娅的音色念出来，
旁边挂着一个可拖动的小挂件控制开关。

全部在本机运行，文字和音频都不出本地。

## 工作原理

```
DSH 会话事件（assistant/message + turn/end）
      │  取最终回复正文，剔除代码块 / 表格 / 链接
      ▼
Host：清洗 + 按 120 字聚合分段
      │  POST http://127.0.0.1:9880/tts
      ▼
GPT-SoVITS api_v2.py（本地，GPU）
      │  wav → 缓存目录 → 队列
      ▼
浏览器：轮询 /dania-voice/next → Web Audio 播放
```

播放放在浏览器里是刻意的：Host 进程没有声卡，而且声音应该出现在**你正坐着的那台机器**上。

## 环境要求

| 项目 | 说明 |
|---|---|
| DSH | `>= 0.1.7-rc.1` |
| Python | **3.10 – 3.12**（安装器只负责找，不负责装） |
| 显卡 | 建议 NVIDIA、8 GB 以上显存；用 CPU 也能跑，但慢好几倍 |
| 磁盘 | 约 5 GB（PyTorch + 底模 + 音色模型） |
| ffmpeg | 多数情况下用不到，装了更保险 |

## 安装

```sh
dsh plugin --profile web add dsh-dania-voice
```

然后打开挂件面板，点 **「一键部署」**。安装器是独立进程，进度会实时显示在同一个面板里：

1. 在安装目录下建 Python 虚拟环境
2. 装 PyTorch（检测到 `nvidia-smi` 就装 CUDA 版）
3. 装推理依赖
4. 下载 GPT-SoVITS 源码（约 50 MB）
5. 下载预训练底模（约 1.6 GB）
6. 下载音色模型与参考音频（约 320 MB）

**可以反复重跑**：中途失败再点一次，已完成的步骤会自动跳过。第 5 步是 1.6 GB 的下载，这个特性很重要。

默认装在 `$DSH_HOME/dania-voice`。想放别的盘，改配置里的 `installDir`。

## 使用

窗口顶部正中挂着一只达妮娅：

- **单击** —— 开关朗读
- **拖动** —— 挪到任意位置，位置会记住
- **右键 / Shift+单击** —— 打开设置面板
- 正在念的时候会轻轻晃动

面板里可以调音量、语速、温度（越低越稳、气音越少）、句间停顿，还有「重读上一段」和「让她说一句」用于试听。

语速/温度改完对下一条生效；音频按「文本 + 参数」缓存，参数不变时重读是秒回的。

## 配置

面板写入 `$DSH_HOME/dania-voice/config.json`。profile patch 里的 `config:` 段也可以写，会被面板覆盖。

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 朗读总开关 |
| `volume` / `speed` / `temperature` | `1` / `1` / `0.7` | 播放与采样参数 |
| `speakUser` | `false` | 是否也念你自己发的消息 |
| `installDir` | `$DSH_HOME/dania-voice` | 引擎安装目录 |
| `pythonPath` / `root` / `cacheDir` | 自动派生 | 只有手动部署过才需要填 |
| `baseUrl` | `http://127.0.0.1:9880` | GPT-SoVITS 地址 |
| `autostart` | `true` | 需要时自动拉起服务 |

## 故障排查

- **挂件是红边** —— 插件路由没响应，检查插件是否启用。
- **提示「还没部署」** —— 点一键部署，或看 `$DSH_HOME/dania-voice/install.log`。
- **面板显示已就绪但没声音** —— 浏览器拦了自动播放，点一下挂件即可。
- **第一句很慢** —— 模型要 20~40 秒加载进显存，之后每句 1~3 秒。

## 版权

- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)（RVC-Boss）—— MIT。
- 达妮娅音色模型来自 ModelScope 上的 [villia/dania](https://www.modelscope.cn/models/villia/dania)，
  安装器从原仓库下载，**本仓库不再分发**。
- 挂件立绘 © 夜游人（本项目作者）；面板背景使用官方宣传素材，按官方第三方使用规范使用。

本项目是同人作品。《鸣潮》及其角色版权归库洛游戏所有。
