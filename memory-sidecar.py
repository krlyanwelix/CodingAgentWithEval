import os
import time
from pathlib import Path
from typing import Any, Callable

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

PROJECT_ROOT = Path(__file__).resolve().parent
load_dotenv(PROJECT_ROOT / ".env")
os.environ.setdefault("MEM0_DIR", str(PROJECT_ROOT / ".mem0"))
os.environ.setdefault("MEM0_TELEMETRY", "false")

from mem0 import Memory


def make_memory() -> Memory:
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
    # Mem0 performs extraction, conflict resolution, deduplication, and retrieval.
    # Qdrant runs embedded and persists its index locally; no separate server is needed.
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


class Message(BaseModel):
    role: str
    content: str


class AddRequest(BaseModel):
    messages: list[Message]
    user_id: str = "local-user"
    run_id: str | None = None


class SearchRequest(BaseModel):
    query: str
    user_id: str = "local-user"
    limit: int = Field(default=5, ge=1, le=50)


class UserRequest(BaseModel):
    user_id: str = "local-user"


class DeleteRequest(BaseModel):
    memory_id: str
    user_id: str = "local-user"


def as_dict(model: BaseModel) -> dict[str, Any]:
    dump = getattr(model, "model_dump", None)
    return dump() if callable(dump) else model.dict()


app = FastAPI(title="LilPiAgent Mem0 Memory")
memory: Memory | None = None


@app.on_event("startup")
def startup() -> None:
    global memory
    memory = make_memory()


def instance() -> Memory:
    if memory is None:
        raise HTTPException(status_code=503, detail="Mem0 is not initialized")
    return memory


def with_retries(operation: Callable[[], Any], attempts: int = 3) -> Any:
    """Embedding and LLM endpoints occasionally drop a TLS handshake; retry briefly."""
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            return operation()
        except Exception as error:  # noqa: BLE001 - the API layer reports the final error
            last_error = error
            if attempt + 1 < attempts:
                time.sleep(1 + attempt)
    raise HTTPException(status_code=502, detail=f"Mem0 backend failed after {attempts} attempts: {last_error}")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok" if memory is not None else "starting"}


@app.post("/v1/memories/add")
def add(request: AddRequest) -> Any:
    options: dict[str, Any] = {"user_id": request.user_id}
    if request.run_id:
        options["run_id"] = request.run_id
    messages = [as_dict(item) for item in request.messages]
    return {"result": with_retries(lambda: instance().add(messages, **options))}


@app.post("/v1/memories/search")
def search(request: SearchRequest) -> Any:
    return with_retries(lambda: instance().search(request.query, filters={"user_id": request.user_id}, top_k=request.limit))


@app.post("/v1/memories/list")
def list_memories(request: UserRequest) -> Any:
    return instance().get_all(filters={"user_id": request.user_id})


@app.post("/v1/memories/delete")
def delete(request: DeleteRequest) -> Any:
    memory_item = instance().get(request.memory_id)
    if memory_item is None or memory_item.get("user_id") != request.user_id:
        raise HTTPException(status_code=404, detail="Memory not found")
    return {"result": instance().delete(request.memory_id)}


@app.post("/v1/memories/clear")
def clear(request: UserRequest) -> Any:
    return {"result": instance().delete_all(user_id=request.user_id)}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("MEM0_HOST", "127.0.0.1"), port=int(os.environ.get("MEM0_PORT", "8765")))
