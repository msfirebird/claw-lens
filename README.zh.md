[English](./README.md) | [中文](./README.zh.md)

# claw-lens

[![npm version](https://img.shields.io/npm/v/claw-lens-cli)](https://www.npmjs.com/package/claw-lens-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)

**claw-lens 将 Observability、Analytics 与开发者工具融合为一 —— 为 [OpenClaw](https://openclaw.ai) agent 提供成本追踪、Session 分析、Profiler、Cache Trace 和安全审计，全部跑在本地。**

---

## 设计理念

过去做监控的工具，默认写代码的人、看日志的人、修 bug 的人都是工程师。AI agent 把这件事改了。现在用 agent 干活的人——创业者、分析师、运营、跨境电商从业者——他们不是工程师，Datadog 和 Honeycomb 也不是给他们做的。

claw-lens 就是在这个背景下做的。对 agent 来说，最该盯的不是延迟，是钱。最基本的单位不是一次请求，是一整个 session。而最严重的问题——agent 读了不该读的文件、把密钥暴露出去、被注入的指令带着跑——根本不会报错。你得有个工具，能把系统真正在干什么摊开给你看。

→ [claw-lens.com/engineering/agent-observability](https://claw-lens.com/engineering/agent-observability)

---

<h2 id="screenshot">截图</h2>

![Overview](./assets/zh_screenshot/zh_overview.png)

<details id="more-details">
<summary>更多截图（有点长，可以过后再读）</summary>

### Token 用量
![Token 用量](./assets/zh_screenshot/zh_token.png)

### 智能体
![智能体](./assets/zh_screenshot/zh_agents.png)

### 实时监控
![实时监控](./assets/zh_screenshot/zh_live.png)

### 会话
![会话](./assets/zh_screenshot/zh_sessions.png)
![会话详情](./assets/zh_screenshot/zh_sessions_details.png)
![会话消息](./assets/zh_screenshot/zh_sessions_msg.png)

### 定时任务
![定时任务](./assets/zh_screenshot/zh_cron.png)

### 记忆
![记忆](./assets/zh_screenshot/zh_memory.png)

### 安全审计
![安全审计](./assets/zh_screenshot/zh_audit.png)
![审计事件详情](./assets/zh_screenshot/zh_audit_eventdetails.png)
![审计智能体状态](./assets/zh_screenshot/zh_audit_agentstatus.png)

### 时间线
![时间线](./assets/zh_screenshot/zh_timeline.png)
![时间线错误步骤](./assets/zh_screenshot/zh_timeline_errorstep.png)

### 性能分析
![性能分析](./assets/zh_screenshot/zh_profiler.png)

### 深度轮次
![深度轮次](./assets/zh_screenshot/zh_deepturn.png)

### 上下文拆解
![上下文拆解](./assets/zh_screenshot/zh_contextbreakdown.png)

### 缓存追踪
![缓存追踪](./assets/zh_screenshot/zh_cachetrace.png)

[回到顶部](#more-details)

</details>

---

## 功能

- **概览** — KPI 一览（今日花费、token 用量、session 数、报错数、缓存效率），7 天走势，周环比，按模型的成本分布，活跃 agent 列表
- **Token 用量** — 四维成本拆解（input、output、cache read、cache write），支持按 agent、模型、时间段看；缓存命中率；定时任务和手动任务的成本对比
- **智能体** — 每个 agent 的统计数据、花费、session 数，以及 agent 的记忆文件
- **实时监控** — 实时 agent 活动流，通过 WebSocket 接 OpenClaw Gateway
- **会话** — session 列表，可以按 agent、模型、日期、成本筛选；带上下文健康度标识；每个 session 都能展开看完整的 tool call 链路
- **定时任务** — 定时任务列表、历次运行记录、状态和成本
- **记忆** — 查看所有 agent 的工作区和记忆文件
- **安全审计** — 安全事件时间线，用规则做风险评分（高/中/低），覆盖文件访问、shell 命令、外部 HTTP 请求、敏感数据检测（34 种正则）、提示词注入检测（9 种模式），还有基于 30 天行为基线的异常检测
- **时间线** — 单个 session 的逐轮消息回放，带 token 数、停止原因、tool call 详情
- **性能分析** — 按 token 消耗给 session 排名，工具耗时分析
- **深度轮次** — 发现深层轮次里的重复 tool 调用模式，带唯一性评分和按 agent 分组
- **上下文拆解** — 逐轮上下文窗口占用图，拆成 system / history / tool-result 三块，刻度精确到模型的真实容量上限
- **缓存追踪** — 逐步回放 OpenClaw 的缓存日志，看每个阶段的变化、digest diff 和模型配置
- **i18n** — 中英文双语界面
- **数据全部留在本地** — 只读 OpenClaw 本地的 JSONL 日志，不往任何外部服务器发数据

详细的逐页功能说明：**[claw-lens.com/monitoring/overview](https://claw-lens.com/monitoring/overview)**

---

## 快速开始

```bash
npx claw-lens-cli
```

打开 `http://localhost:4242`。不用注册，不用配置，不上传任何数据。

```bash
npm install -g claw-lens-cli   # 或者用 npm 全局安装
claw-lens --port 3000      # 换端口（默认 4242）
claw-lens --no-open        # 启动时不自动开浏览器
```

需要 Node.js 18+。设置 `OPENCLAW_HOME` 环境变量可以指定数据目录（默认 `~/.openclaw`）。

更多 CLI 用法见 [claw-lens.com/reference/cli](https://claw-lens.com/reference/cli)。

### 开发者

```bash
git clone https://github.com/msfirebird/claw-lens.git
cd claw-lens
npm install
cd src/ui && npm install && cd ../..
npm run dev
```

后端（Express + ts-node-dev，端口 4242）和前端（React + Vite，端口 6060）同时跑，改了 `src/server/` 或 `src/ui/` 下的代码马上生效。

→ [claw-lens.com/development](https://claw-lens.com/development)

---

## 架构

claw-lens 完全跑在本地。它读 OpenClaw 写到磁盘上的文件——session JSONL、缓存日志、定时任务配置、agent 记忆——把 session 数据解析进 SQLite，再通过 Express API 给 React 前端用。不依赖外部服务，不用部署，不需要配置文件。

四个核心原则：

- **零配置** — `npx claw-lens-cli` 自动建表、导入数据、打开浏览器。装了 Node.js 就能用。
- **成本优先** — 美元花费是最醒目的数字，session、模型、agent 三个维度都能看到。Token 明细在下一层，想看随时点进去。
- **本地只读** — 服务只监听 `127.0.0.1`，不往外发请求，不碰 agent 的文件。claw-lens 唯一写的东西是自己的 SQLite 数据库。
- **规则驱动的安全审计** — 每个 tool call 入库时就用确定性规则打分，不靠机器学习。每个 agent 有自己的行为基线用来检测异常。规则全是透明的——看代码就知道为什么会被标记。

完整设计文档（数据模型、技术选型、各种取舍）：**[claw-lens.com/engineering/design-doc](https://claw-lens.com/engineering/design-doc)**

---

## 数据来源

claw-lens 直接读本地 OpenClaw 数据目录（默认 `~/.openclaw/`）：

| 路径 | 内容 |
|------|------|
| `agents/*/sessions/*.jsonl` | Session 日志（包括 `.deleted` 和 `.reset` 后缀的归档文件） |
| `logs/cache-trace.jsonl` | 缓存日志，用于回放和上下文分析 *(需要在 OpenClaw 里开启 cache trace — [怎么开](https://claw-lens.com/reference/data-retention#cache-trace-retention))* |
| `cron/` | 定时任务定义和状态 |
| `workspace-*/`, `agents/*/workspace/` | Agent 记忆和工作区文件 |
| `openclaw.json` | Gateway 认证 token，用于实时 WebSocket 连接 |

claw-lens 只写一个文件：`~/.openclaw/claw-lens.db`（SQLite）。

---

> **所有数据都在本地。** claw-lens 只监听 `127.0.0.1`，CORS 限制在 localhost，不发任何外部请求。唯一的网络连接是到你本机 OpenClaw Gateway 的 WebSocket。没有任何东西会离开你的电脑。

---

## 许可证

[MIT](./LICENSE)
