const state = { sessions: [], sessionId: null, nodeId: null, busy: false };
const $ = (id) => document.getElementById(id);
const sessionsEl = $("sessions"), messagesEl = $("messages"), inputEl = $("input"), sendEl = $("send");

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { "content-type": "application/json", ...(options.headers || {}) }, ...options });
  if (!response.ok) throw new Error(await response.text());
  return response.status === 204 ? null : response.json();
}

function sessionName(session) { return `Session ${session.id.slice(0, 8)}`; }
function renderSessions() {
  sessionsEl.innerHTML = "";
  for (const session of state.sessions) {
    const button = document.createElement("button"); button.className = `session-item ${session.id === state.sessionId ? "active" : ""}`;
    button.innerHTML = `${sessionName(session)}<small>${session.nodeCount} messages</small>`;
    button.onclick = () => selectSession(session.id); sessionsEl.append(button);
  }
}
function addMessage(role, content = "") {
  const empty = messagesEl.querySelector(".empty-state"); if (empty) empty.remove();
  const row = document.createElement("div"); row.className = `message ${role}`;
  const label = document.createElement("div"); label.className = "role-label"; label.textContent = role === "user" ? "You" : role === "tool" ? "Tool" : "Agent";
  const bubble = document.createElement("div"); bubble.className = "message-bubble"; bubble.textContent = content;
  if (role === "user") row.append(bubble, label); else row.append(label, bubble);
  messagesEl.append(row); messagesEl.scrollTop = messagesEl.scrollHeight; return bubble;
}
async function loadNodes() {
  const data = await request(`/api/sessions/${state.sessionId}/nodes`); messagesEl.innerHTML = "";
  if (!data.nodes.length) { messagesEl.innerHTML = `<div class="empty-state"><div class="empty-icon">✦</div><h1>What can I help with?</h1><p>Start a conversation with your agent.</p></div>`; return; }
  for (const node of data.nodes) if (node.content) addMessage(node.role, node.content);
  state.nodeId = data.nodes.at(-1)?.id ?? null;
}
async function selectSession(id) {
  state.sessionId = id; const session = state.sessions.find((item) => item.id === id); $("session-title").textContent = session ? sessionName(session) : "Session"; $("session-meta").textContent = "Ready"; renderSessions(); await loadNodes();
}
async function refreshSessions(select = true) { const data = await request("/api/sessions"); state.sessions = data.sessions; renderSessions(); if (select && state.sessions.length) await selectSession(state.sessionId && state.sessions.some((s) => s.id === state.sessionId) ? state.sessionId : state.sessions[0].id); }
async function createSession() { const data = await request("/api/sessions", { method: "POST", body: "{}" }); state.sessionId = data.sessionId; await refreshSessions(); }

async function sendMessage(event) {
  event.preventDefault(); const prompt = inputEl.value.trim(); if (!prompt || state.busy || !state.sessionId) return;
  state.busy = true; inputEl.value = ""; inputEl.style.height = "auto"; sendEl.disabled = true; addMessage("user", prompt); const bubble = addMessage("assistant", ""); $("session-meta").textContent = "Thinking...";
  try {
    const response = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: state.sessionId, nodeId: state.nodeId, input: prompt }) });
    if (!response.ok || !response.body) throw new Error(await response.text());
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
    while (true) { const part = await reader.read(); if (part.done) break; buffer += decoder.decode(part.value, { stream: true }); const chunks = buffer.split("\n\n"); buffer = chunks.pop() || ""; for (const chunk of chunks) { const line = chunk.split("\n").find((item) => item.startsWith("data: ")); if (!line) continue; const data = JSON.parse(line.slice(6)); if (data.type === "text_delta") { bubble.textContent += data.text; messagesEl.scrollTop = messagesEl.scrollHeight; } if (data.type === "tool_start") bubble.textContent += `\n[tool: ${data.toolCall.function.name}]`; if (data.type === "error") bubble.textContent += `\n${data.message}`; if (data.type === "done") state.nodeId = data.nodeId; } }
    await refreshSessions(false); await loadNodes(); $("session-meta").textContent = "Ready";
  } catch (error) { bubble.textContent = error instanceof Error ? error.message : String(error); $("session-meta").textContent = "Error"; }
  finally { state.busy = false; sendEl.disabled = false; inputEl.focus(); }
}

$("composer").addEventListener("submit", sendMessage); $("new-session").addEventListener("click", createSession); $("refresh").addEventListener("click", () => refreshSessions());
inputEl.addEventListener("input", () => { inputEl.style.height = "auto"; inputEl.style.height = `${Math.min(inputEl.scrollHeight, 150)}px`; });
inputEl.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); $("composer").requestSubmit(); } });
request("/api/health").then((health) => { $("health-dot").classList.toggle("ok", health.ok); $("health-text").textContent = health.memoryAvailable ? "Online · Memory on" : "Online · Memory off"; }).catch(() => { $("health-text").textContent = "Offline"; });
refreshSessions().catch((error) => { $("session-meta").textContent = error.message; });
