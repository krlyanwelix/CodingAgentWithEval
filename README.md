# Holy Agent

Minimal TypeScript CLI agent inspired by pi-agent:

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

The chat model uses an OpenAI-compatible endpoint:

```env
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.deepseek.com/v1
MODEL=deepseek-chat
```

## Tools and Skills

Built-in tools: `read`, `write`, `edit`, and `bash`. File tools stay inside the current working directory. Bash requires confirmation.

External tools go in `tools/`; Skills go in `skills/**/SKILL.md`. Skills use progressive disclosure: metadata is loaded at startup and full instructions are loaded through `load_skill`.

```env
AGENT_TOOLS_DIR=tools
AGENT_SKILLS_DIR=skills
EXA_API_KEY=...
```

## Sessions

Sessions are stored as a tree in SQLite at `data/agent.sqlite`. On startup, choose a session, then resume a node with `r<number>` or fork it with `f<number>`.

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

## Development

```sh
npm run build
npm start
```

## Web UI

The lightweight web mode uses the TypeScript HTTP server, a static SPA, and SSE for streamed responses. New sessions can have a display-only name, and the sidebar shows/searches Mem0 long-term memories.

```sh
python memory-sidecar.py
npm run dev:web
```

Open `http://127.0.0.1:3000`. For a production-style run, use `npm run build` followed by `npm run start:web`.
