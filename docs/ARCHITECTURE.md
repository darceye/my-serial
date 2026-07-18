# MySerial 系统架构文档

> 版本：0.1 · 对应需求：见 [REQUIREMENTS.md](./REQUIREMENTS.md)

---

## 1. 技术栈

| 层 | 选型 | 版本 | 说明 |
|---|---|---|---|
| 应用框架 | **Tauri 2** | 2.x stable | WebView2 + Rust 后端，体积小 |
| 后端语言 | **Rust** | stable (MSVC) | 内存安全、零成本抽象 |
| 串口底层 | **serialport-rs** (`serialport = "4.5"`) | — | 社区最成熟的跨平台串口库 |
| 异步运行时 | **tokio** | 1.x | 读线程与重连 watcher |
| 前端框架 | **Svelte 5 + TypeScript** | 5.x | 运行时轻、编译期优化 |
| 构建工具 | **Vite 6** | 6.x | HMR 快 |
| 终端渲染 | **xterm.js** (`@xterm/xterm` + fit/search/web-links addons) | 5.x | VS Code 终端同款，解决 ANSI 彩色与中文 |
| UI 样式 | **Tailwind CSS 3** | 3.x | 原子化，Win11 Fluent 风格 |
| 图标 | **@lucide/svelte** | 1.x | 风格统一 |
| 国际化 | **svelte-i18n** | 4.x | 中英文切换 |
| 状态管理 | **Svelte stores** | 内置 | 多 Tab 会话状态 |
| 持久化 | **JSON 配置文件**（`tauri-plugin-store`） | — | 个人工具无需数据库 |
| 打包 | **Tauri bundler** → MSI / NSIS | — | Windows 原生安装包 |

**运行依赖**：Windows 10 1809+ / Windows 11 的 **WebView2 Runtime**（系统预装；缺失时打包配置 `webviewInstallMode: downloadBootstrapper` 自动引导安装）。

---

## 2. 进程与整体架构

```
┌─────────────────────────────────────────────────────────────┐
│              前端进程 (Svelte + WebView2)                    │
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │  xterm.js   │  │  配置面板     │  │ 发送区/宏/历史      │  │
│  │  终端显示   │  │  端口/参数    │  │ 控制信号面板        │  │
│  │             │  │  显示模式     │  │ 统计信息            │  │
│  └─────────────┘  └──────────────┘  └────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  SessionStore (Svelte store) —— 多 Tab 会话状态       │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│         ↕  Tauri IPC                                       │
│         (invoke 调用前端→后端 / event 推送后端→前端)         │
├─────────────────────────────────────────────────────────────┤
│              后端进程 (Rust)                                 │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  SessionManager (Mutex<HashMap<SessionId, Session>>)  │   │
│  │    └─ Session × N                                    │   │
│  │         ├─ SerialPort (serialport-rs)                │   │
│  │         ├─ ReadTask (tokio task)                     │   │
│  │         │     └─ UTF-8 边界缓冲解码                   │   │
│  │         │     └─ emit "serial:data"                  │   │
│  │         ├─ write(bytes)                              │   │
│  │         ├─ ReconnectWatcher (状态机)                 │   │
│  │         │     └─ emit "serial:status"                │   │
│  │         └─ SignalControl (RTS/DTR + 读 CTS/DSR/...)  │   │
│  │               └─ emit "serial:signal"                │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌────────────────────┐  ┌─────────────────────────────┐    │
│  │ PortEnumerator     │  │ Logger (收发日志写入文件)    │    │
│  │  └─ emit           │  └─ tauri-plugin-fs            │    │
│  │     "serial:       │  └─ 按会话分文件               │    │
│  │      ports_changed"│                                │    │
│  └────────────────────┘  └─────────────────────────────┘    │
│                                                             │
│         ↕  serialport-rs  →  Win32 串口驱动                  │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. IPC 接口约定

前端通过 `@tauri-apps/api` 的 `invoke` 调用命令、通过 `listen` 订阅事件。

### 3.1 Commands（前端 → 后端，invoke）

| 命令 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `get_app_info` | — | `AppInfo` | Phase 0 烟测 |
| `list_ports` | — | `Vec<PortInfo>` | 枚举可用端口（名/描述/VID/PID） |
| `open_port` | `{ session_id, config: PortConfig }` | `Result<()>` | 打开串口，启动读线程 |
| `close_port` | `{ session_id }` | `Result<()>` | 关闭并清理会话 |
| `write_data` | `{ session_id, data: Vec<u8> }` | `Result<()>` | 发送数据 |
| `set_signals` | `{ session_id, rts?, dtr? }` | `Result<()>` | 设置输出信号 |
| `get_signals` | `{ session_id }` | `Result<Signals>` | 读取输入信号状态 |
| `start_reconnect` | `{ session_id }` | — | 手动触发重连 |
| `cancel_reconnect` | `{ session_id }` | — | 中断重连 |
| `configure_reconnect` | `{ session_id, ReconnectConfig }` | — | 配置重连策略 |

### 3.2 Events（后端 → 前端，emit/listen）

| 事件 | Payload | 说明 |
|---|---|---|
| `serial:data` | `{ session_id, text: String, ts: i64, dir: "rx"\|"tx" }` | 已解码 UTF-8 文本块 |
| `serial:status` | `{ session_id, state, attempts?, msg? }` | 连接状态变化 |
| `serial:signal` | `{ session_id, cts, dsr, cd, ri }` | 输入信号变化 |
| `serial:stats` | `{ session_id, rx_bytes, tx_bytes, rx_rate, tx_rate }` | 统计快照（定时推送） |
| `serial:ports_changed` | `{ added: Vec<String>, removed: Vec<String> }` | 热插拔通知 |

### 3.3 关键数据结构

```rust
// Rust 端 (src-tauri/src/types.rs)
struct PortConfig {
    port_name: String,
    baud_rate: u32,
    data_bits: u8,       // 5,6,7,8
    parity: String,      // "none"|"even"|"odd"|"mark"|"space"
    stop_bits: u8,       // 1,2 (1.5 在 Windows 上特殊处理)
    flow_control: String,// "none"|"software"|"hardware"
}

