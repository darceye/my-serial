<div align="center">

# MySerial

**A modern Windows serial debugging tool built for developers.**
ANSI color · UTF-8 CJK · Auto-reconnect · Multi-tab · Hex & dual-pane viewer

[![Made with Tauri 2](https://img.shields.io/badge/Tauri-2-blue?logo=tauri&logoColor=white)](https://v2.tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-stable-dea584?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![Svelte 5](https://img.shields.io/badge/Svelte-5-ff3e00?logo=svelte&logoColor=white)](https://svelte.dev/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%2B-0078D4?logo=windows&logoColor=white)](#)
[![Release](https://img.shields.io/badge/Release-v0.1.0-orange.svg)](../../releases)

</div>

---

## 📖 Table of Contents | 目录

**English** · [中文](#-中文文档)

- [Overview](#-overview)
- [Why MySerial?](#-why-myserial-vs-hterm)
- [Features](#-features)
- [Screenshots](#-screenshots)
- [Download & Install](#-download--install)
- [Build from Source](#-build-from-source)
- [Tech Stack](#-tech-stack)
- [Project Structure](#-project-structure)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🇬🇧 English Documentation

### 🎯 Overview

**MySerial** is a modern, native Windows serial terminal for embedded developers, IoT engineers, and hardware hackers. It is designed as a spiritual successor to the venerable [HTerm](https://www.der-hammer.info/pages/terminal.html), keeping everything HTerm got right while fixing its three biggest pain points:

1. **ANSI color rendering** — proper SGR sequence parsing, not black & white.
2. **UTF-8 / CJK support** — no more broken Chinese characters across read boundaries.
3. **Automatic reconnection** — survive USB unplug, sleep/wake, and device reset.

Built with **Tauri 2 + Rust + Svelte 5**, it ships as a tiny (~5 MB installer) native executable — not an Electron hog.

### 💡 Why MySerial? (vs HTerm)

| Capability | HTerm | MySerial |
|---|:---:|:---:|
| ANSI color codes | ❌ | ✅ |
| UTF-8 / Chinese text | ❌ (garbled) | ✅ |
| Auto-reconnect on disconnect | ❌ | ✅ |
| Modern, themable UI | ❌ (Win95-era) | ✅ Dark/Light |
| Multi-tab sessions | ❌ | ✅ |
| Hex + ASCII dual-pane view | partial | ✅ (CJK-aligned) |
| Byte-level hover tooltip | ❌ | ✅ |
| MSI / NSIS installer | ❌ | ✅ |
| File size | ~2 MB | ~5 MB installer |

### ✨ Features

#### 🔌 Serial Connection
- **Full parameter coverage**: baud rate (with presets incl. ESP8266's 74880), data bits 5–8, parity None/Even/Odd/Mark/Space, stop bits 1/2, flow control None/Software/Hardware.
- **Hot-plug detection**: 500 ms port watcher refreshes the port list live as USB devices are inserted/removed.
- **Rich port metadata**: COM name, USB product/manufacturer strings, VID:PID, serial number.

#### 🔄 Auto-Reconnect
- Robust state machine: `Disconnected → Connecting → Connected → Reconnecting → Lost`.
- Triggered by read errors (not port-list polling) — survives sleep, unplug, and reset.
- Configurable interval & max attempts; status badge on each tab shows live state.

#### 📤 Sending
- **ASCII / Hex dual mode** with lossless bidirectional conversion when toggling.
- **Smart hex parsing**: tolerates `0x` prefixes, commas, missing spaces, paste artifacts.
- **Suffix options**: None / CR / LF / Space / ETX / NUL / **custom** (with `\r\n\t\0\xNN` escapes or raw hex).
- **Loop / periodic send**: interval from 50 ms, auto-stops on disconnect.
- **Send history**: last 100 entries, deduplicated, click to restore text + mode.

#### 📥 Display & Rendering
- **Custom-built viewer** (not xterm.js) using `ansi_up` + virtualized scrolling — handles high-throughput streams smoothly.
- **Three view modes**: ASCII / Hex / **ASCII+Hex dual-pane** with CJK characters aligned across both columns (a feature xterm cannot do).
- **ANSI color**: SGR sequence parsing with on/off toggle.
- **UTF-8 boundary safety**: Rust backend buffers partial multibyte sequences across reads, so you never see half a character.
- **Timestamps**: off / absolute `HH:mm:ss.fff` / relative `+0.123s`.
- **Flexible line splitting**: split on NUL/LF/CR/CRLF/ETX, custom byte sequences (matched across chunk boundaries), fixed N-byte rows, or idle-gap detection.
- **Byte-level tooltip**: hover any byte to see receive time, direction, offset (dec+hex), raw byte, and decoded value.
- **Control picture glyphs**: render non-printables as `␀␊␍␃␡` when enabled.
- **Pause / autoscroll / clear** (`Ctrl+L`).

#### 🗂 Multi-Tab
- Connect to **multiple serial ports simultaneously**, each in its own tab with an independent backend session.
- All tabs stay mounted (just hidden) — switching is instant and loses no history.
- Tab label shows the live COM port when connected.

#### 💾 Logging & Export
- **Real-time log file**: optional append-only logging to `<Documents>/MySerial/logs/`.
- **Export**: current session to `.txt`, `.csv` (`timestamp,direction,data`), or `.hex` (standard hex dump).

#### 🎨 UX Polish
- **Dark / Light theme** with system-aware defaults, persisted to local storage.
- **i18n**: English / Simplified Chinese, auto-detected from system locale.
- **MOD signal indicators**: CTS / DSR / CD / RI input lights in the status bar.
- **Live stats**: RX/TX byte totals, rate (B/s), connection uptime.
- **Global shortcuts**: `Ctrl+L` clear · `Ctrl+Shift+N` new tab · `Ctrl+Tab` cycle tabs.

### 📸 Screenshots

> Screenshots will be added in a future revision. Run `npm run tauri dev` to see it live.

### 📥 Download & Install

Grab the latest installer from the [**Releases page**](../../releases):

| Asset | Use case |
|---|---|
| `MySerial_0.1.0_x64_en-US.msi` | Standard Windows MSI installer (recommended for enterprise) |
| `MySerial_0.1.0_x64-setup.exe` | NSIS installer, bundles WebView2 bootstrapper |
| `my-serial.exe` | Standalone portable executable |

**Requirements**: Windows 10 (1809+) or Windows 11. WebView2 runtime is bundled with the NSIS installer; the MSI assumes it is present (it ships with Win11 by default).

### 🔨 Build from Source

**Prerequisites**

| Tool | Version |
|---|---|
| Rust | stable (MSVC toolchain) |
| Node.js | ≥ 20 LTS |
| Tauri CLI | 2.x (installed via npm) |
| Visual Studio Build Tools | 2022 with *Desktop C++* workload |
| WebView2 Runtime | Win10 1809+ / built into Win11 |

```bash
# Install frontend dependencies
npm install

# Develop (hot-reload Vite + Tauri window)
npm run tauri dev

# Type-check
npm run check

# Production build → generates MSI + NSIS in src-tauri/target/release/bundle/
npm run tauri build
```

### 🧱 Tech Stack

| Layer | Technology |
|---|---|
| Shell / IPC | **Tauri 2** |
| Backend | **Rust** (edition 2021, MSRV 1.77) |
| Serial I/O | [`serialport-rs`](https://crates.io/crates/serialport) 4.5 |
| Async runtime | [`tokio`](https://tokio.rs) 1 (full) |
| Frontend | **Svelte 5** runes + **TypeScript** |
| Build tooling | **Vite 6** |
| Styling | **Tailwind CSS** 3.4 + CSS variables |
| Icons | `@lucide/svelte` |
| i18n | `svelte-i18n` 4 |
| ANSI parsing | `ansi_up` 6 |

### 📁 Project Structure

```
my_serial/
├── src/                      # Frontend (Svelte 5 + TS)
│   ├── App.svelte            # Root: title bar, tab strip, layout, shortcuts
│   ├── styles/app.css        # Tailwind + theme CSS variables
│   └── lib/
│       ├── components/       # PortConfigPanel, SendPanel, OutputView, StatusBar
│       ├── services/         # rx-buffer, line-slice, recorder
│       ├── stores/           # Svelte stores: tabs/sessions/ports/theme
│       ├── tauri/            # invoke + listen bindings with typed payloads
│       └── i18n/locales/     # zh-CN.json, en-US.json
├── src-tauri/                # Backend (Rust)
│   ├── tauri.conf.json       # MSI + NSIS bundle config
│   └── src/
│       ├── commands.rs       # 10 #[tauri::command] IPC handlers
│       ├── session.rs        # Session manager, read loop, reconnect FSM
│       ├── serial_io.rs      # UTF-8 boundary-safe decoding
│       ├── ports.rs          # Port enumeration + hot-plug watcher
│       └── types.rs          # Cross-IPC types & event payloads
└── tests/                    # TS unit tests (rx-buffer, line-slice)
```

### 🤝 Contributing

This is currently a personal project, but issues and pull requests are welcome. For large changes, please open an issue first to discuss the direction.

### 📄 License

MIT — see [`LICENSE`](LICENSE).

---

## 🇨🇳 中文文档

### 🎯 项目简介

**MySerial** 是一款面向嵌入式开发者、IoT 工程师和硬件玩家的现代化原生 Windows 串口终端。它对标老牌神器 [HTerm](https://www.der-hammer.info/pages/terminal.html)，保留 HTerm 的全部优点，同时补齐其三大短板：

1. **ANSI 彩色渲染** —— 正确解析 SGR 转义序列，告别黑白。
2. **UTF-8 / 中文支持** —— 跨 read 边界安全解码，汉字不再乱码。
3. **断线自动重连** —— USB 拔插、休眠唤醒、设备重启都能挺住。

基于 **Tauri 2 + Rust + Svelte 5** 构建，产物是 ~5 MB 的原生安装包，**不是动辄上百 MB 的 Electron**。

### 💡 为什么选 MySerial？（对比 HTerm）

| 能力 | HTerm | MySerial |
|---|:---:|:---:|
| ANSI 彩色码 | ❌ | ✅ |
| UTF-8 / 中文 | ❌（乱码） | ✅ |
| 断线自动重连 | ❌ | ✅ |
| 现代化可换肤 UI | ❌（Win95 风格） | ✅ 暗黑/明亮 |
| 多标签会话 | ❌ | ✅ |
| Hex + ASCII 双列视图 | 部分 | ✅（CJK 对齐） |
| 字节级悬停提示 | ❌ | ✅ |
| MSI / NSIS 安装包 | ❌ | ✅ |
| 文件体积 | ~2 MB | ~5 MB 安装包 |

### ✨ 功能特性

#### 🔌 串口连接
- **全参数支持**：波特率（含 ESP8266 boot-log 用的 74880 等预设）、数据位 5–8、校验 None/Even/Odd/Mark/Space、停止位 1/2、流控 None/Software/Hardware。
- **热插拔检测**：500ms 端口监听器，USB 插入/拔出时下拉列表实时刷新。
- **端口信息丰富**：COM 名、USB 产品/厂商描述、VID:PID、序列号。

#### 🔄 自动重连
- 稳健状态机：`Disconnected → Connecting → Connected → Reconnecting → Lost`。
- 由读错误触发（非端口轮询）—— 休眠、拔插、重启都能恢复。
- 间隔与最大次数可配；每个 Tab 上的状态圆点实时显示。

#### 📤 数据发送
- **ASCII / Hex 双模式**，切换时双向无损转换。
- **智能 Hex 解析**：容错 `0x` 前缀、逗号、缺空格、粘贴杂质。
- **后缀选项**：None / CR / LF / Space / ETX / NUL / **自定义**（支持 `\r\n\t\0\xNN` 转义或原始 Hex）。
- **循环 / 定时发送**：间隔最小 50ms，断开时自动停止。
- **发送历史**：最近 100 条，去重，点击恢复文本与模式。

#### 📥 数据显示与渲染
- **自研终端视图**（非 xterm.js），基于 `ansi_up` + 虚拟滚动 —— 高流量下依然流畅。
- **三种显示模式**：ASCII / Hex / **ASCII+Hex 双列对照**，且 CJK 字符在双列间对齐（这是 xterm 做不到的）。
- **ANSI 彩色**：SGR 序列解析，可一键关闭。
- **UTF-8 边界安全**：Rust 端跨 read 缓冲多字节残尾，永远不会出现"半个汉字"。
- **时间戳**：关闭 / 绝对 `HH:mm:ss.fff` / 相对 `+0.123s`。
- **灵活的行切分**：按 NUL/LF/CR/CRLF/ETX 切、自定义字节序列（可跨 chunk 匹配）、按 N 字节强制断行、按空闲时长断行。
- **字节级悬停提示**：鼠标悬停任意字节，显示接收时间、方向、偏移（十进制+十六进制）、原始字节、解码值。
- **控制字符图形化**：开启后用 `␀␊␍␃␡` 显示不可打印字符。
- **暂停 / 自动滚动 / 清屏**（`Ctrl+L`）。

#### 🗂 多标签
- **同时连接多个串口**，每个 Tab 一个独立后端会话。
- 所有 Tab 始终挂载（仅隐藏）—— 切换瞬间完成、不丢历史。
- Tab 标题随连接状态变化（已连接时显示 COM 名）。

#### 💾 日志与导出
- **实时日志**：可选追加写入 `<Documents>/MySerial/logs/`。
- **导出**：当前会话导出为 `.txt`、`.csv`（`timestamp,direction,data`）、`.hex`（标准 hex dump）。

#### 🎨 体验打磨
- **暗黑 / 明亮主题**，跟随系统，写入本地存储。
- **国际化**：英文 / 简体中文，按系统语言自动判定。
- **MOD 信号指示**：状态栏显示 CTS / DSR / CD / RI 输入信号灯。
- **实时统计**：RX/TX 字节总数、速率（B/s）、连接时长。
- **全局快捷键**：`Ctrl+L` 清屏 · `Ctrl+Shift+N` 新 Tab · `Ctrl+Tab` 切换 Tab。

### 📥 下载与安装

前往 [**Releases 页面**](../../releases) 下载最新安装包：

| 资产 | 适用场景 |
|---|---|
| `MySerial_0.1.0_x64_en-US.msi` | Windows 标准 MSI 安装包（企业部署推荐） |
| `MySerial_0.1.0_x64-setup.exe` | NSIS 安装包，自带 WebView2 引导安装 |
| `my-serial.exe` | 独立便携版可执行文件 |

**运行要求**：Windows 10（1809+）或 Windows 11。NSIS 安装包会自动引导安装 WebView2；MSI 假定系统已有（Win11 默认内置）。

### 🔨 从源码构建

**环境要求**

| 工具 | 版本 |
|---|---|
| Rust | stable（MSVC 工具链） |
| Node.js | ≥ 20 LTS |
| Tauri CLI | 2.x（通过 npm 安装） |
| Visual Studio Build Tools | 2022，勾选 *使用 C++ 的桌面开发* |
| WebView2 Runtime | Win10 1809+ / Win11 自带 |

```bash
# 安装前端依赖
npm install

# 开发模式（同时热重载 Vite 与 Tauri 窗口）
npm run tauri dev

# 类型检查
npm run check

# 生产构建 → 在 src-tauri/target/release/bundle/ 下生成 MSI + NSIS
npm run tauri build
```

### 🤝 贡献

目前是个人项目，但欢迎提 Issue 和 PR。大的改动请先开 Issue 讨论方向。

### 📄 许可证

MIT —— 见 [`LICENSE`](LICENSE)。
