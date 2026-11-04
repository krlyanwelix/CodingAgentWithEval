# LilPiAgent

一个极简的 TypeScript coding agent，只做一件事：

```text
用户 -> 模型 -> 工具 -> 工具结果 -> 模型 -> 回答
```

没有 agent 框架，核心约 700 行 TypeScript，除 `better-sqlite3` 与 `dotenv` 外无运行库依赖。

## 特性

- **Agent 循环**：流式输出、同一轮并行调用多个工具、20 轮上限优雅收尾、完全重复的调用直接拦截、连续失败自动收敛。
- **上下文管理**：按轮切分历史，超预算时把早期轮次压成摘要；长工具结果截断，完整内容落 `data/tool-output/`。
- **会话树**（SQLite）：从任意 turn 续聊或分叉（`r<number>` / `f<number>`），崩溃留下的未完成 turn 自动收尾。
- **内置工具**：`read` / `write` / `edit` / `bash`；路径经真实路径校验防逃逸；Windows 自动探测 Git Bash；超时与输出上限保护。
- **扩展**：技能 `skills/**/SKILL.md` 渐进式加载，外部工具放 `tools/`，Mem0 长期记忆（可选）。
- **双入口**：命令行 REPL 与轻量 Web（SSE 流式）。
- **评测**：17 个任务（含 1 个 holdout），沙箱执行、自动判分、轨迹落 JSONL；`eval/evolve.ts` 支持 skill 自进化。

## 快速开始

Node.js 20+。

```sh
npm install
copy .env.example .env     # 填入服务端密钥
npm run dev
```

`.env` 至少需要：

```env
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.deepseek.com
MODEL=deepseek-flash
```

任何 OpenAI 兼容接口都可以，换地址和模型名即可。

## 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | 必填，模型 API 密钥 |
| `OPENAI_BASE_URL` | `https://api.deepseek.com` | 接口地址 |
| `MODEL` | `deepseek-flash` | 模型名 |
| `MODEL_MAX_TOKENS` | `2048` | 单次回答上限 |
| `MODEL_TEMPERATURE` | `0.3` | 越低工具调用越稳 |
| `MODEL_TOP_P` | `0.9` | 核采样 |
| `MODEL_TIMEOUT_MS` | `180000` | 单次请求硬超时 |
| `STREAM_IDLE_TIMEOUT_MS` | `120000` | 流式空闲超时 |
| `CONTEXT_MAX_INPUT_TOKENS` | `24000` | 提示词 token 预算 |
| `CONTEXT_RESERVE_TOKENS` | `2048` | 给回答留的余量 |
| `CONTEXT_KEEP_RECENT_TURNS` | `3` | 始终保留的最近轮数 |
| `CONTEXT_TOOL_RESULT_MAX_CHARS` | `4000` | 超过即截断的工具结果 |
| `CONTEXT_SPILL_DIR` | `data/tool-output` | 完整工具结果落盘位置 |
| `GIT_BASH_PATH` | 自动 | 自动探测不准时指定 bash.exe |
| `SESSION_DB` | `data/agent.sqlite` | 会话数据库 |
| `AGENT_TOOLS_DIR` / `AGENT_SKILLS_DIR` | `tools` / `skills` | 外部工具与技能目录 |
| `MEM0_URL` | `http://127.0.0.1:8765` | 记忆 sidecar 地址 |
| `MEM0_AUTOSTART` | `false` | 是否自动拉起 sidecar |

## 目录结构

```text
src/
  agent.ts          循环：模型 -> 工具 -> 模型，多轮控制
  model.ts          OpenAI 兼容客户端（流式、重试、超时）
  model-config.ts   .env 解析
  tools.ts          read / write / edit / bash
  context.ts        token 估算、历史压缩、工具结果截断
  tokens.ts         token 估算工具函数
  session-store.ts  SQLite 会话树
  loader.ts         技能与外部工具加载
  prompt.ts         给模型的行为契约
  index.ts          CLI 入口
  server.ts         Web 入口
eval/               评测任务、运行器、skill 自进化
skills/             技能（SKILL.md）
tools/              外部工具示例
web/                Web 静态页面
```

## 会话与记忆

会话存在 `data/agent.sqlite`，每个 turn 一个节点。启动时选择会话，用 `r<number>` 续聊或 `f<number>` 分叉；Ctrl+C 取消当前步骤，已生成的部分回答仍会保存。

长期记忆由 `memory-sidecar.py`（Mem0 + 内嵌 Qdrant）提供：

```sh
python -m pip install -r requirements-mem0.txt
python memory-sidecar.py
```

## 评测

```powershell
npm run eval                                  # 常规任务，默认每题跑 3 遍取多数
npm run eval -- --tasks=bugfix-duration       # 只跑一个任务
npm run eval -- --tasks=holdout               # 只跑隐藏任务
npm run evolve -- --skill=skills/coding-guide/SKILL.md
```

任务在 `data/eval/<runId>/<task>/` 的独立沙箱里运行，轨迹追加到 `data/trajectories.jsonl`，可直接作为离线训练样本。

## 开发

```sh
npm run build     # tsc
npm test          # node:test（61 个用例）
npm start         # 运行编译后的 CLI
npm run dev:web   # Web 入口
```

## 已知限制

- Web 端没有「取消当前请求」按钮；附件按钮只是占位。
- 评测任务对 deepseek-flash 已接近全过，需要更难的 holdout 才能拉开差距。
