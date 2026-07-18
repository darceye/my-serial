# MySerial

> Windows 端串口调试工具，对标 [HTerm](https://www.der-hammer.info/pages/terminal.html) 并补齐三大短板：**ANSI 彩色 / 中文 UTF-8 / 断线自动重连**。

## 技术栈

- **Tauri 2** + **Rust** 后端（串口底层 [`serialport-rs`](https://crates.io/crates/serialport)）
- **Svelte 5 + TypeScript** 前端
- **xterm.js** 终端渲染（ANSI 彩色 + UTF-8 原生支持）
- **Tailwind CSS** + **@lucide/svelte**（Win11 Fluent 风格）

## 开发环境

| 工具 | 版本要求 |
|------|----------|
| Rust | stable (MSVC toolchain) |
| Node.js | ≥ 20 LTS |
| Tauri CLI | 2.x |
| Visual Studio Build Tools | 2022 (C++ 工作负载) |
| WebView2 Runtime | Win10 1809+ / Win11 自带 |

## 快速开始

```bash
# 安装前端依赖
npm install

# 开发模式（同时启动 Vite 与 Tauri 窗口）
npm run tauri dev

# 类型检查
npm run check

# 生产构建并打包
npm run tauri build
```

## 文档

- [需求规格](docs/REQUIREMENTS.md)
- [系统架构](docs/ARCHITECTURE.md)

## 开发阶段

- [x] **阶段 0** — 环境与脚手架
- [ ] **阶段 1** — 串口核心通路
- [ ] **阶段 2** — 三大核心改进（彩色/中文/重连）
- [ ] **阶段 3** — 对标 HTerm 基础功能
- [ ] **阶段 4** — 多标签 + 数据记录
- [ ] **阶段 5** — 打磨与打包

## 许可证

待定（个人项目）。
