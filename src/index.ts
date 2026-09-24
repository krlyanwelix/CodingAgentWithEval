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
    console.log(`${index + 1}. ${session.id}  (${session.messageCount} messages, updated ${updated})`);
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

const history = sessionStore.getMessages(sessionId);
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
    sessionStore.appendMessage(sessionId, { role: "user", content: input });
    for await (const event of agent.run(input)) {
      if (event.type === "message_end") sessionStore.appendMessage(sessionId, event.message);
      if (event.type === "tool_start") console.log(`\n[tool] ${event.toolCall.function.name}`);
      if (event.type === "tool_end") {
        sessionStore.appendMessage(sessionId, { role: "tool", tool_call_id: event.toolCall.id, content: event.result });
        console.log(`[result] ${event.result}`);
      }
      if (event.type === "agent_end") console.log(`\nagent> ${event.message.content ?? ""}\n`);
    }
  } catch (error) {
    console.error(`\nagent error> ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
terminal.close();
sessionStore.close();
