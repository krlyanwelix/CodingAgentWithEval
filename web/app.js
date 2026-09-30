const state = {
  sessions: [],
  sessionId: null,
  nodeId: null,
  nodes: [],
  busy: false,
  memories: [],
  memoriesLoaded: false,
  contextSessionId: null,
  deleteSessionId: null,
};

const $ = (id) => document.getElementById(id);
const sessionsEl = $("sessions");
const messagesEl = $("messages");
const inputEl = $("input");
const sendEl = $("send");
const memoriesEl = $("memories");
const memoryQueryEl = $("memory-query");
const memoryPanel = $("memory-panel");
const memoryCountEl = $("memory-count");
const sessionDialog = $("session-dialog");
const sessionNameEl = $("session-name");
const deleteSessionDialog = $("delete-session-dialog");
const deleteSessionNameEl = $("delete-session-name");
const treeDialog = $("tree-dialog");
const treeEl = $("tree");
const sessionMenu = $("session-menu");

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) {
    const raw = await response.text();
    let message = raw;
    try {
      const payload = JSON.parse(raw);
      if (payload && typeof payload.error === "string") message = payload.error;
    } catch {
      // Keep non-JSON server errors readable.
    }
    const error = new Error(message || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
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
    const item = document.createElement("div");
    item.className = `session-item ${session.id === state.sessionId ? "active" : ""}`;
    item.setAttribute("aria-current", session.id === state.sessionId ? "true" : "false");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "session-select";
    const title = document.createElement("span");
    title.className = "session-item-title";
    title.textContent = sessionName(session);
    const meta = document.createElement("small");
    const count = Number(session.nodeCount) || 0;
    meta.textContent = `${count} ${count === 1 ? "turn" : "turns"}`;
    button.append(title, meta);
    button.addEventListener("click", () => selectSession(session.id));
    item.addEventListener("contextmenu", (event) => openSessionMenu(event, session.id));
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "session-delete";
    deleteButton.title = `Delete ${sessionName(session)}`;
    deleteButton.setAttribute("aria-label", `Delete ${sessionName(session)}`);
    deleteButton.textContent = "\u00D7";
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openDeleteSessionDialog(session.id);
    });
    item.append(button, deleteButton);
    sessionsEl.append(item);
  }
}

