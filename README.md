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

## Loop shape

`Agent.run()` is an async event generator. It keeps a conversation message list, asks the model for its next message, executes all returned tool calls, appends tool results, and loops until there are no more tool calls. A turn limit prevents runaway loops; tool failures are returned to the model as tool results. The CLI is only a thin consumer of those events.
