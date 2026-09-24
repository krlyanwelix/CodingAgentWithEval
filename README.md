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

Try `What time is it?` or `List the files in this project.` Type `/exit` to quit.

## Loop shape

`Agent.run()` is an async event generator. It keeps a conversation message list, asks the model for its next message, executes all returned tool calls, appends tool results, and loops until there are no more tool calls. A turn limit prevents runaway loops; tool failures are returned to the model as tool results. The CLI is only a thin consumer of those events.
