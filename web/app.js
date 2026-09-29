const state = {
  sessions: [],
  sessionId: null,
  nodeId: null,
  nodes: [],
  busy: false,
  memories: [],
  contextSessionId: null,
};

const $ = (id) => document.getElementById(id);
const sessionsEl = $("sessions");
const messagesEl = $("messages");
const inputEl = $("input");
const sendEl = $("send");
const memoriesEl = $("memories");
const memoryQueryEl = $("memory-query");
const sessionDialog = $("session-dialog");
const sessionNameEl = $("session-name");
const treeDialog = $("tree-dialog");
const treeEl = $("tree");
const sessionMenu = $("session-menu");

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.status === 204 ? null : response.json();
}

function sessionName(session) {
  return session.displayName || `Session ${session.id.slice(0, 8)}`;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function roleLabel(role) {
  return role === "user" ? "You" : role === "tool" ? "Tool" : "Agent";
}

function preview(content) {
  const text = String(content || "").replace(/\s+/g, " ").trim();
  return text.length > 150 ? `${text.slice(0, 150)}...` : text || "Empty message";
}

function renderSessions() {
  sessionsEl.replaceChildren();
  if (!state.sessions.length) {
    const empty = document.createElement("div");
    empty.className = "session-empty";
    empty.textContent = "No sessions yet";
    sessionsEl.append(empty);
    return;
  }
  for (const session of state.sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `session-item ${session.id === state.sessionId ? "active" : ""}`;
    button.setAttribute("aria-current", session.id === state.sessionId ? "true" : "false");
    const title = document.createElement("span");
    title.className = "session-item-title";
    title.textContent = sessionName(session);
    const meta = document.createElement("small");
    const count = Number(session.nodeCount) || 0;
    meta.textContent = `${count} ${count === 1 ? "message" : "messages"}`;
    button.append(title, meta);
    button.addEventListener("click", () => selectSession(session.id));
    button.addEventListener("contextmenu", (event) => openSessionMenu(event, session.id));
    sessionsEl.append(button);
  }
}

function renderMemories() {
  memoriesEl.replaceChildren();
  if (!state.memories.length) {
    const empty = document.createElement("div");
    empty.className = "memory-empty";
    empty.textContent = "No memories yet";
    memoriesEl.append(empty);
    return;
  }
  for (const memory of state.memories) {
    const item = document.createElement("div");
    item.className = "memory-item";
    const content = document.createElement("div");
    content.className = "memory-text";
    content.textContent = memory.memory || memory.content || "";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "memory-delete text-button compact";
    remove.title = "Delete memory";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await request(`/api/memories/${encodeURIComponent(memory.id)}`, { method: "DELETE" });
        await loadMemories(memoryQueryEl.value.trim());
      } finally {
        remove.disabled = false;
      }
    });
    item.append(content, remove);
    memoriesEl.append(item);
  }
}

async function loadMemories(query = "") {
  const data = query
    ? await request("/api/memories/search", { method: "POST", body: JSON.stringify({ query }) })
    : await request("/api/memories");
  state.memories = data.memories || [];
  renderMemories();
}

function showEmptyState() {
  messagesEl.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty-state";
  const icon = document.createElement("div");
  icon.className = "empty-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "+";
  const heading = document.createElement("h1");
  heading.textContent = "What can I help with?";
  const copy = document.createElement("p");
  copy.textContent = "Start a conversation with your agent.";
  empty.append(icon, heading, copy);
  messagesEl.append(empty);
}

function addMessage(role, content = "") {
  const empty = messagesEl.querySelector(".empty-state");
  if (empty) empty.remove();
  const row = document.createElement("div");
  row.className = `message ${role}`;
  const label = document.createElement("div");
  label.className = "role-label";
  label.textContent = roleLabel(role);
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = content;
  if (role === "user") row.append(bubble, label);
  else row.append(label, bubble);
  messagesEl.append(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return bubble;
}

function nodePath(nodes, nodeId) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path = [];
  const seen = new Set();
  let current = nodeId;
  while (current && byId.has(current) && !seen.has(current)) {
    seen.add(current);
    const node = byId.get(current);
    path.unshift(node);
    current = node.parentId;
  }
  return path;
}

function renderCurrentPath() {
  if (!state.nodes.length || !state.nodeId) {
    showEmptyState();
    return;
  }
  messagesEl.replaceChildren();
  for (const node of nodePath(state.nodes, state.nodeId)) {
    if (node.content) addMessage(node.role, node.content);
  }
}

