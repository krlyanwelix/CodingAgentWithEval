# LilPiAgent

LilPiAgent is a minimal TypeScript CLI agent inspired by pi-agent:

```text
user -> model -> tools -> tool results -> model -> answer
```

## Run

Requires Node.js 20+.

```sh
npm install
copy .env.example .env
npm run dev
```

The agent talks to a local llama.cpp server by default:

```sh
llama-server -m D:\models\Qwen3.5-9B-Q4_K_M.gguf -c 16384 -ngl 99 --jinja \
  --host 127.0.0.1 --port 8080
```

```env
MODEL_PROVIDER=local
LOCAL_MODEL_BASE_URL=http://127.0.0.1:8080/v1
LOCAL_MODEL=qwen3.5-9b
# keep the prompt budget below llama-server's -c value
CONTEXT_MAX_INPUT_TOKENS=12000
# reasoning this 9B model away costs 30-100s per turn; off is the default
LOCAL_MODEL_ENABLE_THINKING=false
```

`MODEL_PROVIDER=remote` switches back to a hosted OpenAI-compatible API using
the legacy `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `MODEL` settings.

## Tools and Skills

Built-in tools: `read`, `write`, `edit`, and `bash`. File tools stay inside the current working directory. Bash requires confirmation.

External tools go in `tools/`; Skills go in `skills/**/SKILL.md`. Skills use progressive disclosure: metadata is loaded at startup and full instructions are loaded through `load_skill`.

```env
AGENT_TOOLS_DIR=tools
AGENT_SKILLS_DIR=skills
EXA_API_KEY=...
```

## Sessions

Sessions are stored as a tree in SQLite at `data/agent.sqlite`. Each node is one complete turn containing the user's question, the agent's final answer, and the names of tools used. On startup, choose a session, then resume a turn with `r<number>` or fork it with `f<number>`.

## Mem0 Memory

Long-term memory runs in the local Python Mem0 sidecar. Mem0 performs extraction, deduplication, conflict updates, and retrieval; its embedded Qdrant store persists vectors locally.

Install and run the sidecar:

```sh
python -m pip install -r requirements-mem0.txt
python memory-sidecar.py
```

Configure OpenRouter NVIDIA embeddings and the LLM used by Mem0:

```env
OPENROUTER_API_KEY=...
# EMBEDDING_API_KEY=...        # legacy alias also accepted
EMBEDDING_BASE_URL=https://openrouter.ai/api/v1
EMBEDDING_MODEL=nvidia/nemotron-3-embed-1b:free
MEM0_LLM_API_KEY=...
MEM0_LLM_BASE_URL=https://api.deepseek.com/v1
MEM0_LLM_MODEL=deepseek-chat
MEM0_VECTOR_PATH=data/mem0-qdrant
MEM0_EMBEDDING_DIMS=2048
```

The TypeScript agent calls the sidecar before and after each turn. It also supports:

```text
/remember <text>
/memories
/memory-search <query>
/forget <id>
/clear-memory
```

The sidecar reads the project `.env` itself. `MEM0_AUTOSTART=true` lets the TypeScript process start it automatically.

## Context budget and cancellation

Every prompt is fitted into a token budget (default 24000). When the history outgrows it, the oldest whole turns are dropped and replaced by a short digest that the agent keeps appending to the system prompt, so the model keeps the gist without re-sending everything. Any single tool result is capped before it enters the history; the full text of a long result is spooled to `data/tool-output/` so the model can read it back.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONTEXT_MAX_INPUT_TOKENS` | `24000` | Estimated prompt ceiling |
| `CONTEXT_RESERVE_TOKENS` | `2048` | Room left for the reply |
| `CONTEXT_KEEP_RECENT_TURNS` | `3` | Turns always kept verbatim |
| `CONTEXT_TOOL_RESULT_MAX_CHARS` | `4000` | Longer tool results are truncated |
| `CONTEXT_SPILL_DIR` | `data/tool-output` | Where full tool output is spooled |
| `MODEL_TIMEOUT_MS` | `180000` | Hard timeout for a non-streaming call |
| `STREAM_IDLE_TIMEOUT_MS` | `120000` | Abort a stream that stops producing bytes |
| `GIT_BASH_PATH` | auto | Full path of `bash.exe` when auto-detection picks the wrong one |

Ctrl+C while the agent is working cancels the current run: the in-flight model request and the running tool are aborted, the partial answer is saved to the turn, and the CLI returns to the prompt. Press it again at the prompt to exit.

Requests to the model server are retried up to three times on `429`/`5xx` with a short backoff; a refused connection is reported as "Cannot reach the model API at ...". When the server reports `finish_reason: "length"` the agent emits a warning that the answer was cut off, because an incomplete tool call would otherwise just fail to parse. Assistant `reasoning_content` is kept in the history and sent back to the model but never shown as the answer.