function renderMemories() {
  memoriesEl.replaceChildren();
  memoryCountEl.textContent = String(state.memories.length);
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
  state.memoriesLoaded = true;
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

function addMessage(role, content = "", tools = []) {
  const empty = messagesEl.querySelector(".empty-state");
  if (empty) empty.remove();
  const row = document.createElement("div");
  row.className = `message ${role}`;
  const avatar = document.createElement("img");
  avatar.className = "message-avatar";
  avatar.src = role === "user" ? "/user-avatar.svg" : "/agent-avatar.svg";
  avatar.alt = role === "user" ? "You" : "Agent";
  avatar.width = 34;
  avatar.height = 34;
  const messageContent = document.createElement("div");
  messageContent.className = "message-content";
  const label = document.createElement("div");
  label.className = "role-label";
  label.textContent = roleLabel(role);
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = content;
  const toolList = document.createElement("div");
  toolList.className = "tool-list";
  toolList.setAttribute("aria-label", "Tools used");
  const setTools = (names) => {
    toolList.replaceChildren();
    for (const name of [...new Set(names)].filter(Boolean)) {
      const tag = document.createElement("span");
      tag.className = "tool-tag";
      tag.textContent = name;
      toolList.append(tag);
    }
  };
  setTools(tools);
  messageContent.append(label, toolList, bubble);
  if (role === "user") row.append(messageContent, avatar);
  else row.append(avatar, messageContent);
  messagesEl.append(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return { bubble, setTools };
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
    addMessage("user", node.userContent);
    if (node.assistantContent !== null) addMessage("assistant", node.assistantContent, node.toolNames || []);
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
  sendEl.disabled = false;
}

async function refreshSessions(select = true) {
  const data = await request("/api/sessions");
  state.sessions = data.sessions || [];
  if (!state.sessions.length) {
    state.sessionId = null;
    state.nodeId = null;
    state.nodes = [];
    $("session-title").textContent = "No session";
    $("session-meta").textContent = "Create a session to start";
    sendEl.disabled = true;
    renderSessions();
    showEmptyState();
    return;
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

function openDeleteSessionDialog(sessionId) {
  const session = state.sessions.find((item) => item.id === sessionId);
  state.deleteSessionId = sessionId;
  deleteSessionNameEl.textContent = session ? sessionName(session) : "this session";
  deleteSessionDialog.showModal();
}

async function deleteSession(sessionId) {
  if (!sessionId) throw new Error("Session id is missing");
  try {
    await request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  } catch (error) {
    if (error?.status !== 404) throw error;
    const latest = await request("/api/sessions");
    if ((latest.sessions || []).some((session) => session.id === sessionId)) throw error;
  }
  if (state.sessionId === sessionId) {
    state.sessionId = null;
    state.nodeId = null;
    state.nodes = [];
  }
  await refreshSessions(true);
}

function hideSessionMenu() {
  sessionMenu.hidden = true;
  state.contextSessionId = null;
}

function openSessionMenu(event, sessionId) {
  event.preventDefault();
  state.contextSessionId = sessionId;
  sessionMenu.hidden = false;
  sessionMenu.style.left = "0px";
  sessionMenu.style.top = "0px";
  const menuRect = sessionMenu.getBoundingClientRect();
  const left = Math.max(8, Math.min(event.clientX, window.innerWidth - menuRect.width - 8));
  const top = Math.max(8, Math.min(event.clientY, window.innerHeight - menuRect.height - 8));
  sessionMenu.style.left = `${left}px`;
  sessionMenu.style.top = `${top}px`;
}

async function getNodesForSession(sessionId) {
  if (sessionId === state.sessionId) return state.nodes;
  const data = await request(`/api/sessions/${encodeURIComponent(sessionId)}/nodes`);
  return data.nodes || [];
}

function renderTree(nodes, sessionId) {
  treeEl.replaceChildren();
  treeEl.onscroll = null;
  treeDialog.querySelector("#tree-node-tooltip")?.remove();
  const visibleNodes = nodes;
  if (!visibleNodes.length) {
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    empty.textContent = "This session has no messages yet.";
    treeEl.append(empty);
    return;
  }
  const graph = document.createElement("div");
  graph.className = "session-graph";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("session-graph-lines");
  svg.setAttribute("aria-hidden", "true");
  graph.append(svg);
  const tooltip = document.createElement("div");
  tooltip.id = "tree-node-tooltip";
  tooltip.className = "graph-tooltip";
  tooltip.hidden = true;
  treeDialog.append(tooltip);
  const graphNodes = new Map();
  let hideTooltipTimer = null;
  let pinnedNodeId = null;

  function clearTooltipTimer() {
    if (hideTooltipTimer) window.clearTimeout(hideTooltipTimer);
    hideTooltipTimer = null;
  }

  function setExpandedNode(nodeId) {
    for (const [id, entry] of graphNodes) entry.dot.setAttribute("aria-expanded", String(id === nodeId));
  }

  function hideTooltip(force = false) {
    if (!force && pinnedNodeId) return;
    clearTooltipTimer();
    tooltip.classList.remove("visible");
    tooltip.hidden = true;
    if (force) setExpandedNode(null);
  }

  function positionTooltip(dot) {
    const margin = 12;
    const gap = 12;
    const dotRect = dot.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    let left = dotRect.right + gap;
    if (left + tooltipRect.width > viewportWidth - margin) left = dotRect.left - gap - tooltipRect.width;
    left = Math.max(margin, Math.min(left, viewportWidth - tooltipRect.width - margin));
    let top = dotRect.top + dotRect.height / 2 - tooltipRect.height / 2;
    top = Math.max(margin, Math.min(top, viewportHeight - tooltipRect.height - margin));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function showTooltip(node, dot) {
    clearTooltipTimer();
    tooltip.replaceChildren();
    const meta = document.createElement("div");
    meta.className = "graph-tooltip-meta";
    const role = document.createElement("strong");
    role.textContent = "Turn";
    const date = document.createElement("time");
    date.textContent = formatDate(node.createdAt);
    meta.append(role, date);
    const question = document.createElement("div");
    question.className = "graph-tooltip-section";
    const questionLabel = document.createElement("small");
    questionLabel.textContent = "You";
    const questionText = document.createElement("p");
    questionText.textContent = preview(node.userContent);
    question.append(questionLabel, questionText);
    const answer = document.createElement("div");
    answer.className = "graph-tooltip-section";
    const answerLabel = document.createElement("small");
    answerLabel.textContent = "Agent";
    const answerText = document.createElement("p");
    answerText.textContent = node.assistantContent === null ? "Response pending" : preview(node.assistantContent);
    answer.append(answerLabel, answerText);
    const tools = document.createElement("div");
    tools.className = "graph-tooltip-tools";
    if (node.toolNames?.length) tools.textContent = `Tools: ${node.toolNames.join(", ")}`;
    const actions = document.createElement("div");
    actions.className = "graph-tooltip-actions";
    const resume = document.createElement("button");
    resume.type = "button";
    resume.className = "text-button compact";
    resume.textContent = "Resume";
    resume.addEventListener("click", async (event) => {
      event.stopPropagation();
      treeDialog.close();
      await selectSession(sessionId, node.id);
    });
    const fork = document.createElement("button");
    fork.type = "button";
    fork.className = "text-button compact";
    fork.textContent = "Fork";
    fork.addEventListener("click", async (event) => {
      event.stopPropagation();
      await forkFromNode(sessionId, node.id);
      treeDialog.close();
    });
    actions.append(resume, fork);
    tooltip.append(meta, question, answer, tools, actions);
    tooltip.style.left = "-9999px";
    tooltip.style.top = "-9999px";
    tooltip.hidden = false;
    tooltip.classList.add("visible");
    positionTooltip(dot);
  }

  function scheduleTooltipHide() {
    clearTooltipTimer();
    hideTooltipTimer = window.setTimeout(() => {
      if (pinnedNodeId) {
        const entry = graphNodes.get(pinnedNodeId);
        if (entry) showTooltip(entry.node, entry.dot);
      } else {
        hideTooltip(true);
      }
    }, 140);
  }

  tooltip.addEventListener("mouseenter", clearTooltipTimer);
  tooltip.addEventListener("mouseleave", scheduleTooltipHide);
  tooltip.addEventListener("click", (event) => event.stopPropagation());
  treeEl.onscroll = () => {
    pinnedNodeId = null;
    hideTooltip(true);
  };

  const childrenByParent = new Map();
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parentById = new Map();
  const nodeOrder = new Map(visibleNodes.map((node, index) => [node.id, index]));
  for (const node of visibleNodes) {
    let parentId = node.parentId;
    while (parentId && !visibleIds.has(parentId)) parentId = byId.get(parentId)?.parentId || null;
    parentById.set(node.id, parentId);
    if (parentId) {
      const children = childrenByParent.get(parentId) || [];
      children.push(node);
      childrenByParent.set(parentId, children);
    }
  }
  for (const children of childrenByParent.values()) {
    children.sort((a, b) => nodeOrder.get(a.id) - nodeOrder.get(b.id));
  }
  const roots = visibleNodes.filter((node) => !parentById.get(node.id));
  const palette = ["#287b63", "#4f75ad", "#9a6b35", "#855aa5", "#b45965", "#4c8792"];
  const positions = new Map();
  let nextLane = 0;
  let nextColor = 0;
  let maxDepth = 0;

  function layout(node, depth, color) {
    maxDepth = Math.max(maxDepth, depth);
    const children = childrenByParent.get(node.id) || [];
    const childPositions = children.map((child, index) => {
      const childColor = index === 0 ? color : palette[(++nextColor) % palette.length];
      layout(child, depth + 1, childColor);
      return positions.get(child.id);
    });
    const lane = childPositions.length
      ? (childPositions[0].lane + childPositions[childPositions.length - 1].lane) / 2
      : nextLane++;
    positions.set(node.id, { lane, depth, color });
  }

  roots.forEach((root, index) => layout(root, 0, palette[index % palette.length]));
  const laneGap = 62;
  const rowGap = 58;
  const paddingX = 32;
  const paddingY = 30;
  const laneCount = Math.max(1, nextLane);
  const contentWidth = paddingX * 2 + (laneCount - 1) * laneGap;
  const graphWidth = Math.max(420, contentWidth);
  const graphHeight = Math.max(150, paddingY * 2 + maxDepth * rowGap);
  const originX = paddingX + (graphWidth - contentWidth) / 2;
  graph.style.width = `${graphWidth}px`;
  graph.style.height = `${graphHeight}px`;
  svg.setAttribute("viewBox", `0 0 ${graphWidth} ${graphHeight}`);
  svg.setAttribute("width", String(graphWidth));
  svg.setAttribute("height", String(graphHeight));

  for (const node of visibleNodes) {
    const parentId = parentById.get(node.id);
    if (!parentId) continue;
    const parent = positions.get(parentId);
    const child = positions.get(node.id);
    if (!parent || !child) continue;
    const x1 = originX + parent.lane * laneGap;
    const y1 = paddingY + parent.depth * rowGap;
    const x2 = originX + child.lane * laneGap;
    const y2 = paddingY + child.depth * rowGap;
    const middleY = y1 + (y2 - y1) / 2;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${x1} ${y1} C ${x1} ${middleY}, ${x2} ${middleY}, ${x2} ${y2}`);
    path.setAttribute("stroke", child.color);
    path.classList.add("session-graph-line");
    svg.append(path);
  }

  for (const node of visibleNodes) {
    const position = positions.get(node.id);
    if (!position) continue;
    const x = originX + position.lane * laneGap;
    const y = paddingY + position.depth * rowGap;
    const wrapper = document.createElement("div");
    wrapper.className = `graph-node ${sessionId === state.sessionId && node.id === state.nodeId ? "selected" : ""}`;
    wrapper.style.left = `${x}px`;
    wrapper.style.top = `${y}px`;
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "graph-node-dot";
    dot.style.setProperty("--branch-color", position.color);
    dot.setAttribute("aria-label", `Turn: ${preview(node.userContent)}`);
    dot.setAttribute("aria-expanded", "false");

    graphNodes.set(node.id, { node, dot });
    dot.addEventListener("mouseenter", () => showTooltip(node, dot));
    dot.addEventListener("mouseleave", scheduleTooltipHide);
    dot.addEventListener("focus", () => showTooltip(node, dot));
    dot.addEventListener("blur", scheduleTooltipHide);
    dot.addEventListener("click", (event) => {
      event.stopPropagation();
      pinnedNodeId = pinnedNodeId === node.id ? null : node.id;
      setExpandedNode(pinnedNodeId);
      if (pinnedNodeId) showTooltip(node, dot);
      else hideTooltip(true);
    });
    wrapper.append(dot);
    graph.append(wrapper);
  }
  graph.addEventListener("click", () => {
    pinnedNodeId = null;
    hideTooltip(true);
  });
  treeEl.append(graph);
}

async function openTree(sessionId) {
  const session = state.sessions.find((item) => item.id === sessionId);
  const nodes = await getNodesForSession(sessionId);
  $("tree-title").textContent = session ? sessionName(session) : "Session tree";
  $("tree-subtitle").textContent = `${nodes.length} ${nodes.length === 1 ? "node" : "nodes"}. Hover over a point to view details, resume, or fork.`;
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
  if (action === "delete") {
    openDeleteSessionDialog(sessionId);
    return;
  }
  if (action === "tree") {
    await openTree(sessionId);
    return;
  }
  const nodes = await getNodesForSession(sessionId);
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
  const assistantMessage = addMessage("assistant", "");
  const { bubble, setTools } = assistantMessage;
  const toolNames = [];
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
        if (data.type === "tool_start") {
          const toolName = data.toolCall?.function?.name;
          if (toolName) toolNames.push(toolName);
          setTools(toolNames);
        }
        if (data.type === "error") bubble.textContent += `\n${data.message}`;
        if (data.type === "done") state.nodeId = data.nodeId;
      }
    }
    await refreshSessions(false);
    await loadNodes(state.nodeId);
    if (memoryPanel.open) await loadMemories(memoryQueryEl.value.trim());
    else {
      state.memoriesLoaded = false;
      memoryCountEl.textContent = "-";
    }
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
$("cancel-delete-session").addEventListener("click", () => deleteSessionDialog.close());
$("delete-session-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const sessionId = state.deleteSessionId;
  if (!sessionId) return;
  const confirmButton = $("confirm-delete-session");
  confirmButton.disabled = true;
  try {
    await deleteSession(sessionId);
    state.deleteSessionId = null;
    deleteSessionDialog.close();
    $("session-meta").textContent = state.sessions.length ? "Session deleted" : "No sessions. Create one to start.";
  } catch (error) {
    $("session-meta").textContent = error instanceof Error ? error.message : String(error);
  } finally {
    confirmButton.disabled = false;
  }
});
deleteSessionDialog.addEventListener("close", () => { state.deleteSessionId = null; });
memoryPanel.addEventListener("toggle", async () => {
  if (!memoryPanel.open || state.memoriesLoaded) return;
  memoriesEl.innerHTML = `<div class="memory-empty">Loading memories...</div>`;
  try {
    await loadMemories(memoryQueryEl.value.trim());
  } catch (error) {
    memoryCountEl.textContent = "!";
    memoriesEl.innerHTML = `<div class="memory-empty">Memory unavailable</div>`;
  }
});
$("memory-search").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await loadMemories(memoryQueryEl.value.trim());
  } catch (error) {
    memoriesEl.textContent = error instanceof Error ? error.message : String(error);
  }
});
$("refresh-memories").addEventListener("click", async () => {
  try {
    await loadMemories(memoryQueryEl.value.trim());
  } catch {
    memoryCountEl.textContent = "!";
    memoriesEl.innerHTML = `<div class="memory-empty">Memory unavailable</div>`;
  }
});
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
