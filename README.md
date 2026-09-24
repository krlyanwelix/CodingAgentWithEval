# Tiny Agent Loop

A minimal TypeScript CLI agent inspired by pi-agent's agent loop: model response → tool calls → tool results → next model response → final answer.

## Run

Requires Node.js 20+.

```sh
npm install
# Copy .env.example to .env and fill in your API key/model
npm run dev
```

Optional environment variables: `OPENAI_BASE_URL` (defaults to OpenAI's v1 API) and `MODEL` (defaults to `gpt-4o-mini`). The endpoint must support OpenAI Chat Completions tool calling.

The agent exposes three coding-agent file tools: `read`, `write`, and `edit`, plus `bash`. File tools are restricted to the current working directory. On Windows, `bash` looks for Git Bash in common installation paths (or `GIT_BASH_PATH`). If Git Bash is missing, it reports an install link and `winget` command; it does not silently install software or change the system.

Sessions are persisted in SQLite at `data/agent.sqlite`. Messages are stored as parent-linked nodes. On startup, choose an existing session, then press Enter to resume the latest node, use `r<number>` to resume a specific node, or `f<number>` to fork that node into a new session. Set `SESSION_DB` to use another database path.

## Loop shape

`Agent.run()` is an async event generator. It keeps a conversation message list, asks the model for its next message, executes all returned tool calls, appends tool results, and loops until there are no more tool calls. A turn limit prevents runaway loops; tool failures are returned to the model as tool results. The CLI is only a thin consumer of those events.

The OpenAI-compatible adapter supports streaming. Text is emitted as `text_delta` events and printed immediately by the CLI. Tool-call fragments are accumulated until a complete call is available, then the normal tool loop continues. Models without a `stream()` implementation use the non-streaming `complete()` fallback.
