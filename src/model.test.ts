import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAICompatibleModel } from "./model.js";

async function startServer(handler: RequestListener): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

test("stream parses deltas, assembles tool calls, and ignores malformed lines", async () => {
  const { server, baseUrl } = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sse({ choices: [{ delta: { content: "Hello" } }] }));
    response.write(sse({ choices: [{ delta: { content: " world" } }] }));
    response.write("data: this is not json\n\n");
    response.write(
      sse({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"path":' } }],
            },
          },
        ],
      }),
    );
    response.write(
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }] }),
    );
    response.write("data: [DONE]\n\n");
    response.end();
  });

  try {
    const model = new OpenAICompatibleModel("test-key", "test-model", `${baseUrl}/v1`);
    let text = "";
    let finalMessage: import("./types.js").Message | undefined;
    for await (const event of model.stream([{ role: "user", content: "hi" }], [])) {
      if (event.type === "text_delta") text += event.text;
      else finalMessage = event.message;
    }

    assert.equal(text, "Hello world");
    assert.ok(finalMessage);
    assert.equal(finalMessage.tool_calls?.length, 1);
    assert.equal(finalMessage.tool_calls?.[0]?.id, "call_1");
    assert.equal(finalMessage.tool_calls?.[0]?.function.name, "read");
    assert.deepEqual(JSON.parse(finalMessage.tool_calls?.[0]?.function.arguments ?? "{}"), { path: "a.txt" });
  } finally {
    await closeServer(server);
  }
});

test("complete reports the HTTP status and body of a failed request", async () => {
  const { server, baseUrl } = await startServer((_request, response) => {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("boom");
  });

  try {
    const model = new OpenAICompatibleModel("test-key", "test-model", baseUrl);
    await assert.rejects(model.complete([{ role: "user", content: "hi" }], []), /500.*boom/s);
  } finally {
    await closeServer(server);
  }
});

test("complete returns the first choice message", async () => {
  const { server, baseUrl } = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "pong" } }] }));
  });

  try {
    const model = new OpenAICompatibleModel("test-key", "test-model", baseUrl);
    const message = await model.complete([{ role: "user", content: "ping" }], []);
    assert.equal(message.content, "pong");
  } finally {
    await closeServer(server);
  }
});

test("aborting the signal cancels a streaming request", async () => {
  const { server, baseUrl } = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sse({ choices: [{ delta: { content: "partial" } }] }));
    // Deliberately never end the response so the client has to cancel.
  });

  try {
    const model = new OpenAICompatibleModel("test-key", "test-model", baseUrl);
    const controller = new AbortController();
    const consume = async (): Promise<void> => {
      for await (const event of model.stream([{ role: "user", content: "hi" }], [], { signal: controller.signal })) {
        if (event.type === "text_delta") controller.abort();
      }
    };
    await assert.rejects(consume, /abort/i);
  } finally {
    await closeServer(server);
  }
});

test("idle timeout aborts a stream that stops producing data", async () => {
  const { server, baseUrl } = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sse({ choices: [{ delta: { content: "first" } }] }));
    // No further data; the client must time out.
  });

  try {
    const model = new OpenAICompatibleModel("test-key", "test-model", baseUrl);
    const consume = async (): Promise<void> => {
      for await (const event of model.stream([{ role: "user", content: "hi" }], [], { idleTimeoutMs: 100 })) {
        assert.equal(event.type, "text_delta");
      }
    };
    await assert.rejects(consume, /stalled|abort/i);
  } finally {
    await closeServer(server);
  }
});