async function loadNodes(preferredNodeId = null) {
  const data = await request(`/api/sessions/${encodeURIComponent(state.sessionId)}/nodes`);
  state.nodes = data.nodes || [];
  const requested = preferredNodeId && state.nodes.some((node) => node.id === preferredNodeId) ? preferredNodeId : null;
  state.nodeId = requested || state.nodes[state.nodes.length - 1]?.id || null;
  renderCurrentPath();
}

async function selectSession(id, preferredNodeId = null) {
  hideSessionMenu();
  state.sessionId = id;
  const session = state.sessions.find((item) => item.id === id);
  $("session-title").textContent = session ? sessionName(session) : "Session";
  $("session-meta").textContent = "Ready";
  renderSessions();
  await loadNodes(preferredNodeId);
}

async function refreshSessions(select = true) {
  let data = await request("/api/sessions");
  state.sessions = data.sessions || [];
  if (!state.sessions.length) {
    const created = await request("/api/sessions", { method: "POST", body: JSON.stringify({ name: "New session" }) });
    state.sessionId = created.sessionId;
    data = await request("/api/sessions");
    state.sessions = data.sessions || [];
  }
  renderSessions();
  if (select && state.sessions.length) {
    const target = state.sessionId && state.sessions.some((session) => session.id === state.sessionId)
      ? state.sessionId
      : state.sessions[0].id;
    await selectSession(target, target === state.sessionId ? state.nodeId : null);
  }
}

function openSessionDialog() {
  sessionNameEl.value = "";
  sessionDialog.showModal();
  sessionNameEl.focus();
}

async function createSession(name) {
  const data = await request("/api/sessions", { method: "POST", body: JSON.stringify({ name }) });
  state.sessionId = data.sessionId;
  state.nodeId = null;
  await refreshSessions();
}

function hideSessionMenu() {
  sessionMenu.hidden = true;
  state.contextSessionId = null;
}

function openSessionMenu(event, sessionId) {
  event.preventDefault();
  state.contextSessionId = sessionId;
  sessionMenu.hidden = false;
  const menuWidth = 190;
  const menuHeight = 132;
  sessionMenu.style.left = `${Math.min(event.clientX, window.innerWidth - menuWidth - 8)}px`;
  sessionMenu.style.top = `${Math.min(event.clientY, window.innerHeight - menuHeight - 8)}px`;
}

async function getNodesForSession(sessionId) {
  if (sessionId === state.sessionId) return state.nodes;
  const data = await request(`/api/sessions/${encodeURIComponent(sessionId)}/nodes`);
  return data.nodes || [];
}

function appendTreeNode(parent, node, sessionId, childrenByParent) {
  const item = document.createElement("div");
  item.className = `tree-node ${sessionId === state.sessionId && node.id === state.nodeId ? "selected" : ""}`;
  const row = document.createElement("div");
  row.className = "tree-node-row";
  const detail = document.createElement("div");
  detail.className = "tree-node-detail";
  const heading = document.createElement("strong");
  heading.textContent = roleLabel(node.role);
  const date = document.createElement("time");
  date.textContent = formatDate(node.createdAt);
  const text = document.createElement("p");
  text.textContent = preview(node.content);
  detail.append(heading, date, text);
  const actions = document.createElement("div");
  actions.className = "tree-node-actions";
  const resume = document.createElement("button");
  resume.type = "button";
  resume.className = "text-button compact";
  resume.textContent = "Resume";
  resume.addEventListener("click", async () => {
    treeDialog.close();
    await selectSession(sessionId, node.id);
  });
  const fork = document.createElement("button");
  fork.type = "button";
  fork.className = "text-button compact";
  fork.textContent = "Fork";
  fork.addEventListener("click", async () => {
    await forkFromNode(sessionId, node.id);
    treeDialog.close();
  });
  actions.append(resume, fork);
  row.append(detail, actions);
  item.append(row);
  parent.append(item);
  const children = childrenByParent.get(node.id) || [];
  if (children.length) {
    const childList = document.createElement("div");
    childList.className = "tree-children";
    for (const child of children) appendTreeNode(childList, child, sessionId, childrenByParent);
    item.append(childList);
  }
}

function renderTree(nodes, sessionId) {
  treeEl.replaceChildren();
  if (!nodes.length) {
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    empty.textContent = "This session has no messages yet.";
    treeEl.append(empty);
    return;
  }
  const childrenByParent = new Map();
  const roots = [];
  for (const node of nodes) {
    if (!node.parentId) roots.push(node);
    else {
      const children = childrenByParent.get(node.parentId) || [];
      children.push(node);
      childrenByParent.set(node.parentId, children);
    }
  }
  for (const root of roots) appendTreeNode(treeEl, root, sessionId, childrenByParent);
}

