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
  sessionFilter: "",
  toastTimer: null,
  controller: null,
  attachment: null,
  model: "",
  allowTools: localStorage.getItem("codingagentwitheval-allow-tools") !== "0",
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

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function inlineNodes(text) {
  const nodes = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\s]+\))/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) nodes.push(document.createTextNode(text.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(element("code", "md-inline-code", token.slice(1, -1)));
    } else if (token.startsWith("**")) {
      nodes.push(element("strong", null, token.slice(2, -2)));
    } else if (token.startsWith("*")) {
      nodes.push(element("em", null, token.slice(1, -1)));
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link && /^https?:\/\//i.test(link[2])) {
        const anchor = element("a", null, link[1]);
        anchor.href = link[2];
        anchor.target = "_blank";
        anchor.rel = "noreferrer noopener";
        nodes.push(anchor);
      } else {
        nodes.push(document.createTextNode(token));
      }
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) nodes.push(document.createTextNode(text.slice(cursor)));
  return nodes;
}

function codeBlock(code, language) {
  const wrap = element("div", "md-codeblock");
  const head = element("div", "md-codeblock-head");
  head.append(element("span", "md-codeblock-lang", language));
  const copy = element("button", "md-copy", "Copy");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code);
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Failed";
    }
    window.setTimeout(() => { copy.textContent = "Copy"; }, 1400);
  });
  head.append(copy);
  const pre = document.createElement("pre");
  const codeEl = document.createElement("code");
  codeEl.textContent = code;
  pre.append(codeEl);
  wrap.append(head, pre);
  return wrap;
}