On Windows the `bash` tool looks for Git Bash in this order: `GIT_BASH_PATH`, the directory of the `git` on `PATH` (`<root>\bin\bash.exe`), `C:\Program Files\Git`, `E:\Git`, `D:\Git`, and `%LOCALAPPDATA%\Programs\Git`, and it deliberately skips the WSL launcher in `C:\Windows\System32`.

Resuming a session first closes any turn the previous process left unfinished, so the history never ends on a user message that has no answer.

The CLI and the web server ask `llama-server` for its own `n_ctx` at startup (`GET /props`) and cap `CONTEXT_MAX_INPUT_TOKENS` to fit inside it, leaving 3072 tokens for the reply and the server's prompt formatting. Guessing the window wrong costs one failed request per conversation, so the client never assumes more than the server reports.

## Loop guards

A small model loops in three recognisable ways, and the agent stops each one instead of burning turns:

- **Parallel calls.** Tool calls from one assistant message run concurrently (after their confirmation prompts, asked one at a time). Results still land in the history in call order, so the transcript stays deterministic.
- **Identical retries.** A call whose name and arguments equal the previous call is not executed; its result says `Skipped`, and two skips in a row end the run.
- **Failure streaks.** Tool errors count up, and every error carries a `Corrective:` line telling the model what to change. Three failures in a row end the run with a `[harness]` message instead of a fourth attempt.

The same rules back the prompt contract in `src/prompt.ts`: read before editing, never guess a path, one step at a time.

## Sampling and prompt

Every request carries explicit sampling defaults: a local `llama-server` otherwise generates up to the whole context window at `temperature 0.8`, which is how small models end up rambling and repeating themselves.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MODEL_MAX_TOKENS` | `2048` | Hard cap on one answer |
| `MODEL_TEMPERATURE` | `0.3` | Lower = steadier tool calls |
| `MODEL_TOP_P` | `0.9` | Nucleus sampling |
| `MODEL_REPEAT_PENALTY` | `1.05` | llama.cpp only; omitted for the hosted API |

`src/prompt.ts` holds the behaviour contract the model is given: list before guessing a path, read before editing, send independent reads as parallel calls in one message, create files with `write` (never a bash heredoc), keep one write under ~80 lines, never repeat a failed call, verify before claiming something ran, and answer in at most five lines. When the budget still does not fit after compaction, recent tool results are elided and then halved instead of failing the run. Hitting the turn limit ends with a `[harness]` message rather than throwing. Two guards back the contract up in `src/agent.ts`: an identical tool call that just ran is skipped instead of executed again, and two failures in a row append a change-approach hint to the tool result.

## Development

```sh
npm run build
npm start
npm test
```

The test suite uses Node's built-in test runner (through `tsx`) and covers the context budget and compaction, the session tree (resume, fork, delete), the agent loop against a scripted model (parallel calls, retries, loop guards), SSE parsing (malformed lines, cancellation, idle timeout, retry), the server-info probe, and the file tools.

## Web UI

The lightweight web mode uses the TypeScript HTTP server, a static SPA, and SSE for streamed responses. New sessions can have a display-only name, and the sidebar shows/searches Mem0 long-term memories.

```sh
python memory-sidecar.py
npm run dev:web
```

Open `http://127.0.0.1:3000`. For a production-style run, use `npm run build` followed by `npm run start:web`.

## 评测、轨迹与 skill 自进化

```powershell
npm run eval                                    # 全部任务，结果写入 data/trajectories.jsonl
npm run eval -- --tasks=bugfix-duration         # 只跑一个任务
npm run eval -- --skill=skills/coding-guide/SKILL.md
npm run evolve -- --skill=skills/coding-guide/SKILL.md
```

- `eval/tasks.ts`：每个任务 = 种子文件 + prompt + 自动判分命令；任务在 `data/eval/<runId>/<task>/` 的独立沙箱里运行（`setWorkspaceRoot` 把内置工具指到沙箱，不会碰仓库）。
- `eval/run.ts`：跑完追加一条 JSONL（prompt、工具序列、steps、reward、消息），可直接作为 Agentic RL 的离线轨迹集。
- `eval/evolve.ts`：读失败轨迹 → 模型重写 skill → 候选 skill 在失败任务上复跑 → 全部通过才写回，并在 `skills/<name>/HISTORY.md` 记录一次进化。文本学习率 = 单次最多 15 行改动，`eval/proposal.ts` 有单测覆盖。
- 默认 14 个任务：deepseek-flash 全过约 2 分钟；本地 qwen3.5-9b 为 13/14、约 5 分钟，失败的是多文件统计任务（耗尽 20 轮），正好是训练需要的失败样本。切到本地模型改 `MODEL_PROVIDER=local` 即可复用同一套评测。