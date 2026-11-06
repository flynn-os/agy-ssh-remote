# Antigravity Desktop SSH Remote Workspace (`agy-ssh-remote`)

<p align="center">
  <b>在同一个 Antigravity Desktop 窗口中，同时管理本机 Mac、远程 SSH 服务器与官方云端项目</b><br/>
  <sub>Unified Local + Remote SSH + Official Cloud Workspace · Real-Time CLI Session Sync · Dual-Route SSH Failover</sub>
</p>

<p align="center">
  <a href="#简体中文"><b>📖 简体中文文档</b></a> &nbsp;|&nbsp; <a href="#english"><b>🌐 English Documentation</b></a>
</p>

---

<a id="简体中文"></a>

## 简体中文

### 这是什么？解决了什么痛点？

原版 macOS **Antigravity Desktop** 默认只能打开本机目录，或者依赖云端 GitHub 虚拟机；如果你想连接自己的远程 Linux 开发机写代码，往往只能在终端跑 CLI，或者频繁切换窗口。

本项目通过**外部无损注入**（不修改 `/Applications/Antigravity.app` 安装包、不破坏 macOS 代码签名），在本地建立轻量级联邦网关（`127.0.0.1:58282`），为 Antigravity Desktop 提供完整的**本地 Mac + 远程 SSH 服务器 + 官方云端混合工作区**。

---

### 核心 SSH 工作区功能

#### 1. 本机、远程 SSH 与官方云端项目同栏共存，点击即切
- **三类环境精准识别与着色**：左侧边栏同时展示 **Mac 本机项目**（`[本机]`）、**远程 Linux 服务器项目**（`[SSH · 主机名]`）与 **官方云端项目**（`[☁️ 云端]`，基于 `BACKEND_TYPE_REMOTE_AICODE` 自动识别，不会误标为本机或 SSH）。
- **一键筛选与零刷新切换**：顶部控制卡支持一键筛选 **「全部 / 💻 本机 / 🌐 远程」**，在不同环境的项目与会话之间点击即切，**零整页刷新**。
- **智能双路 SSH 自动容灾**：支持主路由直连（局域网 / Tailscale）与备用反代隧道双路探测，直连断线时自动无感切换至备用隧道，网络恢复后自动回切直连。
- **官方 Cloud 会话单源路由与影子去重**：针对官方云端 Remote Agent（`BACKEND_TYPE_REMOTE_AICODE`）自动启用单源路由（优先经由已注入 `--remote_agent_fastpush_override=false` 的远端 `language_server` 转发），既解决 Antigravity `2.29.0+` 开启代理时新建 Remote 报 `dial tcp 172.253.120.126:10808: i/o timeout` 的官方 Bug，又自动剔除 `v1/default/jetski_remote_agents_3p/...` 服务端影子记录，避免单次新建出现重复会话。
- **终端 `agy` CLI 会话实时上屏**：在远程服务器或本机终端里使用 `agy` CLI 发起的对话，3 秒内自动同步到 Desktop 左侧边栏对应项目下，点开即可无缝续聊。

#### 2. 应用内直接浏览并添加远程服务器目录
- 点击侧边栏的 **「🌐+ 远程目录」**，直接在应用内弹出远程 Linux 目录浏览器（不会误弹 Mac 本机 Finder）。
- 支持常用路径一键跳转、自动识别远程 Git 仓库与分支（`Select branch ▾`），选中即可一键挂载到左侧项目列表。

---

### 快速开始（3 步安装）

#### 第一步：确认前置条件
1. macOS 已安装 `/Applications/Antigravity.app` 与 Node.js（建议 v22+）。
2. `~/.ssh/config` 中已配置好远程 Linux 免密登录主机别名。安装后在 `~/.antigravity-patch/config.json` 里填写两条线路对应的别名（也可用环境变量 `AG_SSH_DIRECT_HOST` / `AG_SSH_TUNNEL_HOST` 覆盖）：
   ```json
   "sshRoutes": {"direct": "<直连别名>", "tunnel": "<跳板隧道别名>"}
   ```

#### 第二步：一键安装并启动守护进程
```bash
git clone https://github.com/flynn-os/agy-ssh-remote.git
cd agy-ssh-remote
./install.sh
```
`./install.sh` 会自动将运行文件同步到 `~/.antigravity-patch/`，注册 macOS 开机自启 `LaunchAgent`，同步远端桥接脚本并执行端到端自检（输出 `"passed": true` 即代表全部就绪）。

#### 第三步：日常 SSH 控制命令

| 操作说明 | 运行命令 |
| :--- | :--- |
| 查看当前运行状态 & SSH 路由延迟 | `node ~/.antigravity-patch/patchctl.mjs status` |
| 仅查看 SSH 隧道与远端服务状态 | `node ~/.antigravity-patch/patchctl.mjs ssh status` |
| 切换 SSH 路由模式 (`auto` / `direct` / `tunnel` / `local`) | `node ~/.antigravity-patch/patchctl.mjs ssh auto` |
| 重启远端 Linux 上的 `language_server` | `node ~/.antigravity-patch/patchctl.mjs ssh restart` |
| 修改本仓库代码后重新部署 | `./install.sh`（或 `npm run deploy`） |

