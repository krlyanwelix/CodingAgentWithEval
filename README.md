# CodingAgentWithEval

一个极简的 TypeScript coding agent，只做一件事：

```text
用户 -> 模型 -> 工具 -> 工具结果 -> 模型 -> 回答
```

没有 agent 框架，核心约 700 行 TypeScript，除 `better-sqlite3` 与 `dotenv` 外无运行库依赖。

## 特性

- **Agent 循环**：流式输出、同一轮并行调用多个工具、20 轮上限优雅收尾、完全重复的调用直接拦截、连续失败自动收敛。
- **上下文管理**：按轮切分历史，超预算时把早期轮次压成摘要；长工具结果截断，完整内容落 `data/tool-output/`。
- **会话树**（SQLite）：从任意 turn 续聊或分叉（`r<number>` / `f<number>`），崩溃留下的未完成 turn 自动收尾。
- **内置工具**：`read` / `write` / `edit` / `glob` / `grep` / `bash`；路径经真实路径校验防逃逸；Windows 自动探测 Git Bash；超时与输出上限保护。
- **约束层**：`src/harness/policy.ts` 解析每条命令的能力（读/写/shell/网络/git 写）与风险，危险命令先拦再问；能力可在 `.env` 里按需授予。
- **验证层**：结束前跑配置好的检查命令（测试、lint、类型检查），失败就把结果回灌给模型继续修，最多 N 次——完成判定看结构化事实，不看模型自称。
- **可观测**：每条轨迹可落 JSONL（`TRACE_DIR`），包含模型调用、工具批次、状态栏与验证结果；工具结果末尾的 `[harness]` 状态行让模型自己看到轮数、连续失败与上下文余量。
- **扩展**：技能 `skills/**/SKILL.md` 渐进式加载，外部工具放 `tools/`，Mem0 长期记忆（可选）。
- **双入口**：命令行 REPL 与轻量 Web（SSE 流式，Markdown 渲染、工具调用折叠、随时停止）。
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
| `AGENT_CAPABILITIES` | 全部 | 逗号分隔的能力白名单：`fs.read,fs.write,shell,network,git.write` |
| `AGENT_AUTO_APPROVE_RISK` | `never` | 自动放行的最高风险：`low` / `medium` / `high` |
| `AGENT_STATUS_BAR` | `true` | 是否在工具结果末尾追加 `[harness]` 状态行 |
| `AGENT_VERIFY_CHECKS` | 空 | 验证命令，`;;` 分隔的 `name=command`，如 `test=npm test;;lint=npx eslint .` |
| `AGENT_VERIFY_ATTEMPTS` | `1` | 验证失败后最多回灌几次 |
| `TRACE_DIR` | 空（关闭） | 轨迹 JSONL 输出目录；`TRACE_ENABLED=0` 显式关闭 |
| `JUDGE_API_KEY` | 空（关闭 judge） | LLM-as-judge 密钥 |
| `JUDGE_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | judge 接口地址 |
| `JUDGE_MODEL` | `qwen3.8-flash` | judge 模型名 |
| `JUDGE_SAMPLES` | `3` | judge 采样数（1–5），按 criterion 多数票合并 |
| `MEM0_URL` | `http://127.0.0.1:8765` | 记忆 sidecar 地址 |
| `MEM0_AUTOSTART` | `true` | 是否自动拉起记忆 sidecar |

## 目录结构

```text
src/
  agent.ts          循环：模型 -> 工具 -> 模型，多轮控制
  model.ts          OpenAI 兼容客户端（流式、重试、超时）
  model-config.ts   .env 解析
  tools.ts          read / write / edit / glob / grep / bash
  harness/          约束、验证、状态栏、错误分类、轨迹记录
    policy.ts       命令能力与风险分级
    verify.ts       验证命令执行
    status.ts       状态行
    errors.ts       工具错误分类
    trace.ts        轨迹 JSONL
    config.ts       .env 解析
  context.ts        token 估算、历史压缩、工具结果截断
  tokens.ts         token 估算工具函数
  session-store.ts  SQLite 会话树
  loader.ts         技能与外部工具加载
  prompt.ts         给模型的行为契约
  index.ts          CLI 入口
  server.ts         Web 入口
eval/
  tasks.ts          任务定义与 L0 断言
  runner.ts         执行、三层判定、指标聚合
  verifiers.ts      L1 diff 规则与 rubric
  judge.ts          LLM-as-judge 客户端（证据校验、并行采样）
  diff.ts           seed 与工作区的 diff
  report.ts         Markdown 报告
  run.ts            CLI
  calibrate.ts      judge 校准（Cohen's κ）
  evolve.ts         skill 自进化
sandbox/            沙箱控制面与数据面（Docker 实现）
skills/             技能（SKILL.md）
tools/              外部工具示例
web/                Web 静态页面
```