// Renders the subset of Markdown the model actually emits, always through text nodes
// so model output can never inject HTML.
function renderMarkdown(text) {
  const root = element("div", "md");
  const lines = String(text).split("\n");
  let index = 0;
  let list = null;
  const closeList = () => { list = null; };
  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      closeList();
      const body = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      root.append(codeBlock(body.join("\n"), fence[1] || "text"));
      continue;
    }
    if (/^\s*$/.test(line)) { closeList(); index += 1; continue; }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const node = document.createElement(`h${Math.min(4, heading[1].length + 2)}`);
      node.className = "md-heading";
      node.append(...inlineNodes(heading[2]));
      root.append(node);
      index += 1;
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || ordered) {
      const kind = bullet ? "ul" : "ol";
      if (!list || list.kind !== kind) {
        list = { kind, node: element(kind, "md-list") };
        root.append(list.node);
      }
      const item = document.createElement("li");
      item.append(...inlineNodes((bullet || ordered)[1]));
      list.node.append(item);
      index += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      closeList();
      const quote = element("blockquote", "md-quote");
      quote.append(...inlineNodes(line.replace(/^>\s?/, "")));
      root.append(quote);
      index += 1;
      continue;
    }
    closeList();
    const paragraph = [line];
    index += 1;
    while (index < lines.length
      && !/^\s*$/.test(lines[index])
      && !/^\s*```/.test(lines[index])
      && !/^#{1,4}\s/.test(lines[index])
      && !/^\s*[-*]\s+/.test(lines[index])
      && !/^\s*\d+[.)]\s+/.test(lines[index])
      && !/^>\s?/.test(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    const p = element("p", "md-p");
    p.append(...inlineNodes(paragraph.join(" ")));
    root.append(p);
  }
  return root;
}

function toolArgsPreview(call) {
  const raw = call?.function?.arguments;
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    const first = Object.entries(parsed)[0];
    return first ? `${first[0]}: ${String(first[1]).replace(/\s+/g, " ").slice(0, 70)}` : "";
  } catch {
    return String(raw).replace(/\s+/g, " ").slice(0, 70);
  }
}

function notify(message) {
  const toast = $("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 2600);
}

function setDrawer(name, open) {
  const sidebar = $("sessions-drawer");
  const context = $("context-panel");
  if (name === "sessions") sidebar.classList.toggle("open", open);
  if (name === "context") context.classList.toggle("open", open);
  const anyOpen = sidebar.classList.contains("open") || context.classList.contains("open");
  $("drawer-scrim").classList.toggle("visible", anyOpen);
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
    const matches = `${sessionName(session)} ${session.lastMessage || ""}`.toLowerCase().includes(state.sessionFilter.toLowerCase());
    const item = document.createElement("div");
    item.className = `session-item ${session.id === state.sessionId ? "active" : ""}`;
    item.hidden = !matches;
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
    const memoryText = memory.text || memory.memory || memory.content || "";
    content.lang = langOf(memoryText);
    content.textContent = memoryText;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "memory-delete text-button compact";
    const memoryLabel = (memory.text || memory.memory || memory.content || "").trim().slice(0, 60);
    remove.title = memoryLabel ? `Delete memory: ${memoryLabel}` : "Delete memory";
    remove.setAttribute("aria-label", remove.title);
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
  copy.textContent = state.model
    ? `${state.model} is ready. It can read, edit and run code in this workspace.`
    : "Start a conversation with your agent.";
  const suggestions = document.createElement("div");
  suggestions.className = "suggestions";
  const ideas = [
    ["Explain this project", "Explain the structure of this project and tell me where to start."],
    ["Fix a failing test", "Run the test suite and fix whatever fails."],
    ["Review the README", "Review README.md against the code and list what is wrong or missing."],
    ["Add a small feature", "Pick one small improvement this project is missing and implement it."],
  ];
  for (const [label, prompt] of ideas) {
    const chip = element("button", "suggestion", label);
    chip.type = "button";
    chip.addEventListener("click", () => {
      inputEl.value = prompt;
      inputEl.focus();
      inputEl.dispatchEvent(new Event("input"));
    });
    suggestions.append(chip);
  }
  empty.append(icon, heading, copy, suggestions);
  messagesEl.append(empty);
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
function langOf(text) {
  const sample = String(text ?? "").slice(0, 240);
  const hits = (sample.match(CJK) || []).length;
  return hits / Math.max(sample.length, 1) > 0.15 ? "zh-CN" : "en";
}

function addMessage(role, content = "", tools = []) {
  const empty = messagesEl.querySelector(".empty-state");
  if (empty) empty.remove();
  const row = document.createElement("div");
  row.className = `message ${role}`;
  const messageContent = document.createElement("div");
  messageContent.className = "message-content";
  const label = document.createElement("div");
  label.className = "role-label";
  label.textContent = roleLabel(role);
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
  const toolLog = element("div", "tool-log");
  const bubble = element("div", "message-bubble");
  if (role === "assistant") bubble.classList.add("markdown");
  const api = { bubble, toolLog, toolRecords: new Map(), setTools };
  if (role === "assistant") {
    let frame = 0;
    api.setText = (text) => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        bubble.lang = langOf(text);
        bubble.replaceChildren(renderMarkdown(text));
        messagesEl.scrollTop = messagesEl.scrollHeight;
      });
    };
    api.notice = (message) => {
      toolLog.append(element("div", "message-notice", message));
    };
    api.addTool = (toolCall) => {
      const entry = document.createElement("details");
      entry.className = "tool-entry";
      const summary = document.createElement("summary");
      const name = element("span", "tool-entry-name", toolCall?.function?.name || "tool");
      const hint = element("span", "tool-entry-hint", toolArgsPreview(toolCall));
      const status = element("span", "tool-entry-status", "running");
      summary.append(name, hint, status);
      const output = element("pre", "tool-entry-output", "");
      entry.append(summary, output);
      toolLog.append(entry);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      api.toolRecords.set(toolCall?.id, { status, output });
      return entry;
    };
    api.finishTool = (toolCall, result) => {
      const record = api.toolRecords.get(toolCall?.id);
      if (!record) return;
      const text = String(result ?? "");
      const failed = /^\s*(Tool error|Error)/.test(text);
      record.status.textContent = failed ? "error" : "done";
      record.status.classList.toggle("error", failed);
      record.output.textContent = text.length > 4000 ? `${text.slice(0, 4000)}\n... (${text.length} characters)` : text;
    };
    if (content) api.setText(content);
  } else {
    bubble.lang = langOf(content);
    bubble.textContent = content;
  }
  messageContent.append(label, toolList, toolLog, bubble);
  row.append(messageContent);
  messagesEl.append(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return api;
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
  renderContextPath();
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

function renderContextPath() {
  const pathList = $("path-list");
  if (!pathList) return;
  const path = nodePath(state.nodes, state.nodeId);
  pathList.replaceChildren();
  if (!path.length) {
    const entry = document.createElement("div");
    entry.className = "path-entry";
    entry.innerHTML = '<span class="path-node current"></span><span><strong>New conversation</strong><small>main branch</small></span>';
    pathList.append(entry);
    $("session-path").textContent = "main branch";
    return;
  }
  path.forEach((node, index) => {
    const entry = document.createElement("div");
    entry.className = "path-entry";
    const dot = document.createElement("span");
    dot.className = `path-node ${index === path.length - 1 ? "current" : ""}`;
    const labels = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = preview(node.userContent).slice(0, 43);
    const meta = document.createElement("small");
    meta.textContent = index === path.length - 1 ? "Current turn" : `Turn ${index + 1}`;
    labels.append(title, meta);
    entry.append(dot, labels);
    pathList.append(entry);
  });
  $("session-path").textContent = path.length > 1 ? `${path.length} turns` : "main branch";
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
  setDrawer("sessions", false);
}

async function refreshSessions(select = true) {
  const data = await request("/api/sessions");
  state.sessions = data.sessions || [];
  if (!state.sessions.length) {
    state.sessionId = null;
    state.nodeId = null;
    state.nodes = [];
    $("session-title").textContent = "No session";
    $("session-meta").textContent = "Create a session or just start typing";
    sendEl.disabled = false;
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

function exportCurrentSession() {
  if (!state.sessionId) return notify("There is no conversation to export yet.");
  const session = state.sessions.find((item) => item.id === state.sessionId);
  const transcript = nodePath(state.nodes, state.nodeId).map((node) => [
    `You: ${node.userContent || ""}`,
    node.assistantContent ? `CodingAgentWithEval: ${node.assistantContent}` : "",
  ].filter(Boolean).join("\n\n")).join("\n\n");
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([`${session ? sessionName(session) : "CodingAgentWithEval session"}\n\n${transcript}`], { type: "text/plain" }));
  anchor.download = `${(session ? sessionName(session) : "codingagentwitheval-session").replace(/[^\p{L}\p{N}-]+/gu, "-").replace(/^-|-$/g, "") || "codingagentwitheval-session"}.txt`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
  notify("Conversation exported.");
}

function setRunStatus(kind, title, detail) {
  const box = $("run-status");
  if (!box) return;
  box.dataset.state = kind;
  $("run-status-title").textContent = title;
  $("run-status-detail").textContent = detail;
}

function setBusy(busy) {
  state.busy = busy;
  sendEl.disabled = busy;
  sendEl.hidden = busy;
  $("stop").hidden = !busy;
  inputEl.setAttribute("aria-busy", String(busy));
  if (busy) setRunStatus("working", "Working", "Streaming the model response");
  else setRunStatus("idle", "Ready to work", "Agent is available");
}

function clearAttachment() {
  state.attachment = null;
  const holder = $("attachments");
  holder.replaceChildren();
  holder.hidden = true;
}

function renderAttachment() {
  const holder = $("attachments");
  holder.replaceChildren();
  if (!state.attachment) {
    holder.hidden = true;
    return;
  }
  const chip = element("div", "attachment-chip");
  chip.append(element("span", "attachment-name", state.attachment.name));
  const remove = element("button", "attachment-remove", "×");
  remove.type = "button";
  remove.setAttribute("aria-label", `Remove ${state.attachment.name}`);
  remove.addEventListener("click", clearAttachment);
  chip.append(remove);
  holder.append(chip);
  holder.hidden = false;
}

async function sendMessage(event) {
  event.preventDefault();
  const prompt = inputEl.value.trim();
  if (!prompt || state.busy) return;
  if (!state.sessionId) {
    // First message in a fresh browser: create the session on demand instead of making
    // the user click "New session" before they can type.
    try {
      await createSession("");
      messagesEl.querySelector(".empty-state")?.remove();
    } catch (error) {
      $("session-meta").textContent = error instanceof Error ? error.message : String(error);
      return;
    }
  }
  const attachment = state.attachment;
  const outgoing = attachment
    ? `${prompt}\n\n<file name="${attachment.name}">\n${attachment.text}\n</file>`
    : prompt;
  inputEl.value = "";
  inputEl.style.height = "auto";
  clearAttachment();
  setBusy(true);
  addMessage("user", prompt);
  const assistantMessage = addMessage("assistant", "");
  const toolNames = [];
  let streamed = "";
  let aborted = false;
  state.controller = new AbortController();
  $("session-meta").textContent = "Working…";
  messagesEl.setAttribute("aria-busy", "true");
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: state.sessionId,
        nodeId: state.nodeId,
        input: outgoing,
        allowTools: state.allowTools,
      }),
      signal: state.controller.signal,
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
          streamed += data.text;
          assistantMessage.setText(streamed);
        } else if (data.type === "tool_start") {
          const toolName = data.toolCall?.function?.name;
          if (toolName) toolNames.push(toolName);
          assistantMessage.setTools(toolNames);
          assistantMessage.addTool(data.toolCall);
          $("tool-count").textContent = String(new Set(toolNames).size);
          setRunStatus("working", "Running a tool", toolName ? toolName + "…" : "Waiting for the tool result");
        } else if (data.type === "tool_end") {
          assistantMessage.finishTool(data.toolCall, data.result);
          setRunStatus("working", "Working", "Reading the tool result");
          if (typeof data.result === "string" && data.result.startsWith("Tool execution cancelled")) {
            assistantMessage.notice("This tool needs permission and was denied. Turn on “Run commands” above the input and try again.");
          }
        } else if (data.type === "warning") {
          assistantMessage.notice(data.message);
        } else if (data.type === "error") {
          assistantMessage.notice(data.message);
          setRunStatus("error", "Needs attention", String(data.message).slice(0, 80));
        } else if (data.type === "aborted") {
          aborted = true;
          streamed = data.partial || streamed;
          assistantMessage.setText(streamed ? `${streamed}\n\n_Stopped._` : "_Stopped._");
        } else if (data.type === "done") {
          state.nodeId = data.nodeId;
          if (data.usage?.promptTokens) {
            state.contextUsed = data.usage.promptTokens;
            setContextLabel();
          }
        }
      }
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      aborted = true;
      assistantMessage.setText(streamed ? `${streamed}\n\n_Stopped._` : "_Stopped._");
    } else {
      assistantMessage.setText(`**Request failed.** ${error instanceof Error ? error.message : String(error)}`);
      $("session-meta").textContent = "Error";
      setRunStatus("error", "Request failed", (error instanceof Error ? error.message : String(error)).slice(0, 80));
      notify("The request failed.");
    }
  } finally {
    state.controller = null;
    setBusy(false);
    messagesEl.setAttribute("aria-busy", "false");
    $("tool-count").textContent = toolNames.length ? String(new Set(toolNames).size) : "None";
    if (aborted) {
      $("session-meta").textContent = "Stopped";
      refreshSessions(false).catch(() => undefined);
    } else {
      $("session-meta").textContent = "Ready";
      try {
        await refreshSessions(false);
        await loadNodes(state.nodeId);
      } catch { /* keep the streamed transcript on screen */ }
      if (memoryPanel.open) await loadMemories(memoryQueryEl.value.trim()).catch(() => undefined);
      else {
        state.memoriesLoaded = false;
        memoryCountEl.textContent = "-";
      }
    }
    inputEl.focus();
  }
}

$("composer").addEventListener("submit", sendMessage);
$("allow-tools").checked = state.allowTools;
$("allow-tools").addEventListener("change", (event) => {
  state.allowTools = event.currentTarget.checked;
  localStorage.setItem("codingagentwitheval-allow-tools", state.allowTools ? "1" : "0");
});
$("new-session").addEventListener("click", openSessionDialog);
$("refresh").addEventListener("click", () => refreshSessions());
$("global-search").addEventListener("input", (event) => {
  state.sessionFilter = event.currentTarget.value.trim();
  renderSessions();
});
$("global-search").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const match = state.sessions.find((session) => `${sessionName(session)} ${session.lastMessage || ""}`.toLowerCase().includes(state.sessionFilter.toLowerCase()));
  if (match) selectSession(match.id);
});
$("mobile-nav-toggle").addEventListener("click", () => setDrawer("sessions", !$("sessions-drawer").classList.contains("open")));
$("mobile-context-toggle").addEventListener("click", () => setDrawer("context", !$("context-panel").classList.contains("open")));
$("close-context").addEventListener("click", () => setDrawer("context", false));
$("drawer-scrim").addEventListener("click", () => {
  setDrawer("sessions", false);
  setDrawer("context", false);
});
$("show-tree").addEventListener("click", () => state.sessionId && openTree(state.sessionId));
$("context-tree").addEventListener("click", () => state.sessionId && openTree(state.sessionId));
$("fork-session").addEventListener("click", async () => {
  const latest = nodePath(state.nodes, state.nodeId).at(-1);
  if (!state.sessionId || !latest) return notify("Send a message before creating a branch.");
  try { await forkFromNode(state.sessionId, latest.id); notify("A new branch is ready."); }
  catch (error) { notify(error instanceof Error ? error.message : String(error)); }
});
$("session-actions").addEventListener("click", (event) => {
  if (state.sessionId) openSessionMenu(event, state.sessionId);
});
$("export-session").addEventListener("click", () => exportCurrentSession());
$("context-export").addEventListener("click", () => exportCurrentSession());
$("stop").addEventListener("click", () => {
  if (state.controller) {
    state.controller.abort();
    $("session-meta").textContent = "Stopping…";
  }
});
$("attach-file").addEventListener("click", () => $("attachment-input").click());
$("attachment-input").addEventListener("change", async (event) => {
  const file = event.currentTarget.files?.[0];
  event.currentTarget.value = "";
  if (!file) return;
  if (file.size > 1_000_000) {
    notify("Files larger than 1 MB are not supported.");
    return;
  }
  const text = await file.text().catch(() => "");
  if (!text || text.includes("\u0000")) {
    // Binary attachments would be mangled by a text round-trip; say so instead of
    // silently sending garbage to the model.
    notify(`${file.name} looks binary; only text files can be attached.`);
    return;
  }
  state.attachment = { name: file.name, text: text.slice(0, 100_000) };
  renderAttachment();
  notify(`${file.name} will be appended to your next message.`);
});
function setModelLabel(model, contextLimit) {
  state.model = model || state.model;
  if (!state.model) return;
  if (contextLimit) state.contextLimit = contextLimit;
  for (const id of ["model-name", "composer-model-name", "run-model"]) {
    const node = $(id);
    if (node) node.textContent = state.model;
  }
  setContextLabel();
}

function setContextLabel() {
  const context = $("run-context");
  if (!context || !state.contextLimit) return;
  const limit = `${Math.round(state.contextLimit / 1000)}K`;
  if (!state.contextUsed) {
    context.textContent = limit;
    context.title = "Context window size; usage appears after the first turn.";
    return;
  }
  const used = state.contextUsed < 1000 ? String(state.contextUsed) : `${(state.contextUsed / 1000).toFixed(1)}K`;
  context.textContent = `${used} / ${limit}`;
  context.title = `Last turn used ${state.contextUsed.toLocaleString()} prompt tokens`;
}
request("/api/health").then((health) => {
  $("health-dot").classList.toggle("ok", health.ok);
  const healthLabel = health.memoryAvailable ? "Online · memory on" : "Online · memory off";
  $("health-text").textContent = healthLabel;
  $("health-dot").setAttribute("aria-label", healthLabel);
  $("health-dot").title = healthLabel;
  setModelLabel(health.model, health.contextLimit);
  const workspaceEl = $("workspace-name");
  if (workspaceEl && health.workspace) {
    const parts = String(health.workspace).split(/[\\/]/).filter(Boolean);
    workspaceEl.textContent = parts[parts.length - 1] || "Workspace";
    workspaceEl.title = health.workspace;
  }
  if (document.querySelector(".empty-state")) showEmptyState();
}).catch(() => {
  $("health-text").textContent = "Offline";
  $("health-dot").classList.remove("ok");
  $("health-dot").setAttribute("aria-label", "Offline");
  $("health-dot").title = "Offline";
});

document.querySelectorAll("[data-panel]").forEach((button) => button.addEventListener("click", () => {
  const panel = button.dataset.panel;
  if (panel === "memory") {
    setDrawer("context", true);
    memoryPanel.open = true;
    if (!state.memoriesLoaded) loadMemories().catch(() => notify("Memories are unavailable right now."));
    return;
  }
  const section = document.querySelector(".capability-section");
  setDrawer("context", true);
  if (!section) return;
  section.scrollIntoView({ block: "center", behavior: "smooth" });
  section.classList.add("is-target");
  setTimeout(() => section.classList.remove("is-target"), 1200);
}));
const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
const modKey = isMac ? "\u2318" : "Ctrl";
$("search-kbd").textContent = `${modKey} K`;
$("new-session-kbd").textContent = `${modKey} J`;
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    $("global-search").focus();
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
    event.preventDefault();
    $("new-session").click();
  }
  if (event.key === "Escape") {
    setDrawer("sessions", false);
    setDrawer("context", false);
  }
});
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
  // An IME candidate window owns Enter in Chinese, Japanese and Korean input.
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});

refreshSessions().catch((error) => { $("session-meta").textContent = error.message; });
loadMemories().catch(() => {
  memoryCountEl.textContent = "!";
  memoriesEl.innerHTML = '<div class="memory-empty">Memories are unavailable right now.</div>';
});
