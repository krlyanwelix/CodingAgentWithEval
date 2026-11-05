#!/usr/bin/env python3
"""execd — lightweight data-plane service that runs inside a sandbox.

Standard library only, so the sandbox image needs nothing installed. It is the
only thing the control plane may talk to *inside* the workload; Docker's own
exec API is never exposed. Replacing Docker with a microVM leaves this file and
its HTTP contract unchanged.

Contract (see sandbox/README.md):
  GET  /ping                     health, requires the access token
  POST /command                  {"command": "..."} -> text/event-stream
                                 events: stdout, stderr, exit(core: {code})
  GET  /file?path=...            read a file ({"content", "encoding", "size"})
  PUT  /file                     {"path", "content", "encoding"?} write a file
  GET  /directory?path=...       list a directory

Every request must send `X-EXECD-ACCESS-TOKEN`, injected by the control plane
at create time.
"""

from __future__ import annotations

import base64
import hmac
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.realpath(os.environ.get("EXECD_ROOT", "/workspace"))
TOKEN = os.environ.get("EXECD_ACCESS_TOKEN", "")
PORT = int(os.environ.get("EXECD_PORT", "8765"))
HOST = os.environ.get("EXECD_HOST", "0.0.0.0")
MAX_BODY_BYTES = 1024 * 1024
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_OUTPUT_BYTES = 512 * 1024
DEFAULT_TIMEOUT_MS = 120_000
STARTED_AT = time.time()

IS_WINDOWS = os.name == "nt"
SHELL = os.environ.get("EXECD_SHELL") or (os.environ.get("COMSPEC", "cmd.exe") if IS_WINDOWS else "/bin/sh")


class ExecdError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def resolve_path(raw: str | None, field: str = "path") -> str:
    """Resolve a request path and keep it inside ROOT (symlinks included)."""
    if not raw:
        raise ExecdError(400, "invalid_request", f"{field} is required")
    candidate = raw if os.path.isabs(raw) else os.path.join(ROOT, raw)
    real = os.path.realpath(candidate)
    if real != ROOT and not real.startswith(ROOT + os.sep):
        raise ExecdError(403, "path_outside_root", f"{field} escapes the sandbox root: {raw}")
    return real


def shell_argv(command: str) -> list[str]:
    if IS_WINDOWS:
        return [SHELL, "/d", "/s", "/c", command]
    return [SHELL, "-c", command]


class ExecdHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    # -- plumbing ---------------------------------------------------------
    def log_message(self, fmt: str, *args) -> None:  # keep stdout clean
        pass

    def do_GET(self) -> None:
        self.dispatch("GET")

    def do_POST(self) -> None:
        self.dispatch("POST")

    def do_PUT(self) -> None:
        self.dispatch("PUT")

    def dispatch(self, method: str) -> None:
        try:
            self.authenticate()
            parsed = urlparse(self.path)
            query = parse_qs(parsed.query)
            if parsed.path == "/ping" and method == "GET":
                self.send_json(200, {"ok": True, "pid": os.getpid(), "root": ROOT, "uptimeMs": int((time.time() - STARTED_AT) * 1000)})
            elif parsed.path == "/command" and method == "POST":
                self.handle_command()
            elif parsed.path == "/file" and method == "GET":
                self.handle_read_file(query)
            elif parsed.path == "/file" and method == "PUT":
                self.handle_write_file()
            elif parsed.path == "/directory" and method == "GET":
                self.handle_directory(query)
            else:
                raise ExecdError(404, "not_found", f"no route for {method} {parsed.path}")
        except ExecdError as error:
            self.send_error_json(error)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:  # noqa: BLE001 - data plane must answer, not crash
            try:
                self.send_error_json(ExecdError(500, "internal", str(error)))
            except (BrokenPipeError, ConnectionResetError):
                pass

    def authenticate(self) -> None:
        supplied = self.headers.get("X-EXECD-ACCESS-TOKEN", "")
        if not hmac.compare_digest(supplied, TOKEN):
            raise ExecdError(401, "unauthorized", "missing or invalid X-EXECD-ACCESS-TOKEN")

    def read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length > MAX_BODY_BYTES:
            raise ExecdError(413, "body_too_large", f"body exceeds {MAX_BODY_BYTES} bytes")
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ExecdError(400, "invalid_json", "request body is not valid JSON")
        if not isinstance(body, dict):
            raise ExecdError(400, "invalid_json", "request body must be a JSON object")
        return body

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, error: ExecdError) -> None:
        try:
            self.send_json(error.status, {"error": {"code": error.code, "message": error.message}})
        except (BrokenPipeError, ConnectionResetError):
            pass

    # -- /command ---------------------------------------------------------
    def handle_command(self) -> None:
        body = self.read_body()
        command = body.get("command")
        if not isinstance(command, str) or not command.strip():
            raise ExecdError(400, "invalid_request", "command must be a non-empty string")
        cwd = resolve_path(body.get("cwd") or ROOT, "cwd")
        timeout_ms = int(body.get("timeoutMs") or DEFAULT_TIMEOUT_MS)
        extra_env = body.get("env") or {}
        env = {**os.environ, **{str(k): str(v) for k, v in extra_env.items()}}

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        try:
            process = subprocess.Popen(
                shell_argv(command),
                cwd=cwd,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=not IS_WINDOWS,
            )
        except OSError as error:
            self.send_event("exit", {"code": 127, "error": str(error)})
            return

        events: "queue.Queue[tuple[str, object]]" = queue.Queue()

        def pump(stream, name: str) -> None:
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    break
                events.put((name, chunk))
            stream.close()

        readers = [
            threading.Thread(target=pump, args=(process.stdout, "stdout"), daemon=True),
            threading.Thread(target=pump, args=(process.stderr, "stderr"), daemon=True),
        ]
        for reader in readers:
            reader.start()

        def wait_for_exit() -> None:
            for reader in readers:
                reader.join()
            events.put(("exit", process.wait()))

        threading.Thread(target=wait_for_exit, daemon=True).start()

        sent = 0
        deadline = time.monotonic() + timeout_ms / 1000
        timed_out = False
        try:
            while True:
                timeout = max(0.05, deadline - time.monotonic()) if not timed_out else None
                try:
                    kind, value = events.get(timeout=timeout)
                except queue.Empty:
                    timed_out = True
                    self.kill(process)
                    self.send_event("stderr", {"chunk": f"\nexecd: command timed out after {timeout_ms}ms\n"})
                    continue
                if kind == "exit":
                    self.send_event("exit", {"code": value})
                    break
                if kind in ("stdout", "stderr"):
                    text = value.decode("utf-8", "replace")
                    sent += len(value)
                    if sent > MAX_OUTPUT_BYTES:
                        self.kill(process)
                        self.send_event("stderr", {"chunk": "\nexecd: output limit reached, process killed\n"})
                        self.send_event("exit", {"code": -1, "outputLimit": True})
                        break
                    self.send_event(kind, {"chunk": text})
        except (BrokenPipeError, ConnectionResetError):
            self.kill(process)

    @staticmethod
    def kill(process: subprocess.Popen) -> None:
        try:
            if IS_WINDOWS:
                process.kill()
            else:
                os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass

    def send_event(self, name: str, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False)
        self.wfile.write(f"event: {name}\ndata: {data}\n\n".encode("utf-8"))
        self.wfile.flush()

    # -- files ------------------------------------------------------------
    def handle_read_file(self, query: dict) -> None:
        path = resolve_path((query.get("path") or [""])[0])
        if not os.path.isfile(path):
            raise ExecdError(404, "not_found", f"not a file: {path}")
        size = os.path.getsize(path)
        if size > MAX_FILE_BYTES:
            raise ExecdError(413, "file_too_large", f"file exceeds {MAX_FILE_BYTES} bytes")
        encoding = (query.get("encoding") or ["utf-8"])[0]
        with open(path, "rb") as handle:
            raw = handle.read()
        if encoding == "base64":
            content = base64.b64encode(raw).decode("ascii")
        else:
            try:
                content = raw.decode("utf-8")
            except UnicodeDecodeError:
                raise ExecdError(400, "not_utf8", "file is not valid UTF-8; use encoding=base64")
        self.send_json(200, {"path": path, "size": size, "encoding": encoding, "content": content})

    def handle_write_file(self) -> None:
        body = self.read_body()
        path = resolve_path(body.get("path"), "path")
        content = body.get("content")
        if not isinstance(content, str):
            raise ExecdError(400, "invalid_request", "content must be a string")
        if body.get("encoding") == "base64":
            try:
                raw = base64.b64decode(content, validate=True)
            except Exception:  # noqa: BLE001
                raise ExecdError(400, "invalid_base64", "content is not valid base64")
        else:
            raw = content.encode("utf-8")
        os.makedirs(os.path.dirname(path) or ROOT, exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(raw)
        if body.get("mode") is not None:
            os.chmod(path, int(body["mode"], 8) if isinstance(body["mode"], str) else int(body["mode"]))
        self.send_json(200, {"path": path, "bytes": len(raw)})

    def handle_directory(self, query: dict) -> None:
        path = resolve_path((query.get("path") or [""])[0])
        if not os.path.isdir(path):
            raise ExecdError(404, "not_found", f"not a directory: {path}")
        entries = []
        with os.scandir(path) as scan:
            for entry in scan:
                try:
                    stat = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                entries.append(
                    {
                        "name": entry.name,
                        "type": "directory" if entry.is_dir(follow_symlinks=False) else "file",
                        "size": stat.st_size,
                        "mtimeMs": int(stat.st_mtime * 1000),
                    }
                )
        entries.sort(key=lambda item: (item["type"] != "directory", item["name"]))
        self.send_json(200, {"path": path, "entries": entries})


class ExecdServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    if not TOKEN:
        print("execd: EXECD_ACCESS_TOKEN must be set", file=sys.stderr)
        return 2
    os.makedirs(ROOT, exist_ok=True)
    server = ExecdServer((HOST, PORT), ExecdHandler)
    actual_port = server.server_address[1]
    print(f"execd listening on {HOST}:{actual_port} root={ROOT}", flush=True)

    def stop(_signum, _frame) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