## Web 端

```sh
npm run dev:web        # http://127.0.0.1:3000
PORT=8080 npm run dev:web
```

- 会话列表、分支树（悬停查看任意 turn，可续聊或分叉）、长期记忆面板。
- 回答按 Markdown 渲染（代码块带复制按钮）；每次工具调用折叠成一行，展开看参数与输出。
- 运行中「Send」变成「Stop」，点它或关闭页面会中断模型请求与正在执行的工具，已生成的部分回答仍会写入会话。
- 附件按钮读取文本文件（≤1 MB），以 `<file name="...">` 块附加在下一条消息里；二进制文件会被拒绝。
- 输入框上方的「Run commands」决定本条消息能否执行 `bash`（默认开启，选择会记在浏览器里）；关闭时模型会收到「已取消」，`WEB_ALLOW_TOOLS=0` 可在服务端强制禁用。
- 服务默认只绑定 `127.0.0.1` 且没有登录，能打开页面的人就能让 agent 读写工作区并执行命令，不要暴露到公网。
- 顶栏与右侧「Run status」显示 `/api/health` 返回的模型名与上下文预算。

## 会话与记忆

会话存在 `data/agent.sqlite`，每个 turn 一个节点。启动时选择会话，用 `r<number>` 续聊或 `f<number>` 分叉；Ctrl+C 取消当前步骤，已生成的部分回答仍会保存。

长期记忆由 `memory-sidecar.py`（Mem0 + 内嵌 Qdrant）提供，默认随 CLI / Web 启动时自动拉起：

```sh
python -m pip install -r requirements-mem0.txt
python memory-sidecar.py                      # 手动启动（可选）
```

- 依赖 `OPENAI_API_KEY` 做事实抽取，依赖 `EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` 做向量化；向量维度要与 `MEM0_EMBEDDING_DIMS`（默认 2048）一致，换模型时删掉 `data/mem0-qdrant` 重建索引。
- sidecar 的 stdout/stderr 写入 `data/mem0-sidecar.log`；`/api/health` 里的 `memoryAvailable` 会在首次失败后动态重试，`memoryError` 给出最近一次失败原因。
- 设 `MEM0_AUTOSTART=false` 可以完全关掉记忆功能。

## 评测

每个任务在 `data/eval/<runId>/<task>-<attempt>/` 的独立沙箱里跑，seed 先写入，跑完做三层判定：

| 层 | 输入 | 作用 | 是否 gate |
| --- | --- | --- | --- |
| L0 任务断言 | 工作区 + 最终答复 | 测试通过、文件内容正确 | 是 |
| L1 diff 规则 | seed 与工作区 diff | 测试文件未被改、无密钥泄漏、改动可观察、答复非空 | 是 |
| L2 LLM-as-judge | diff + 验证输出 + 最终答复 | 只判断言够不着的维度（是否答非所问、最小改动、答复与改动一致） | 可选（`--gate-judge`） |

judge 只看产物，不看思维链；每条判定必须给出 `file:lines` + 原文引用，引用在产物里找不到就作废。采样 `JUDGE_SAMPLES` 次按 criterion 多数票合并，`must` 项全过且加权分 ≥ 0.75 才算通过。

