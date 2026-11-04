import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./session-store.js";

function withStore(run: (store: SessionStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "session-store-test-"));
  const store = new SessionStore(join(dir, "agent.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("turns form a linear path and getPath replays user/assistant messages", () => {
  withStore((store) => {
    const sessionId = store.createSession();
    const first = store.createTurn(sessionId, null, "first question");
    store.completeTurn(first, "first answer", ["read", "read", "bash"]);
    const second = store.createTurn(sessionId, first, "second question");
    store.completeTurn(second, "second answer", []);

    const nodes = store.listNodes(sessionId);
    assert.equal(nodes.length, 2);
    assert.deepEqual(nodes[1]?.toolNames, []);
    assert.deepEqual(store.listNodes(sessionId)[0]?.toolNames, ["read", "bash"]);

    const path = store.getPath(second);
    assert.deepEqual(
      path.map((message) => message.role),
      ["user", "assistant", "user", "assistant"],
    );
    assert.equal(path[0]?.content, "first question");
    assert.equal(path[3]?.content, "second answer");
  });
});

test("getPath stops at the resumed node, not at the newest turn", () => {
  withStore((store) => {
    const sessionId = store.createSession();
    const first = store.createTurn(sessionId, null, "q1");
    store.completeTurn(first, "a1", []);
    const second = store.createTurn(sessionId, first, "q2");
    store.completeTurn(second, "a2", []);

    const path = store.getPath(first);
    assert.equal(path.length, 2);
    assert.equal(path[1]?.content, "a1");
  });
});

test("forkFromNode copies the ancestor chain into a new session", () => {
  withStore((store) => {
    const sessionId = store.createSession();
    const first = store.createTurn(sessionId, null, "q1");
    store.completeTurn(first, "a1", ["read"]);
    const second = store.createTurn(sessionId, first, "q2");
    store.completeTurn(second, "a2", []);

    const fork = store.forkFromNode(first);
    assert.notEqual(fork.sessionId, sessionId);
    const forkNodes = store.listNodes(fork.sessionId);
    assert.equal(forkNodes.length, 1);
    assert.equal(forkNodes[0]?.userContent, "q1");
    assert.equal(forkNodes[0]?.assistantContent, "a1");
    assert.equal(store.listNodes(sessionId).length, 2);
  });
});

test("completeTurn rejects an unknown turn", () => {
  withStore((store) => {
    assert.throws(() => store.completeTurn("missing", "answer", []), /Turn not found/);
  });
});

test("deleteSession removes its turns and the session row", () => {
  withStore((store) => {
    const sessionId = store.createSession("to delete");
    const turn = store.createTurn(sessionId, null, "q");
    store.completeTurn(turn, "a", []);
    assert.equal(store.deleteSession(sessionId), true);
    assert.equal(store.listSessions().some((session) => session.id === sessionId), false);
    assert.throws(() => store.getPath(turn), /Turn not found/);
  });
});

test("listSessions counts turns and reports the newest session first", () => {
  withStore((store) => {
    const older = store.createSession("older");
    store.completeTurn(store.createTurn(older, null, "q1"), "a1", []);
    const newer = store.createSession("newer");
    store.completeTurn(store.createTurn(newer, null, "q2"), "a2", []);
    const sessions = store.listSessions();
    assert.equal(sessions.length, 2);
    assert.equal(sessions.find((session) => session.id === newer)?.displayName, "newer");
    assert.ok(sessions.every((session) => session.nodeCount === 1));
    assert.ok(sessions[0]!.updatedAt >= sessions[1]!.updatedAt);
  });
});

test("closePendingTurns closes a turn that died before it answered", () => {
  withStore((store) => {
    const sessionId = store.createSession();
    const answered = store.createTurn(sessionId, null, "q1");
    store.completeTurn(answered, "a1", []);
    const interrupted = store.createTurn(sessionId, answered, "q2");

    assert.equal(store.closePendingTurns(sessionId), 1);
    const nodes = store.listNodes(sessionId);
    assert.equal(nodes[1]?.id, interrupted);
    assert.match(String(nodes[1]?.assistantContent), /中断/);

    const path = store.getPath(interrupted);
    assert.deepEqual(
      path.map((message) => message.role),
      ["user", "assistant", "user", "assistant"],
    );
    // Nothing left to close on a second pass.
    assert.equal(store.closePendingTurns(sessionId), 0);
  });
});
