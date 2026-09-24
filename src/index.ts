import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Agent } from "./agent.js";
import { OpenAICompatibleModel } from "./model.js";
import { tools } from "./tools.js";
import { SessionStore } from "./session-store.js";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Missing OPENAI_API_KEY. Copy .env.example to .env and set your key (or export it in your shell).");
  process.exit(1);
}

const modelName = process.env.MODEL ?? "gpt-4o-mini";
const sessionStore = new SessionStore(process.env.SESSION_DB ?? "data/agent.sqlite");
const terminal = createInterface({ input: stdin, output: stdout });

const existingSessions = sessionStore.listSessions();
let sessionId: string;
if (existingSessions.length === 0) {
  sessionId = sessionStore.createSession();
  console.log("No existing sessions. Created a new session.\n");
} else {
  console.log("\nExisting sessions:");
  existingSessions.forEach((session, index) => {
    const updated = new Date(session.updatedAt).toLocaleString();
    console.log(`${index + 1}. ${session.id}  (${session.nodeCount} nodes, updated ${updated})`);
  });
  while (true) {
    const choice = (await terminal.question("Resume a session by number, or enter n for a new session: ")).trim().toLowerCase();
    if (choice === "n" || choice === "new") {
      sessionId = sessionStore.createSession();
      break;
    }
    const index = Number.parseInt(choice, 10) - 1;
    if (Number.isInteger(index) && index >= 0 && index < existingSessions.length) {
      sessionId = existingSessions[index].id;
      break;
    }
    console.log("Please enter a listed number or n.");
  }
}

let nodes = sessionStore.listNodes(sessionId);
let currentNodeId: string | null = nodes.length > 0 ? nodes[nodes.length - 1].id : null;
if (nodes.length > 0) {
  console.log("\nConversation nodes:");
  nodes.forEach((node, index) => {
    const preview = (node.content ?? "").replace(/\s+/g, " ").slice(0, 70);
    console.log(`${index + 1}. [${node.role}] ${preview}${(node.content ?? "").length > 70 ? "..." : ""}`);
  });
  while (true) {
    const choice = (await terminal.question("Resume a node (r<number>), fork it into a new session (f<number>), or press Enter for the latest: ")).trim().toLowerCase();
    if (choice === "") break;
    const match = choice.match(/^([rf])\s*(\d+)$/);
    if (!match) { console.log("Please use r1, f1, or press Enter."); continue; }
    const index = Number.parseInt(match[2], 10) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= nodes.length) { console.log("That node number does not exist."); continue; }
    if (match[1] === "f") {
      const fork = sessionStore.forkFromNode(nodes[index].id);
      sessionId = fork.sessionId;
      currentNodeId = fork.nodeId;
      console.log(`Forked into session ${sessionId}.`);
    } else {
      currentNodeId = nodes[index].id;
    }
    break;
  }
}
const history = currentNodeId ? sessionStore.getPath(currentNodeId) : [];
const agent = new Agent({
  model: new OpenAICompatibleModel(
    apiKey,
    modelName,
    process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  ),
  tools,
  history,
  systemPrompt: `You are a helpful assistant. 
  You are running on the model: ${modelName}.
  Use tools when they help answer the user. Be concise.`,
});

console.log(`Agent ready. Session: ${sessionId}. Type /exit to quit.\n`);

while (true) {
  const input = (await terminal.question("you> ")).trim();
  if (input === "/exit" || input === "/quit") break;
  if (!input) continue;

  try {
    currentNodeId = sessionStore.appendNode(sessionId, currentNodeId, { role: "user", content: input });
    let streamedText = false;
    for await (const event of agent.run(input)) {
      if (event.type === "text_delta") {
        stdout.write(event.text);
        streamedText = true;
      }
      if (event.type === "message_end") currentNodeId = sessionStore.appendNode(sessionId, currentNodeId, event.message);
      if (event.type === "tool_start") console.log(`\n[tool] ${event.toolCall.function.name}`);
      if (event.type === "tool_end") {
        currentNodeId = sessionStore.appendNode(sessionId, currentNodeId, { role: "tool", tool_call_id: event.toolCall.id, content: event.result });
        console.log(`[result] ${event.result}`);
      }
      if (event.type === "agent_end") {
        if (streamedText) console.log("\n");
        else console.log(`\nagent> ${event.message.content ?? ""}\n`);
      }
    }
  } catch (error) {
    console.error(`\nagent error> ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
terminal.close();
sessionStore.close();