```powershell
npm run eval                                   # 全部常规任务，默认每题 3 遍
npm run eval -- --tasks=bugfix-duration --repeat 1
npm run eval -- --tasks=holdout --no-judge     # 只跑隐藏任务、不调 judge
npm run eval -- --gate-judge                   # judge 参与通过判定（校准后再开）
npm run eval:judge                             # judge 连通性冒烟
npm run eval:calibrate                         # 与 L0/L1 结果比对，算 Cohen's κ
npm run evolve -- --skill=skills/coding-guide/SKILL.md
```

指标：Pass@1、Pass@k（任一 attempt 过）、Pass^k（全部 attempt 过）、多数票通过率、平均 reward、agent/judge token 成本、首错归因（harness / provider / 模型 / 规则）。报告写到 `data/eval-reports/<runId>.md`，逐条轨迹追加到 `data/trajectories.jsonl`。

**开放 `--gate-judge` 之前先校准**：跑 `npm run eval:calibrate`，κ ≥ 0.7 再让 judge 进 gate，否则它只计分不拦人。

## 沙箱（sandbox/）

控制面与数据面分离：控制面负责生命周期（异步创建、绝对 TTL、暂停/恢复、端点解析），数据面是沙箱内独立进程 `execd`，提供命令执行和文件读写。容器本身是唯一事实来源，元数据只是可重建的缓存。

```text
sandbox/
  types.ts          SandboxService 接口与状态类型
  service.ts        生命周期状态机、绝对 TTL、端点解析
  docker-runtime.ts Docker 实现
  control-plane.ts  HTTP 控制面
  server.ts         控制面入口（默认 :8090）
  client.ts         控制面 / execd 客户端
  execd/main.go     沙箱内数据面（Go，静态编译）
  execd/Dockerfile  运行时镜像（alpine + busybox sh）
  e2e.ts            端到端示例
```

```sh
npm run sandbox:image  # 构建 codingagentwitheval-sandbox:local（约 20MB）
npm run sandbox        # 启动控制面 :8090
npm run sandbox:e2e    # 起容器 -> 执行命令 -> 文件读写 -> 暂停/恢复 -> 删除
npm run test:docker    # Docker 生命周期测试（daemon 未启动时自动跳过）
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/sandboxes` | 创建，202 + `Pending` |
| GET | `/sandboxes/{id}` | 快照 |
| GET | `/sandboxes/{id}/ready?timeoutMs=` | 等到容器 Running 且 execd 应答 |
| GET | `/sandboxes/{id}/endpoints/{port}` | 解析端点，带 `X-EXECD-ACCESS-TOKEN` |
| POST | `/sandboxes/{id}/pause` / `/resume` | 仅 Running / Paused 合法 |
| DELETE | `/sandboxes/{id}` | 删除 |

Docker 实现相对 OpenSandbox 契约的差异：TTL 由应用侧定时清理；暂停会冻结进程（端口映射保留）；没有快照、出口策略和资源配额；镜像为 `codingagentwitheval-sandbox:local`（alpine + 静态编译的 Go execd，约 20MB），命令通过 busybox `sh -c` 执行，镜像内没有 Python/Node。

## 开发

```sh
npm run build     # tsc
npm run typecheck # tsc，覆盖 src/ 与 eval/
npm test          # node:test（含 eval/verifiers、eval/judge；Docker 版另见 npm run test:docker）
npm start         # 运行编译后的 CLI
npm run dev:web   # Web 入口
```

## 已知限制

- Web 端没有鉴权，默认只监听 `127.0.0.1`；对外暴露前请自行加一层反向代理与访问控制。
- 一个会话同时只允许一个请求在跑，第二个请求会覆盖当前 turn 的父节点。
- 附件只支持文本；图片、PDF 等二进制文件会被拒绝。
- judge 单次调用约 1–2s，但每题默认 3 采样；大规模跑评测建议先用 `--judge-samples 1` 调通，再全量。
- judge 与主模型不同家族（qwen3 vs deepseek），减少同源偏好；换 judge 模型要重跑校准。
- 评测沙箱是目录隔离（`setWorkspaceRoot` + 路径校验），不是容器隔离；要更强的隔离用 `sandbox/`。
- 评测任务对 deepseek-flash 已接近全过，需要更难的 holdout 才能拉开差距。