struct ReconnectConfig {
    enabled: bool,
    interval_ms: u64,
    max_attempts: u32,   // 0 = 无限
    on_port_gone: String,// "prompt"|"wait"
}
```

---

## 4. 关键技术实现要点

### 4.1 UTF-8 跨包解码（R2 核心）

串口 `read` 返回的字节边界是任意的，可能切在一个多字节 UTF-8 字符中间。直接 `String::from_utf8` 会丢失或替换残缺字节。

**方案**：读线程维护一个 `Vec<u8>` 残留缓冲：

```rust
// 伪代码
let mut leftover: Vec<u8> = Vec::new();
loop {
    let mut buf = [0u8; 1024];
    let n = port.read(&mut buf)?;
    leftover.extend_from_slice(&buf[..n]);

    // 找到最后一个完整 UTF-8 字符的边界
    let safe_len = utf8_safe_boundary(&leftover);
    let complete = &leftover[..safe_len];
    let text = String::from_utf8_lossy(complete).into_owned();

    // 推送给前端
    app.emit("serial:data", Payload { text, .. })?;

    // 保留不完整的尾部
    leftover = leftover[safe_len..].to_vec();
}

/// 返回 buf 中最后一个完整 UTF-8 字符结束位置。
/// 从末尾向前回溯最多 3 字节，找到合法字符边界。
fn utf8_safe_boundary(buf: &[u8]) -> usize { /* ... */ }
```

前端只需 `term.write(text)`，无需关心字节切分。

### 4.2 自动重连状态机（R3 核心）

```rust
enum SessionState {
    Connected,
    Reconnecting { attempts: u32 },
    Lost,
}