async function openTree(sessionId) {
  const session = state.sessions.find((item) => item.id === sessionId);
  const nodes = await getNodesForSession(sessionId);
  $("tree-title").textContent = session ? sessionName(session) : "Session tree";
  $("tree-subtitle").textContent = `${nodes.length} ${nodes.length === 1 ? "node" : "nodes"}. Resume a branch or fork from any node.`;
  renderTree(nodes, sessionId);
  treeDialog.showModal();
}

async function forkFromNode(sessionId, nodeId) {
  const data = await request(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, { method: "POST", body: JSON.stringify({ nodeId }) });
  state.sessionId = data.sessionId;
  state.nodeId = data.nodeId;
  await refreshSessions();
}

async function handleSessionMenu(action) {
  const sessionId = state.contextSessionId;
  hideSessionMenu();
  if (!sessionId) return;
  const nodes = await getNodesForSession(sessionId);
  if (action === "tree") {
    await openTree(sessionId);
    return;
  }
  const latest = nodes[nodes.length - 1];
  if (!latest) return;
  if (action === "resume") await selectSession(sessionId, latest.id);
  if (action === "fork") await forkFromNode(sessionId, latest.id);
}

async function sendMessage(event) {
  event.preventDefault();
  const prompt = inputEl.value.trim();
  if (!prompt || state.busy || !state.sessionId) return;
  state.busy = true;
  inputEl.value = "";
  inputEl.style.height = "auto";
  sendEl.disabled = true;
  addMessage("user", prompt);
  const bubble = addMessage("assistant", "");
  $("session-meta").textContent = "Thinking...";
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, nodeId: state.nodeId, input: prompt }),
    });
    if (!response.ok || !response.body) throw new Error(await response.text());
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";
      for (const chunk of chunks) {
        const line = chunk.split("\n").find((item) => item.startsWith("data: "));
        if (!line) continue;
        const data = JSON.parse(line.slice(6));
        if (data.type === "text_delta") {
          bubble.textContent += data.text;
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
        if (data.type === "tool_start") bubble.textContent += `\n[tool: ${data.toolCall?.function?.name || "tool"}]`;
        if (data.type === "error") bubble.textContent += `\n${data.message}`;
        if (data.type === "done") state.nodeId = data.nodeId;
      }
    }
    await refreshSessions(false);
    await loadNodes(state.nodeId);
    await loadMemories(memoryQueryEl.value.trim());
    $("session-meta").textContent = "Ready";
  } catch (error) {
    bubble.textContent = error instanceof Error ? error.message : String(error);
    $("session-meta").textContent = "Error";
  } finally {
    state.busy = false;
    sendEl.disabled = false;
    inputEl.focus();
  }
}

$("composer").addEventListener("submit", sendMessage);
$("new-session").addEventListener("click", openSessionDialog);
$("refresh").addEventListener("click", () => refreshSessions());
$("session-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = sessionNameEl.value.trim();
  sessionDialog.close();
  try {
    await createSession(name);
  } catch (error) {
    $("session-meta").textContent = error instanceof Error ? error.message : String(error);
  }
});
$("cancel-session").addEventListener("click", () => sessionDialog.close());
$("close-tree").addEventListener("click", () => treeDialog.close());
$("memory-search").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await loadMemories(memoryQueryEl.value.trim());
  } catch (error) {
    memoriesEl.textContent = error instanceof Error ? error.message : String(error);
  }
});
$("refresh-memories").addEventListener("click", () => loadMemories(memoryQueryEl.value.trim()));
sessionMenu.addEventListener("click", (event) => {
  const action = event.target.closest("button")?.dataset.action;
  if (action) handleSessionMenu(action).catch((error) => { $("session-meta").textContent = error.message; });
});
document.addEventListener("click", (event) => {
  if (!sessionMenu.hidden && !sessionMenu.contains(event.target)) hideSessionMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideSessionMenu();
});
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 150)}px`;
});
inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});

request("/api/health").then((health) => {
  $("health-dot").classList.toggle("ok", health.ok);
  $("health-text").textContent = health.memoryAvailable ? "Online - Memory on" : "Online - Memory off";
}).catch(() => {
  $("health-text").textContent = "Offline";
});
refreshSessions().catch((error) => { $("session-meta").textContent = error.message; });
loadMemories().catch(() => { memoriesEl.innerHTML = `<div class="memory-empty">Memory unavailable</div>`; });
