import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Agent } from "./agent.js";
import { OpenAICompatibleModel } from "./model.js";
import { tools } from "./tools.js";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Missing OPENAI_API_KEY. Copy .env.example to .env and set your key (or export it in your shell).");
  process.exit(1);
}

const agent = new Agent({
  model: new OpenAICompatibleModel(
    apiKey,
    process.env.MODEL ?? "gpt-4o-mini",
    process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  ),
  tools,
  systemPrompt: "You are a helpful assistant. Use tools when they help answer the user. Be concise.",
});

const terminal = createInterface({ input: stdin, output: stdout });
console.log("Tiny Agent ready. Type /exit to quit.\n");

while (true) {
  const input = (await terminal.question("you> ")).trim();
  if (input === "/exit" || input === "/quit") break;
  if (!input) continue;

  try {
    for await (const event of agent.run(input)) {
      if (event.type === "tool_start") console.log(`\n[tool] ${event.toolCall.function.name}`);
      if (event.type === "tool_end") console.log(`[result] ${event.result}`);
      if (event.type === "agent_end") console.log(`\nagent> ${event.message.content ?? ""}\n`);
    }
  } catch (error) {
    console.error(`\nagent error> ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
terminal.close();