---

### 代码结构说明

```text
agy-ssh-remote/
├── install.sh              # 一键安装脚本：同步到 ~/.antigravity-patch 并重启后台守护服务
├── package.json            # 项目配置与快捷脚本
├── src/                    # 本地核心服务与 CLI 工具 (Node.js)
│   ├── daemon.mjs          # 本地常驻守护进程：自动发现 Antigravity 窗口并注入前端桥接脚本
│   ├── ssh-remote.mjs      # 核心联邦网关：管理 SSH 隧道，并在本地 58282 端口合并本机、远端与官方云端的项目/对话列表
│   ├── cdp.mjs             # Chrome DevTools Protocol 通信层
│   ├── bundle.mjs          # 前端注入脚本打包器
│   ├── patchctl.mjs        # 命令行控制工具
│   └── verify.mjs          # 端到端自动化校验脚本
├── ui/                     # 前端渲染进程注入层
│   ├── inject.js           # 前端界面脚本：渲染侧边栏 SSH 控制卡、环境徽标（本机/SSH/云端）与远程目录选择弹窗
│   ├── theme.css           # 侧边栏控制卡、徽标与远程目录弹窗样式
│   └── zh-CN.json          # 界面词典映射
├── remote/                 # 远端 Linux 服务器脚本
│   └── remote-ctl.py       # 自动在远端 Linux 下载对应版本的 language_server 并提供 58284 桥接接口
├── config/                 # 默认运行配置与 LaunchAgent 模板
│   ├── config.json         # 默认运行配置
│   ├── launchd/            # macOS LaunchAgent 自启配置
│   └── user/               # 用户自定义扩展目录
└── assets/                 # 静态资源
```

---

<a id="english"></a>

## English

### Overview

**Antigravity Desktop SSH Remote Workspace (`agy-ssh-remote`)** extends macOS `Antigravity.app` with a **unified Local + Remote SSH + Official Cloud workspace**, dual-route SSH automatic failover, in-app remote directory browsing, and real-time external `agy` CLI session indexing—all **without modifying the application binary or breaking macOS code signatures**.

---

### Key Features

#### 1. Unified Local Mac, Remote SSH & Official Cloud Sidebar
- **Distinct Environment Badges**: Manage **local macOS projects** (`[本机]`), **remote Linux server projects** (`[SSH · hostname]`), and **official Cloud projects** (`[☁️ 云端]`, automatically classified via `BACKEND_TYPE_REMOTE_AICODE`) side by side in the same left sidebar.
- **One-Click Filtering & Zero Reloads**: Filter projects by **All / Local / Remote** with one click and switch across local, SSH, and Cloud conversations with **zero page reloads**.
- **Dual-Route SSH Automatic Failover**: Automatically probes primary direct SSH (LAN / Tailscale) and fallback relay tunnel routes, failing over seamlessly on disconnect.
- **Single-Source Cloud Routing & Shadow Deduplication**: Routes `BACKEND_TYPE_REMOTE_AICODE` streams through a single upstream (preferring the remote LS launched with `--remote_agent_fastpush_override=false` to bypass the Antigravity `2.29.0+` proxy timeout bug) and automatically deduplicates `v1/default/jetski_remote_agents_3p/<uuid>` shadow records.
- **Automatic `agy` CLI Session Sync**: Any session started via the `agy` CLI in your terminal automatically appears under its matching project in the Desktop sidebar within 3 seconds.

#### 2. In-App Remote Linux Folder Picker
- Click **`🌐+ 远程目录` (Add Remote Folder)** in the sidebar to browse directories and Git repositories on your remote Linux server directly inside Antigravity Desktop.

---

### Quick Start

```bash
git clone https://github.com/flynn-os/agy-ssh-remote.git
cd agy-ssh-remote
./install.sh
```

Then set your two `~/.ssh/config` host aliases in `~/.antigravity-patch/config.json` (or via `AG_SSH_DIRECT_HOST` / `AG_SSH_TUNNEL_HOST`):

```json
"sshRoutes": {"direct": "<lan-or-tailscale-alias>", "tunnel": "<jump-host-alias>"}
```

### Everyday CLI Commands

| Action | Command |
| :--- | :--- |
| Check health status & SSH route latency | `node ~/.antigravity-patch/patchctl.mjs status` |
| Check SSH tunnel & remote server status | `node ~/.antigravity-patch/patchctl.mjs ssh status` |
| Switch SSH routing mode (`auto` / `direct` / `tunnel` / `local`) | `node ~/.antigravity-patch/patchctl.mjs ssh auto` |
| Force-restart remote Linux `language_server` | `node ~/.antigravity-patch/patchctl.mjs ssh restart` |
