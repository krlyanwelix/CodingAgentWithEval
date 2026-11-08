"""Standalone long-term memory service for CodingAgentWithEval.

The agent talks to this process over a versioned HTTP contract and never imports
Mem0. That boundary is the point of the refactor:

* scope (user + project + session) is decided here, not in the agent loop;
* redaction, TTL, thresholds, dedupe and the audit log live here;
* the backend (Mem0 today) can be swapped without touching TypeScript;
* an outage degrades recall to "no memories" instead of failing a turn.

Run:   python memory-sidecar.py            (serves on MEMORY_PORT, default 8765)
Check: python memory-sidecar.py --self-test
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

from dotenv import load_dotenv
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, Field

PROJECT_ROOT = Path(__file__).resolve().parent
load_dotenv(PROJECT_ROOT / ".env")
os.environ.setdefault("MEM0_DIR", str(PROJECT_ROOT / ".mem0"))
os.environ.setdefault("MEM0_TELEMETRY", "false")

SERVICE_VERSION = "1.0"

# --------------------------------------------------------------------------
# Secrets never reach the vector store: memories are replayed into future
# prompts, so a leaked key would be permanent. Mirrors src/memory/redact.ts.
# --------------------------------------------------------------------------

REDACTION_RULES: list[tuple[str, re.Pattern[str], str]] = [
    (
        "private-key",
        re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----", re.S),
        "[redacted private key]",
    ),
    ("prefixed-key", re.compile(r"\b(?:sk|pk|rk)-[A-Za-z0-9._-]{12,}\b"), "[redacted key]"),
    ("aws-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[redacted aws key]"),
    ("github-token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"), "[redacted token]"),
    ("slack-token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"), "[redacted token]"),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"), "[redacted jwt]"),
    ("bearer", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*"), "Bearer [redacted]"),
    (
        "assignment",
        re.compile(
            r"(?<![A-Za-z0-9])(api[_-]?key|apikey|secret|token|password|passwd|pwd|access[_-]?key|private[_-]?key)"
            r"(\s*[:=]\s*)(\"[^\"\n]{4,}\"|'[^'\n]{4,}'|[^\s,;]{6,})",
            re.I,
        ),
        r"\1\2[redacted]",
    ),
]


def redact_secrets(text: str) -> tuple[str, int]:
    count = 0
    for _name, pattern, replacement in REDACTION_RULES:
        text, hits = pattern.subn(replacement, text)
        count += hits
    return text, count


def normalize_text(text: str) -> str:
    text = text.replace("\r\n", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def text_digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:16]


# --------------------------------------------------------------------------
# Audit log: append-only JSONL, metadata only (never the memory text itself).
# --------------------------------------------------------------------------

AUDIT_PATH = Path(os.environ.get("MEMORY_AUDIT_PATH", "data/memory-audit.jsonl"))
if not AUDIT_PATH.is_absolute():
    AUDIT_PATH = PROJECT_ROOT / AUDIT_PATH
_AUDIT_LOCK = threading.Lock()


def audit(action: str, **fields: Any) -> None:
    record = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "action": action}
    record.update({key: value for key, value in fields.items() if value is not None})
    try:
        AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
        with _AUDIT_LOCK:
            with AUDIT_PATH.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        pass  # auditing must never take the service down


# --------------------------------------------------------------------------
# Mem0 backend
# --------------------------------------------------------------------------

TTL_DAYS = int(os.environ.get("MEMORY_TTL_DAYS", "0"))
MAX_HITS = 50
MAX_TEXT_CHARS = 2000
_DEDUPE_TTL_SECONDS = 300
_dedupe: dict[str, float] = {}
_DEDUPE_LOCK = threading.Lock()
_MEMORY_LOCK = threading.Lock()


class Message(BaseModel):
    role: str
    content: str


class WriteRequest(BaseModel):
    text: str | None = None
    messages: list[Message] | None = None
    user_id: str = "local-user"
    project_id: str | None = None
    session_id: str | None = None
    kind: str | None = None
    infer: bool = True
    ttl_days: int | None = None


class SearchRequest(BaseModel):
    query: str
    user_id: str = "local-user"
    project_id: str | None = None
    limit: int = Field(default=5, ge=1, le=MAX_HITS)
    min_score: float = 0.35
    budget_chars: int = 900


class ClearRequest(BaseModel):
    user_id: str = "local-user"
    project_id: str | None = None


class LegacyAddRequest(BaseModel):
    messages: list[Message]
    user_id: str = "local-user"
    project_id: str | None = None
    run_id: str | None = None


class LegacyUserRequest(BaseModel):
    user_id: str = "local-user"
    project_id: str | None = None


class LegacyDeleteRequest(BaseModel):
    memory_id: str
    user_id: str = "local-user"


class MemoryBackend:
    """Wraps Mem0 so the HTTP layer never sees provider details."""

    def __init__(self) -> None:
        self.memory: Any | None = None
        self.error: str | None = None
        self.started_at = time.time()
        self.vector_path = os.environ.get("MEM0_VECTOR_PATH", "data/mem0-qdrant")

    def initialize(self) -> None:
        try:
            self.memory = make_memory()
            self.error = None
        except Exception as error:  # noqa: BLE001 - reported through /health
            self.memory = None
            self.error = f"{type(error).__name__}: {error}"
            audit("startup_error", error=self.error)

    def require(self) -> Any:
        if self.memory is None:
            raise HTTPException(status_code=503, detail=f"memory backend unavailable: {self.error or 'not initialized'}")
        return self.memory

    def call(self, operation: Callable[[], Any], attempts: int = 3) -> Any:
        last_error: Exception | None = None
        for attempt in range(attempts):
            try:
                with _MEMORY_LOCK:
                    return operation()
            except HTTPException:
                raise
            except Exception as error:  # noqa: BLE001 - retried, then reported
                last_error = error
                if attempt + 1 < attempts:
                    time.sleep(1 + attempt)
        raise HTTPException(status_code=502, detail=f"memory backend failed after {attempts} attempts: {last_error}")


def make_memory() -> Any:
    from mem0 import Memory

    llm_api_key = os.environ.get("MEM0_LLM_API_KEY") or os.environ.get("OPENAI_API_KEY") or os.environ.get("OPENROUTER_API_KEY")
    embedding_api_key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("EMBEDDING_API_KEY")
    if not llm_api_key or not embedding_api_key:
        raise RuntimeError("MEM0_LLM_API_KEY/OPENAI_API_KEY and OPENROUTER_API_KEY/EMBEDDING_API_KEY are required")

    model_base_url = os.environ.get("MEM0_LLM_BASE_URL", os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"))
    embedding_base_url = os.environ.get("EMBEDDING_BASE_URL", "https://openrouter.ai/api/v1")
    embedding_model = os.environ.get("EMBEDDING_MODEL", "nvidia/nemotron-3-embed-1b:free")
    vector_path = Path(os.environ.get("MEM0_VECTOR_PATH", "data/mem0-qdrant"))
    if not vector_path.is_absolute():
        vector_path = PROJECT_ROOT / vector_path

    config = {
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "path": str(vector_path),
                "collection_name": os.environ.get("MEM0_COLLECTION", "memories"),
                "embedding_model_dims": int(os.environ.get("MEM0_EMBEDDING_DIMS", "2048")),
                "on_disk": True,
            },
        },
        "llm": {
            "provider": "openai",
            "config": {
                "model": os.environ.get("MEM0_LLM_MODEL", os.environ.get("MODEL", "gpt-4o-mini")),
                "api_key": llm_api_key,
                "openai_base_url": model_base_url,
                "temperature": 0.1,
            },
        },
        "embedder": {
            "provider": "openai",
            "config": {
                "model": embedding_model,
                "api_key": embedding_api_key,
                "openai_base_url": embedding_base_url,
            },
        },
    }
    return Memory.from_config(config)


def hit_from_item(item: dict[str, Any]) -> dict[str, Any] | None:
    metadata = item.get("metadata") or {}
    text = item.get("memory") or item.get("text") or item.get("content")
    if not text:
        return None
    return {
        "id": item.get("id"),
        "text": text,
        "score": float(item.get("score") or 0.0),
        "created_at": item.get("created_at") or metadata.get("created_at"),
        "kind": metadata.get("kind"),
        "project_id": metadata.get("project_id"),
    }


def in_scope(item: dict[str, Any], project_id: str | None) -> bool:
    if not project_id:
        return True
    metadata = item.get("metadata") or {}
    return metadata.get("project_id") in (project_id, None)


def dedupe_hit(key: str) -> bool:
    """True when the same text was written seconds ago — skip the model call."""
    now = time.time()
    with _DEDUPE_LOCK:
        for stale in [k for k, ts in _dedupe.items() if now - ts > _DEDUPE_TTL_SECONDS]:
            _dedupe.pop(stale, None)
        if key in _dedupe:
            return True
        _dedupe[key] = now
        return False


backend = MemoryBackend()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    backend.initialize()
    yield


app = FastAPI(title="CodingAgentWithEval Memory Service", version=SERVICE_VERSION, lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, Any]:
    ok = backend.memory is not None
    return {
        "status": "ok" if ok else "degraded",
        "version": SERVICE_VERSION,
        "backend": "mem0",
        "vector_path": backend.vector_path,
        "ttl_days": TTL_DAYS,
        "error": backend.error,
        "uptime_seconds": round(time.time() - backend.started_at, 1),
    }


@app.post("/v1/memories")
def write(request: WriteRequest) -> dict[str, Any]:
    started = time.time()
    raw_text = request.text
    raw_messages = [message.model_dump() for message in (request.messages or [])]
    if raw_text is None and not raw_messages:
        raise HTTPException(status_code=400, detail="text or messages is required")

    source = raw_text if raw_text is not None else "\n".join(m["content"] for m in raw_messages)
    redacted, redactions = redact_secrets(normalize_text(source))
    redacted = redacted[:MAX_TEXT_CHARS]
    if not redacted:
        raise HTTPException(status_code=400, detail="empty memory after normalization")

    key = text_digest(f"{request.user_id}|{request.project_id}|{redacted}")
    if dedupe_hit(key):
        audit("write_skipped", user_id=request.user_id, project_id=request.project_id, reason="duplicate", text_sha=key)
        return {"written": [], "skipped": [{"reason": "duplicate"}]}

    metadata = {
        "project_id": request.project_id,
        "session_id": request.session_id,
        "kind": request.kind or "note",
        "source": "agent",
    }
    ttl_days = request.ttl_days if request.ttl_days is not None else TTL_DAYS
    expiration = (datetime.now(timezone.utc) + timedelta(days=ttl_days)).isoformat() if ttl_days and ttl_days > 0 else None

    if raw_text is not None and not request.infer:
        # Verbatim path (explicit /remember): deterministic, no model call.
        payload: Any = [{"role": "user", "content": redacted}]
        infer = False
    else:
        payload = raw_messages if raw_messages else [{"role": "user", "content": redacted}]
        infer = request.infer

    options: dict[str, Any] = {"user_id": request.user_id, "metadata": metadata, "infer": infer}
    if request.session_id:
        options["run_id"] = request.session_id
    if expiration:
        options["expiration_date"] = expiration

    try:
        result = backend.call(lambda: backend.require().add(payload, **options))
    except HTTPException as error:
        audit("write_error", user_id=request.user_id, project_id=request.project_id, error=str(error.detail), text_sha=key)
        raise

    written = [{"id": entry.get("id"), "text": entry.get("memory") or entry.get("text")}
               for entry in (result or {}).get("results", []) if isinstance(entry, dict)]
    audit(
        "write",
        user_id=request.user_id,
        project_id=request.project_id,
        session_id=request.session_id,
        count=len(written),
        redactions=redactions,
        infer=infer,
        text_sha=key,
        latency_ms=round((time.time() - started) * 1000, 1),
    )
    return {"written": written, "skipped": []}


@app.post("/v1/memories/search")
def search(request: SearchRequest) -> dict[str, Any]:
    started = time.time()
    query = normalize_text(request.query)[:MAX_TEXT_CHARS]
    if not query:
        return {"hits": [], "used_chars": 0}
    try:
        raw = backend.call(
            lambda: backend.require().search(
                query,
                filters={"user_id": request.user_id},
                top_k=min(max(request.limit * 4, request.limit), MAX_HITS),
                threshold=max(0.0, min(1.0, request.min_score)),
            )
        )
    except HTTPException as error:
        audit("search_error", user_id=request.user_id, project_id=request.project_id, error=str(error.detail))
        raise

    items = raw.get("results", []) if isinstance(raw, dict) else raw
    hits: list[dict[str, Any]] = []
    for item in items or []:
        if not isinstance(item, dict) or not in_scope(item, request.project_id):
            continue
        hit = hit_from_item(item)
        if hit is None or hit["score"] < request.min_score:
            continue
        hits.append(hit)

    hits.sort(key=lambda hit: hit["score"], reverse=True)
    selected: list[dict[str, Any]] = []
    used = 0
    for hit in hits[: request.limit]:
        cost = len(hit["text"])
        if selected and used + cost > request.budget_chars:
            break
        selected.append(hit)
        used += cost

    audit(
        "search",
        user_id=request.user_id,
        project_id=request.project_id,
        count=len(selected),
        min_score=request.min_score,
        latency_ms=round((time.time() - started) * 1000, 1),
    )
    return {"hits": selected, "used_chars": used}


@app.get("/v1/memories")
def list_memories(
    user_id: str = "local-user",
    project_id: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
) -> dict[str, Any]:
    try:
        raw = backend.call(lambda: backend.require().get_all(filters={"user_id": user_id}))
    except HTTPException as error:
        audit("list_error", user_id=user_id, error=str(error.detail))
        raise
    items = raw.get("results", []) if isinstance(raw, dict) else raw
    hits: list[dict[str, Any]] = []
    for item in items or []:
        if not isinstance(item, dict) or not in_scope(item, project_id):
            continue
        hit = hit_from_item(item)
        if hit is not None:
            hits.append(hit)
    hits.sort(key=lambda hit: hit.get("created_at") or "", reverse=True)
    return {"hits": hits[:limit], "total": len(hits)}


@app.delete("/v1/memories/{memory_id}")
def delete(memory_id: str, user_id: str = "local-user") -> dict[str, Any]:
    item = backend.call(lambda: backend.require().get(memory_id))
    if not item or item.get("user_id") != user_id:
        raise HTTPException(status_code=404, detail="memory not found in this scope")
    result = backend.call(lambda: backend.require().delete(memory_id))
    audit("delete", user_id=user_id, memory_id=memory_id)
    return {"deleted": memory_id, "result": result}


@app.post("/v1/memories/clear")
def clear(request: ClearRequest) -> dict[str, Any]:
    result = backend.call(lambda: backend.require().delete_all(user_id=request.user_id))
    audit("clear", user_id=request.user_id, project_id=request.project_id)
    return {"result": result}


@app.get("/v1/audit")
def audit_tail(limit: int = Query(default=50, ge=1, le=500)) -> dict[str, Any]:
    if not AUDIT_PATH.exists():
        return {"records": []}
    with AUDIT_PATH.open("r", encoding="utf-8") as handle:
        lines = handle.readlines()[-limit:]
    records = []
    for line in lines:
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return {"records": records}


@app.post("/v1/maintenance/expire")
def expire() -> dict[str, Any]:
    """Mem0 hides expired entries at query time; this endpoint reports policy only."""
    return {"ttl_days": TTL_DAYS, "mode": "lazy", "note": "expired memories are filtered by Mem0 on read"}


# --------------------------------------------------------------------------
# Legacy endpoints: the previous sidecar contract. Kept so older clients and
# scripts keep working; the agent uses /v1/memories.
# --------------------------------------------------------------------------


@app.post("/v1/memories/add")
def legacy_add(request: LegacyAddRequest) -> Any:
    return write(
        WriteRequest(
            messages=request.messages,
            user_id=request.user_id,
            project_id=request.project_id,
            session_id=request.run_id,
            infer=True,
        )
    )


@app.post("/v1/memories/list")
def legacy_list(request: LegacyUserRequest) -> Any:
    return list_memories(user_id=request.user_id, project_id=request.project_id)


@app.post("/v1/memories/delete")
def legacy_delete(request: LegacyDeleteRequest) -> Any:
    return delete(request.memory_id, user_id=request.user_id)


# --------------------------------------------------------------------------
# Self-test: proves the pure parts (redaction, scope, dedupe) without Mem0.
# --------------------------------------------------------------------------


def self_test() -> int:
    failures: list[str] = []

    def check(name: str, condition: bool) -> None:
        if not condition:
            failures.append(name)

    sample = "my key is sk-ws-H.YEMLRRI.KH81.MEQCIDCDT9X4jm41BTMPigfyWACCqIbvvhQowKIzWxGHWWvqAiBAeCBbKcrC6vP9J_-MC8wlGT22FoCmyerhThemqgQ-Rg ok"
    clean, count = redact_secrets(sample)
    check("redacts sk- key", "sk-ws-" not in clean)
    check("counts redactions", count == 1)

    private_key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----"
    clean, _ = redact_secrets(private_key)
    check("redacts private key block", "MIIEow" not in clean)

    assignment = 'OPENAI_API_KEY=abcdef123456 and password: "hunter2hunter2"'
    clean, _ = redact_secrets(assignment)
    check("redacts env assignment", "abcdef123456" not in clean)
    check("redacts password", "hunter2hunter2" not in clean)

    check("normalizes whitespace", normalize_text("a  b\r\n\r\n\r\nc") == "a b\n\nc")
    check("dedupe detects duplicate", dedupe_hit("k1") is False and dedupe_hit("k1") is True)
    check("scope filters project", in_scope({"metadata": {"project_id": "other"}}, "mine") is False)
    check("scope allows unscoped", in_scope({"metadata": {}}, "mine") is True)

    if failures:
        print("self-test FAILED: " + ", ".join(failures))
        return 1
    print("self-test passed")
    return 0


if __name__ == "__main__":
    import sys

    if "--self-test" in sys.argv:
        raise SystemExit(self_test())

    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("MEMORY_HOST", os.environ.get("MEM0_HOST", "127.0.0.1")),
        port=int(os.environ.get("MEMORY_PORT", os.environ.get("MEM0_PORT", "8765"))),
        log_level=os.environ.get("MEMORY_LOG_LEVEL", "info"),
    )