// 读线程遇到错误时：
//   1. 标记 state = Reconnecting
//   2. emit "serial:status" { state: "reconnecting", attempts }
//   3. 关闭旧 port，按 interval_ms 重试 open
//   4. 成功 → state = Connected，emit，重启读线程
//   5. 达 max_attempts → state = Lost，emit，停止
```

端口消失检测：`PortEnumerator` 定时（500ms）枚举端口，若当前 session 的 port_name 不在列表且 `on_port_gone == "prompt"`，暂停重连并 emit 提示。

### 4.3 xterm.js + Svelte 5 生命周期

```svelte
<script>
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";

  let term; let fit; let container;
  let unlisten;

  onMount(async () => {
    term = new Terminal({ /* 主题 */ });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    // 订阅后端数据事件，批量写入
    const { listen } = await import("@tauri-apps/api/event");
    unlisten = await listen("serial:data", (e) => {
      if (e.payload.session_id === currentSession) {
        term.write(e.payload.text);
      }
    });

    // 窗口 resize 时重新适配
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(container);
  });

  onDestroy(() => { unlisten?.(); term?.dispose(); });
</script>
```

**批量渲染节流**：高速输入时用 `requestAnimationFrame` 合并多次 write，避免每字节触发重绘。

### 4.4 多会话管理

Rust 端 `SessionManager` 持有 `Arc<Mutex<HashMap<Uuid, Session>>>`，每个 Session 独立持有 port、读线程 handle、统计计数器。前端 Tab 与 SessionId (Uuid) 一一映射。

---

## 5. 项目目录结构

```
my_serial/
├── docs/                       # 文档
│   ├── REQUIREMENTS.md
│   └── ARCHITECTURE.md
├── src/                        # 前端 (Svelte)
│   ├── App.svelte              # 根组件
│   ├── main.ts                 # 入口
│   ├── styles/
│   │   └── app.css             # Tailwind + 全局样式
│   └── lib/
│       ├── i18n/               # 国际化
│       │   ├── index.ts
│       │   └── locales/
│       │       ├── zh-CN.json
│       │       └── en-US.json
│       ├── tauri/
│       │   └── commands.ts     # Rust 命令的 TS 绑定
│       ├── stores/             # Svelte stores (阶段 1+)
│       └── components/         # UI 组件 (阶段 1+)
├── src-tauri/                  # 后端 (Rust)
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json
│   ├── capabilities/
│   │   └── default.json
│   ├── icons/
│   └── src/
│       ├── main.rs             # 二进制入口
│       ├── lib.rs              # 库入口 (Tauri Builder)
│       ├── commands.rs         # #[tauri::command] 处理函数
│       ├── types.rs            # 数据结构 (阶段 1+)
│       ├── session.rs          # SessionManager + Session (阶段 1+)
│       ├── serial_io.rs        # 读线程 + UTF-8 解码 (阶段 1+)
│       ├── reconnect.rs        # 重连状态机 (阶段 2)
│       ├── ports.rs            # 端口枚举 + 热插拔 (阶段 1+)
│       └── logger.rs           # 日志记录 (阶段 4)
├── index.html
├── package.json
├── vite.config.ts
├── svelte.config.js
├── tsconfig.json
├── tailwind.config.js
└── postcss.config.js
```

---

## 6. 开发阶段与里程碑

| 阶段 | 内容 | 预估 | 交付物 |
|---|---|---|---|
| **0** | 环境与脚手架 | 2-3 天 | 可运行的空壳 + 文档 ✅ 进行中 |
| **1** | 串口核心通路 | 2 周 | 能收发 ASCII 与中文（无彩色/无重连） |
| **2** | 三大核心改进 | 1 周 | ANSI 彩色 + 中英文 + 自动重连全部可用 |
| **3** | 对标 HTerm 基础功能 | 2-3 周 | 日常调试可用完整版 |
| **4** | 多 Tab + 数据记录 | 1-2 周 | 多串口 + 日志导出 |
| **5** | 打磨与打包 | 1 周 | MSI/NSIS 安装包 + 文档 |

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| Rust 学习曲线陡 | 以官方 example 跑通为准；复杂逻辑先写伪代码 |
| UTF-8 跨包解码错位 | 统一在 Rust 端缓冲解码，前端只处理完整字符串；单测覆盖边界 |
| xterm.js 与 Svelte 5 生命周期坑 | 严格 onMount/onDestroy；ResizeObserver 释放 |
| 高波特率丢字 | Rust 读线程循环抢读无 sleep；前端 RAF 合并写入 |
| WebView2 缺失 | 打包配置 downloadBootstrapper 自动安装 |
| 自动重连端口名漂移 | 端口消失时按 `on_port_gone` 策略处理，不盲目重连旧名 |
