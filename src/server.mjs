// Copyright 2026 Roni Tervo
// SPDX-License-Identifier: Apache-2.0

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = resolve(__dirname, "..");
const workspaceDir = resolve(rootDir, "..");
const publicDir = join(rootDir, "public");
const port = Number(process.env.AGENT_HOME_PORT || 18880);
const isWindows = process.platform === "win32";

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
]);

const redactPatterns = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /(token|password|secret|api[_-]?key|authorization)\s*[:=]\s*["']?[^"'\s,;]+/gi,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
];

let cachedSnapshot = null;
let cachedAt = 0;
let inFlightSnapshot = null;

function runFile(file, args, { timeoutMs = 12000, displayCommand = null, collector = null, cwd = null } = {}) {
  return new Promise((resolveRun) => {
    const startedAt = Date.now();
    execFile(
      file,
      args,
      {
        cwd: cwd || undefined,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const endedAt = Date.now();
        resolveRun({
          ok: !error,
          collector,
          command: displayCommand || [file, ...args].join(" "),
          startedAt,
          endedAt,
          durationMs: endedAt - startedAt,
          code: error?.code ?? 0,
          signal: error?.signal ?? null,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          error: error ? String(error.message || error) : null,
        });
      },
    );
  });
}

async function runGit(args, options = {}) {
  return runFile("git", args, {
    timeoutMs: options.timeoutMs || 8000,
    collector: options.collector || "git",
    cwd: options.cwd || rootDir,
    displayCommand: `git ${args.join(" ")}`,
  });
}

async function runOpenClaw(args, options) {
  const displayCommand = `openclaw ${args.join(" ")}`;
  if (isWindows) {
    return runFile("cmd.exe", ["/d", "/s", "/c", "openclaw", ...args], { ...options, displayCommand });
  }
  return runFile("openclaw", args, { ...options, displayCommand });
}

async function runPowerShell(script, options) {
  if (!isWindows) {
    return { ok: false, stdout: "", stderr: "", error: "PowerShell collection is Windows-only", command: "powershell", durationMs: 0 };
  }
  return runFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    ...options,
    displayCommand: options?.displayCommand || "powershell -NoProfile -Command <windows posture snapshot>",
  });
}

function tryJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function redact(value) {
  if (value == null) return value;
  let text = String(value);
  for (const pattern of redactPatterns) {
    text = text.replace(pattern, "[redacted]");
  }
  return text;
}

function compactText(value, max = 180) {
  const text = redact(value ?? "")
    .replace(/\uFFFD/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}...`;
}

function ageMs(timestamp, now) {
  if (!Number.isFinite(Number(timestamp))) return null;
  return Math.max(0, now - Number(timestamp));
}

function statusLabel(status) {
  if (!status) return "unknown";
  if (["succeeded", "done", "completed", "ok"].includes(status)) return "done";
  if (["running", "queued"].includes(status)) return status;
  if (["failed", "timed_out", "cancelled", "lost", "blocked"].includes(status)) return status;
  return String(status);
}

function chooseFocus(sessions, tasks, now) {
  const activeTask = tasks.find((task) => ["running", "queued"].includes(task.status));
  if (activeTask) {
    return {
      title: activeTask.label || compactText(activeTask.task, 72) || "Active OpenClaw task",
      state: activeTask.status,
      detail: `${activeTask.runtime || "task"} ${activeTask.runId ? `run ${activeTask.runId.slice(0, 8)}` : ""}`.trim(),
      ageMs: ageMs(activeTask.startedAt || activeTask.createdAt, now),
      sessionKey: activeTask.childSessionKey || activeTask.ownerKey || activeTask.requesterSessionKey || null,
    };
  }

  const recent = [...sessions].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0];
  if (recent) {
    return {
      title: recent.kind === "direct" ? "Direct conversation" : `${recent.kind || "session"} session`,
      state: recent.ageMs != null && recent.ageMs < 5 * 60 * 1000 ? "active" : "idle",
      detail: `${recent.agentId || "agent"} · ${recent.modelProvider || ""}/${recent.model || ""}`.replace(" · /", " · "),
      ageMs: recent.ageMs ?? ageMs(recent.updatedAt, now),
      sessionKey: recent.key,
    };
  }

  return {
    title: "No recent session",
    state: "idle",
    detail: "Waiting for work",
    ageMs: null,
    sessionKey: null,
  };
}

function buildAgents(statusJson, sessionsJson, tasksJson, now) {
  const sessions = Array.isArray(sessionsJson?.sessions) ? sessionsJson.sessions : [];
  const tasks = Array.isArray(tasksJson?.tasks) ? tasksJson.tasks : [];
  const agents = Array.isArray(statusJson?.agents?.agents) ? statusJson.agents.agents : [];

  const tasksByChildSession = new Map();
  for (const task of tasks) {
    const key = task.childSessionKey || task.ownerKey;
    if (!key) continue;
    const list = tasksByChildSession.get(key) || [];
    list.push(task);
    tasksByChildSession.set(key, list);
  }

  return agents.map((agent) => {
    const agentSessions = sessions
      .filter((session) => session.agentId === agent.id)
      .map((session) => {
        const linkedTasks = tasksByChildSession.get(session.key) || [];
        return {
          key: session.key,
          kind: session.kind || "session",
          model: [session.modelProvider, session.model].filter(Boolean).join("/"),
          runtime: session.agentRuntime?.id || session.runtime || null,
          updatedAgeMs: session.ageMs ?? ageMs(session.updatedAt, now),
          totalTokens: Number.isFinite(Number(session.totalTokens)) ? Number(session.totalTokens) : null,
          contextTokens: Number.isFinite(Number(session.contextTokens)) ? Number(session.contextTokens) : null,
          remainingTokens: Number.isFinite(Number(session.remainingTokens)) ? Number(session.remainingTokens) : null,
          inputTokens: Number.isFinite(Number(session.inputTokens)) ? Number(session.inputTokens) : null,
          outputTokens: Number.isFinite(Number(session.outputTokens)) ? Number(session.outputTokens) : null,
          percentUsed: Number.isFinite(Number(session.totalTokens)) && Number.isFinite(Number(session.contextTokens))
            ? Math.round((Number(session.totalTokens) / Number(session.contextTokens)) * 100)
            : null,
          thinkingLevel: session.thinkingLevel || null,
          status: linkedTasks.some((task) => task.status === "running")
            ? "running"
            : linkedTasks.some((task) => task.status === "queued")
              ? "queued"
              : session.kind === "spawn-child"
                ? "child"
                : "active",
          tasks: linkedTasks.map((task) => ({
            taskId: task.taskId,
            runId: task.runId,
            runtime: task.runtime,
            status: statusLabel(task.status),
            label: task.label || compactText(task.terminalSummary || task.task, 96),
          })),
        };
      });

    return {
      id: agent.id,
      isDefault: statusJson?.agents?.defaultId === agent.id,
      workspaceDir: agent.workspaceDir || null,
      sessionsCount: agent.sessionsCount ?? agentSessions.length,
      lastActiveAgeMs: agent.lastActiveAgeMs ?? null,
      sessions: agentSessions,
    };
  });
}

function buildTasks(tasksJson) {
  const tasks = Array.isArray(tasksJson?.tasks) ? tasksJson.tasks : [];
  const byRun = new Map();

  for (const task of tasks) {
    const key = task.runId || task.taskId;
    const existing = byRun.get(key);
    const summary = compactText(task.progressSummary || task.terminalSummary || task.label || task.task, 220);
    const normalizedTask = {
      taskId: task.taskId,
      runId: task.runId,
      runtime: task.runtime || "task",
      status: statusLabel(task.status),
      label: task.label || summary || `${task.runtime || "Task"} ${task.taskId?.slice(0, 8) || ""}`.trim(),
      summary,
      requesterSessionKey: task.requesterSessionKey || null,
      ownerKey: task.ownerKey || null,
      childSessionKey: task.childSessionKey || null,
      createdAt: task.createdAt || null,
      startedAt: task.startedAt || null,
      endedAt: task.endedAt || null,
      lastEventAt: task.lastEventAt || null,
    };

    if (!existing) {
      byRun.set(key, { ...normalizedTask, relatedTaskIds: [task.taskId].filter(Boolean), runtimes: [normalizedTask.runtime] });
      continue;
    }

    existing.relatedTaskIds = [...new Set([...existing.relatedTaskIds, task.taskId].filter(Boolean))];
    existing.runtimes = [...new Set([...existing.runtimes, normalizedTask.runtime].filter(Boolean))];
    existing.status = existing.status === "running" || normalizedTask.status === "running"
      ? "running"
      : existing.status === "queued" || normalizedTask.status === "queued"
        ? "queued"
        : normalizedTask.status;
    if (!existing.label || existing.label.startsWith("Task ")) existing.label = normalizedTask.label;
    if (!existing.summary && normalizedTask.summary) existing.summary = normalizedTask.summary;
  }

  return [...byRun.values()].sort((a, b) => Number(b.lastEventAt || b.createdAt || 0) - Number(a.lastEventAt || a.createdAt || 0));
}

function parseSecurityAudit(text) {
  const summary = text.match(/Summary:\s*([^\r\n]+)/i)?.[1]?.trim() || "not checked";
  const warnings = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^(WARN|CRITICAL|INFO)\b/.test(line.trim())) {
      warnings.push(line.trim());
    }
  }
  return { summary, warnings: warnings.slice(0, 8) };
}

function buildAttention({ statusJson, tasks, security, windows }) {
  const items = [];

  if (!statusJson?.gateway?.reachable) {
    items.push({
      severity: "urgent",
      source: "gateway",
      title: "Gateway unreachable",
      reason: compactText(statusJson?.gateway?.error || "OpenClaw Gateway did not report reachable."),
    });
  }

  const channelEntries = Object.entries(statusJson?.health?.channels || {});
  for (const [name, channel] of channelEntries) {
    if (channel.enabled && !channel.connected) {
      items.push({
        severity: "warning",
        source: "channel",
        title: `${name} disconnected`,
        reason: compactText(channel.lastError || "Configured channel is not connected."),
      });
    }
  }

  for (const task of tasks) {
    if (["failed", "timed_out", "cancelled", "lost", "blocked"].includes(task.status)) {
      items.push({
        severity: "warning",
        source: "task",
        title: task.label || "Task needs review",
        reason: task.summary || `Task status is ${task.status}.`,
      });
    }
  }

  if (statusJson?.taskAudit?.warnings || statusJson?.taskAudit?.errors) {
    items.push({
      severity: statusJson.taskAudit.errors ? "urgent" : "warning",
      source: "tasks",
      title: "Task audit has findings",
      reason: `${statusJson.taskAudit.errors || 0} errors, ${statusJson.taskAudit.warnings || 0} warnings.`,
    });
  }

  if (security?.summary && !/^0 critical/i.test(security.summary)) {
    items.push({
      severity: security.summary.includes("critical") && !security.summary.startsWith("0 critical") ? "urgent" : "notice",
      source: "security",
      title: "Security audit note",
      reason: security.summary,
    });
  }

  const bitlockerRows = Array.isArray(windows?.bitlocker) ? windows.bitlocker : windows?.bitlocker ? [windows.bitlocker] : [];
  const bitlockerOff = bitlockerRows.some((volume) => {
    const status = String(volume.ProtectionStatus).toLowerCase();
    return status === "off" || status === "0";
  });
  if (bitlockerOff) {
    items.push({
      severity: "notice",
      source: "windows",
      title: "BitLocker is off",
      reason: "At least one local volume reports BitLocker protection off.",
    });
  }

  const tpmRestartPending = windows?.tpm?.RestartPending === true;
  if (tpmRestartPending) {
    items.push({
      severity: "info",
      source: "windows",
      title: "TPM restart pending",
      reason: "Windows reports TPM restart pending; defer disk-encryption changes until after reboot.",
    });
  }

  return items.slice(0, 8);
}

function buildRecentEvents(statusJson, tasks, sessionsJson, security) {
  const events = [];
  for (const task of tasks.slice(0, 5)) {
    events.push({
      at: task.lastEventAt || task.endedAt || task.startedAt || task.createdAt || null,
      source: task.runtime,
      title: task.label || "Task activity",
      detail: task.status,
    });
  }

  for (const session of (sessionsJson?.sessions || []).slice(0, 5)) {
    events.push({
      at: session.updatedAt || null,
      source: session.kind || "session",
      title: session.kind === "spawn-child" ? "Subagent session updated" : "Session updated",
      detail: [session.agentId, session.model].filter(Boolean).join(" · "),
    });
  }

  if (security?.summary) {
    events.push({
      at: Date.now(),
      source: "security",
      title: "Security audit sampled",
      detail: security.summary,
    });
  }

  return events
    .filter((event) => event.title)
    .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))
    .slice(0, 10);
}

function buildIntegrations(statusJson, cronStatus, cronList, windows) {
  const channels = Object.entries(statusJson?.health?.channels || {}).map(([name, value]) => ({
    id: name,
    status: value.connected ? "connected" : value.running ? "running" : "offline",
    detail: value.mode || null,
  }));

  const nodes = [{
    id: "local-node-service",
    status: statusJson?.nodeService?.installed ? statusJson.nodeService.runtime?.status || "installed" : "not installed",
    detail: statusJson?.nodeService?.installed ? compactText(statusJson?.nodeService?.runtimeShort, 120) : "Node host service is optional and not installed.",
  }];

  return {
    channels,
    nodes,
    schedule: {
      enabled: cronStatus?.enabled ?? null,
      jobs: cronList?.jobs || [],
      nextWakeAtMs: cronStatus?.nextWakeAtMs || null,
    },
    memory: {
      enabled: Boolean(statusJson?.memoryPlugin?.enabled),
      slot: statusJson?.memoryPlugin?.slot || null,
      lastHeartbeat: statusJson?.lastHeartbeat || null,
    },
    windows,
    workboard: {
      available: false,
      status: "optional source not enabled",
    },
  };
}

function latestSession(sessionsJson) {
  const sessions = Array.isArray(sessionsJson?.sessions) ? sessionsJson.sessions : [];
  return [...sessions].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0] || null;
}

function sessionArtifactPath(session, suffix) {
  if (!session?.agentId || !session?.sessionId) return null;
  return join(homedir(), ".openclaw", "agents", session.agentId, "sessions", `${session.sessionId}${suffix}`);
}

async function readJsonlTail(file, limit = 120) {
  if (!file) return [];
  try {
    const text = await readFile(file, "utf8");
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => tryJson(line, null))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function textFromContent(content, max = 240) {
  if (typeof content === "string") return compactText(content, max);
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (typeof item === "string") parts.push(item);
    else if (item?.type === "text" && item.text) parts.push(item.text);
    else if (item?.type === "toolResult" && (item.text || item.content)) parts.push(item.text || item.content);
    else if (item?.type === "image" || item?.mimeType?.startsWith?.("image/")) parts.push("[image]");
  }
  return compactText(parts.join(" "), max);
}

function compactValue(value, max = 180) {
  if (value == null) return "";
  if (typeof value === "string") return compactText(value, max);
  return compactText(JSON.stringify(value), max);
}

function toolCommandFromMessage(message) {
  const calls = Array.isArray(message?.content) ? message.content.filter((item) => item?.type === "toolCall") : [];
  return calls.map((call) => ({
    id: call.id || call.toolCallId || null,
    at: message.timestamp || null,
    source: "tool",
    kind: call.name || "tool",
    status: "running",
    title: `${call.name || "tool"} requested`,
    command: compactValue(call.arguments?.command || call.input?.command || call.arguments || call.input || "", 180),
    detail: compactText(call.arguments?.cwd || call.input?.cwd || "", 120),
  }));
}

function parseTranscriptMessages(lines) {
  const messages = [];
  const toolEvents = [];

  for (const row of lines) {
    const message = row.message || {};
    const at = row.timestamp || message.timestamp || null;
    if (message.role === "user") {
      messages.push({
        at,
        channel: message.sourceChannel || "openclaw",
        actor: message.senderName || "Roni",
        role: "human",
        text: textFromContent(message.content, 360),
      });
    } else if (message.role === "assistant") {
      const text = textFromContent(message.content, 360);
      if (text) {
        messages.push({
          at,
          channel: "openclaw",
          actor: "Vale",
          role: "agent",
          text,
        });
      }
      toolEvents.push(...toolCommandFromMessage(message));
    } else if (message.role === "toolResult") {
      toolEvents.push({
        id: message.toolCallId || null,
        at,
        source: "tool",
        kind: message.toolName || "tool",
        status: message.isError ? "failed" : "done",
        title: `${message.toolName || "tool"} ${message.isError ? "failed" : "completed"}`,
        command: message.toolCallId || "",
        detail: textFromContent(message.content, 220),
      });
    }
  }

  return {
    messages: messages.filter((item) => item.text).slice(-9),
    toolEvents: toolEvents.filter((item) => item.title).slice(-10),
  };
}

function parseTrajectory(lines) {
  return lines.map((row) => {
    const data = row.data || {};
    if (row.type === "tool.call") {
      return {
        id: data.toolCallId || null,
        at: row.ts,
        source: "trajectory",
        kind: data.name || "tool",
        status: "running",
        title: `${data.name || "tool"} command`,
        command: compactValue(data.arguments?.command || data.arguments || "", 220),
        detail: compactText(data.arguments?.cwd || row.sessionKey || "", 140),
      };
    }
    if (row.type === "tool.result") {
      return {
        id: data.toolCallId || null,
        at: row.ts,
        source: "trajectory",
        kind: data.name || "tool",
        status: data.isError ? "failed" : statusLabel(data.status || data.result?.status),
        title: `${data.name || "tool"} ${data.isError ? "failed" : "finished"}`,
        command: compactText(data.result ? JSON.stringify(data.result) : "", 140),
        detail: compactText(data.output || "", 240),
        durationMs: data.result?.durationMs ?? null,
      };
    }
    return null;
  }).filter(Boolean).slice(-14);
}

async function collectTranscript(sessionsJson) {
  const session = latestSession(sessionsJson);
  const transcriptLines = await readJsonlTail(sessionArtifactPath(session, ".jsonl"), 110);
  const trajectoryLines = await readJsonlTail(sessionArtifactPath(session, ".trajectory.jsonl"), 120);
  const parsed = parseTranscriptMessages(transcriptLines);
  const trajectory = parseTrajectory(trajectoryLines);
  return {
    sessionKey: session?.key || null,
    sessionId: session?.sessionId || null,
    messages: parsed.messages,
    toolEvents: [...parsed.toolEvents, ...trajectory]
      .sort((a, b) => new Date(a.at || 0).getTime() - new Date(b.at || 0).getTime())
      .slice(-14),
    source: "openclaw-session-store",
  };
}

function commandEvent(label, result, outputMax = 220) {
  return {
    at: new Date(result?.endedAt || Date.now()).toISOString(),
    source: "collector",
    kind: result?.collector || label,
    status: result?.ok ? "done" : "failed",
    title: `${label} ${result?.ok ? "ok" : "needs review"}`,
    command: result?.command || label,
    detail: compactText(result?.stdout || result?.stderr || result?.error || "no output", outputMax),
    durationMs: result?.durationMs ?? null,
    code: result?.code ?? null,
  };
}

function chooseActiveEvent({ transcript, commandEvents, tasks, attention }) {
  const timeline = [...(transcript.toolEvents || []), ...(commandEvents || [])]
    .sort((a, b) => new Date(a.at || 0).getTime() - new Date(b.at || 0).getTime());
  const openRunning = timeline.findLast?.((event, index, events) => {
    if (event.status !== "running") return false;
    if (!event.id) return true;
    return !events.slice(index + 1).some((later) => later.id === event.id && later.status !== "running");
  });

  const running = openRunning
    || tasks.find((task) => ["running", "queued"].includes(task.status));
  if (running) {
    return {
      status: running.status || "running",
      title: running.title || running.label || "OpenClaw is working",
      command: running.command || running.summary || "",
      detail: running.detail || running.summary || "Active event is in progress.",
      durationMs: running.durationMs ?? null,
    };
  }

  const latest = timeline.at(-1);
  if (latest) {
    return {
      status: latest.status || "done",
      title: latest.title,
      command: latest.command || "",
      detail: latest.detail || "",
      durationMs: latest.durationMs ?? null,
    };
  }

  const blocker = attention[0];
  if (blocker) {
    return { status: blocker.severity, title: blocker.title, command: blocker.source, detail: blocker.reason };
  }

  return { status: "quiet", title: "No active command", command: "waiting", detail: "OpenClaw is ready." };
}

function numberLabel(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "unknown";
  return new Intl.NumberFormat("en-US", { notation: numeric >= 100000 ? "compact" : "standard" }).format(numeric);
}

function currentMode(snapshot) {
  if ((snapshot.attention || []).some((item) => ["urgent", "warning"].includes(item.severity))) return "needs-you";
  if (["running", "queued", "active"].includes(snapshot.focus?.state) || snapshot.taskSummary?.active) return "working";
  return "quiet";
}

function modeLabel(mode) {
  if (mode === "needs-you") return "Needs You";
  if (mode === "working") return "Working";
  return "Quiet";
}

function flattenSessions(snapshot) {
  return (snapshot.agents || [])
    .flatMap((agent) => (agent.sessions || []).map((session) => ({ agent, session })))
    .sort((a, b) => Number(a.session.updatedAgeMs ?? 0) - Number(b.session.updatedAgeMs ?? 0));
}

function buildUiViewModel(snapshot) {
  const mode = currentMode(snapshot);
  const channel = snapshot.integrations?.channels?.[0] || null;
  const sessions = flattenSessions(snapshot);
  const current = sessions[0]?.session || null;
  const collectors = Object.entries(snapshot.collectors || {});
  const okCollectors = collectors.filter(([, value]) => value.ok).length;
  const windows = snapshot.integrations?.windows || {};
  const terminalEvents = [...(snapshot.transcript?.toolEvents || []), ...(snapshot.commandEvents || [])]
    .sort((a, b) => new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime())
    .slice(0, 9)
    .map((event) => ({
      at: event.at || null,
      status: event.status || "unknown",
      title: event.title || event.kind || "event",
      command: event.command || event.kind || "",
      detail: event.detail || "",
      durationMs: event.durationMs ?? null,
      source: event.source || "openclaw",
    }));

  const proofCards = [
    ["Context", current?.percentUsed != null ? `${current.percentUsed}% used` : "unknown", current?.percentUsed > 80 ? "warning" : "ok"],
    ["Tokens", current ? `${numberLabel(current.totalTokens)} / ${numberLabel(current.contextTokens)}` : "unknown", "neutral"],
    ["Collectors", `${okCollectors}/${collectors.length} ok`, okCollectors === collectors.length ? "ok" : "warning"],
    ["Tasks", `${snapshot.taskSummary?.active || 0} live`, snapshot.taskSummary?.active ? "active" : "neutral"],
    ["Defender", windows.defender?.RealTimeProtectionEnabled === true ? "on" : "unknown", windows.defender?.RealTimeProtectionEnabled === true ? "ok" : "notice"],
    ["Gateway", snapshot.gateway?.latencyMs != null ? `${snapshot.gateway.latencyMs} ms` : snapshot.gateway?.status || "unknown", snapshot.gateway?.status || "unknown"],
  ].map(([label, value, status]) => ({ label, value, status }));

  const sensors = [
    ["Mode", modeLabel(mode), mode],
    ["Messages", `${snapshot.transcript?.messages?.length || 0}`, "active"],
    ["Tool Events", `${snapshot.transcript?.toolEvents?.length || 0}`, "active"],
    ["Commands", `${snapshot.commandEvents?.length || 0}`, "active"],
    ["Collectors", `${okCollectors}/${collectors.length}`, okCollectors === collectors.length ? "ok" : "warning"],
    ["Context", current?.percentUsed != null ? `${current.percentUsed}%` : "unknown", current?.percentUsed > 80 ? "warning" : "ok"],
    ["Updated", snapshot.generatedAt, "active"],
  ].map(([label, value, status]) => ({ label, value, status }));

  return {
    schemaVersion: 1,
    generatedAt: snapshot.generatedAt,
    mode,
    modeLabel: modeLabel(mode),
    title: "OpenClaw Signal Desk",
    subtitle: "Agent Home",
    topPills: [
      { label: modeLabel(mode), status: mode },
      { label: `Gateway ${snapshot.gateway?.status || "unknown"}`, status: snapshot.gateway?.status || "unknown" },
      { label: channel ? `${channel.id} ${channel.status}` : "no channel", status: channel?.status || "unknown" },
      { label: `${snapshot.transcript?.messages?.length || 0} messages`, status: "active" },
      { label: snapshot.generatedAt, status: "active", kind: "timestamp" },
    ],
    conversation: {
      title: "OpenClaw Messages",
      kicker: "Telegram-origin session",
      source: snapshot.transcript?.source || "unknown",
      sessionKey: snapshot.transcript?.sessionKey || null,
      messages: snapshot.transcript?.messages || [],
    },
    activeEvent: {
      status: snapshot.activeEvent?.status || mode,
      title: snapshot.activeEvent?.title || snapshot.focus?.title || "OpenClaw is ready",
      command: snapshot.activeEvent?.command || "",
      detail: snapshot.activeEvent?.detail || snapshot.focus?.detail || "",
      durationMs: snapshot.activeEvent?.durationMs ?? null,
    },
    terminal: {
      title: "PowerShell / Tool Transparency",
      kicker: "calls, status, output",
      events: terminalEvents,
    },
    proof: {
      title: "Proof",
      kicker: "machine-readable state",
      cards: proofCards,
    },
    attention: {
      title: "Attention",
      count: snapshot.attention?.length || 0,
      items: (snapshot.attention || []).slice(0, 4),
    },
    fileEdits: snapshot.fileEdits || {
      title: "File Edits",
      count: 0,
      exactHunksAvailable: false,
      items: [],
    },
    sensors,
    handoff: {
      rawSnapshotUrl: "/api/snapshot",
      viewUrl: "/api/view",
      refreshMs: 8000,
      maxConversationRows: 9,
      maxTerminalRows: 9,
      maxFileEditRows: 3,
      maxProofCards: 6,
      maxAttentionRows: 4,
    },
  };
}

function statusName(code) {
  if (code.includes("??")) return "untracked";
  if (code.includes("A")) return "added";
  if (code.includes("M")) return "modified";
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  return "changed";
}

function parseNumstat(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [added, removed, path] = line.split(/\t/);
    if (!path) continue;
    map.set(path, {
      added: Number.isFinite(Number(added)) ? Number(added) : null,
      removed: Number.isFinite(Number(removed)) ? Number(removed) : null,
    });
  }
  return map;
}

function parseDiffHunks(text) {
  const byPath = new Map();
  let currentPath = null;
  let currentHunk = null;
  for (const line of text.split(/\r?\n/)) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)/);
    if (fileMatch) {
      currentPath = fileMatch[1];
      if (!byPath.has(currentPath)) byPath.set(currentPath, []);
      currentHunk = null;
      continue;
    }
    if (!currentPath) continue;
    if (line.startsWith("@@")) {
      currentHunk = { header: line, lines: [] };
      byPath.get(currentPath).push(currentHunk);
      continue;
    }
    if (currentHunk && /^[ +\-]/.test(line)) {
      currentHunk.lines.push(compactText(line, 160));
    }
  }
  return byPath;
}

function parseRawDiffs(text) {
  const byPath = new Map();
  let currentPath = null;
  let currentLines = [];
  const flush = () => {
    if (currentPath) byPath.set(currentPath, currentLines.join("\n"));
  };

  for (const line of text.split(/\r?\n/)) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)/);
    if (diffMatch) {
      flush();
      currentPath = diffMatch[2];
      currentLines = [line];
      continue;
    }
    if (currentPath) currentLines.push(line);
  }
  flush();
  return byPath;
}

function truncateRawText(text, max = 12000) {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max).trimEnd()}\n...[truncated]`, truncated: true };
}

async function readTextFile(relativePath) {
  const target = normalize(join(rootDir, relativePath));
  if (!target.startsWith(rootDir)) return null;
  if (/\.(png|jpg|jpeg|gif|webp|ico|zip|exe|dll|pdf)$/i.test(relativePath)) return null;
  try {
    return await readFile(target, "utf8");
  } catch {
    return null;
  }
}

function synthesizeNewFilePatch(relativePath, text) {
  const lines = text.split(/\r?\n/);
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

async function collectFileEdits() {
  const [statusResult, numstatResult, cachedNumstatResult, diffResult, cachedDiffResult] = await Promise.all([
    runGit(["status", "--short", "--untracked-files=all", "--", "."], { collector: "gitStatus" }),
    runGit(["diff", "--numstat", "--", "."], { collector: "gitNumstat" }),
    runGit(["diff", "--cached", "--numstat", "--", "."], { collector: "gitCachedNumstat" }),
    runGit(["diff", "--unified=2", "--", "."], { collector: "gitDiff", timeoutMs: 12000 }),
    runGit(["diff", "--cached", "--unified=2", "--", "."], { collector: "gitCachedDiff", timeoutMs: 12000 }),
  ]);

  const numstat = parseNumstat(numstatResult.stdout || "");
  for (const [path, stat] of parseNumstat(cachedNumstatResult.stdout || "")) numstat.set(path, stat);
  const diffText = [diffResult.stdout || "", cachedDiffResult.stdout || ""].filter(Boolean).join("\n");
  const hunks = parseDiffHunks(diffText);
  const rawDiffs = parseRawDiffs(diffText);
  const statusLines = (statusResult.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  const items = [];
  for (const line of statusLines.slice(0, 12)) {
    const code = line.slice(0, 2).trim() || line.slice(0, 2);
    const path = line.slice(3).trim();
    const stat = numstat.get(path) || {};
    const text = statusName(code) === "untracked" ? await readTextFile(path) : null;
    const lineCount = text == null ? null : text.length ? text.split(/\r?\n/).length : 0;
    const rawSource = rawDiffs.get(path)
      || (text != null ? synthesizeNewFilePatch(path, text) : "");
    const raw = rawSource ? truncateRawText(rawSource) : { text: null, truncated: false };
    items.push({
      path,
      status: statusName(code),
      code,
      added: stat.added ?? (lineCount != null ? lineCount : null),
      removed: stat.removed ?? 0,
      lineCount,
      exactHunks: hunks.get(path)?.slice(0, 3) || [],
      exactHunksAvailable: Boolean(hunks.get(path)?.length),
      rawPatch: raw.text,
      rawPatchTruncated: raw.truncated,
      rawPatchKind: rawDiffs.has(path)
        ? "git-diff"
        : text != null
          ? "untracked-file-as-addition"
          : "unavailable",
    });
  }

  return {
    title: "File Edits",
    kicker: "workspace changes",
    count: statusLines.length,
    shown: items.length,
    exactHunksAvailable: items.some((item) => item.exactHunksAvailable),
    baseline: statusLines.some((line) => line.startsWith("??"))
      ? "Some files are untracked; untracked text files are reported as whole-file additions until committed."
      : "Git baseline available; tracked files can include exact hunks.",
    items,
    collectors: {
      status: { ok: statusResult.ok, error: compactText(statusResult.error || statusResult.stderr, 120) },
      numstat: { ok: numstatResult.ok && cachedNumstatResult.ok, error: compactText(numstatResult.error || numstatResult.stderr || cachedNumstatResult.error || cachedNumstatResult.stderr, 120) },
      diff: { ok: diffResult.ok && cachedDiffResult.ok, error: compactText(diffResult.error || diffResult.stderr || cachedDiffResult.error || cachedDiffResult.stderr, 120) },
    },
  };
}

async function collectWindowsPosture() {
  const script = `
$ErrorActionPreference='SilentlyContinue'
$defender = Get-MpComputerStatus | Select-Object AMServiceEnabled,AntivirusEnabled,RealTimeProtectionEnabled,AntivirusSignatureLastUpdated,QuickScanAge,FullScanAge
$firewall = Get-NetFirewallProfile | ForEach-Object { [pscustomobject]@{ Name=$_.Name; Enabled=[bool]$_.Enabled; DefaultInboundAction=$_.DefaultInboundAction.ToString(); DefaultOutboundAction=$_.DefaultOutboundAction.ToString(); AllowInboundRules=[bool]$_.AllowInboundRules; LogBlocked=[bool]$_.LogBlocked } }
$bitlocker = Get-BitLockerVolume | ForEach-Object { [pscustomobject]@{ MountPoint=$_.MountPoint; VolumeType=$_.VolumeType.ToString(); ProtectionStatus=$_.ProtectionStatus.ToString(); EncryptionPercentage=$_.EncryptionPercentage; VolumeStatus=$_.VolumeStatus.ToString(); EncryptionMethod=$_.EncryptionMethod.ToString() } }
$smbClient = Get-SmbClientConfiguration | Select-Object EnableSecuritySignature,RequireSecuritySignature,EnableInsecureGuestLogons,EnableSMB1Protocol
$smbServer = Get-SmbServerConfiguration | Select-Object EnableSecuritySignature,RequireSecuritySignature,EnableSMB1Protocol,RejectUnencryptedAccess
$tpm = Get-Tpm | Select-Object TpmPresent,TpmReady,TpmEnabled,TpmActivated,TpmOwned,RestartPending
[pscustomobject]@{
  defender=$defender
  firewall=$firewall
  bitlocker=$bitlocker
  smbClient=$smbClient
  smbServer=$smbServer
  tpm=$tpm
} | ConvertTo-Json -Depth 6
`;
  const result = await runPowerShell(script, {
    timeoutMs: 15000,
    collector: "windows",
    displayCommand: "powershell Get-MpComputerStatus; Get-NetFirewallProfile; Get-BitLockerVolume; Get-Tpm",
  });
  if (!result.ok && !result.stdout.trim()) {
    return {
      available: false,
      ok: false,
      command: result.command,
      durationMs: result.durationMs,
      endedAt: result.endedAt,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      error: compactText(result.error || result.stderr || "Windows posture unavailable"),
    };
  }
  const parsed = tryJson(result.stdout, null);
  if (!parsed) {
    return {
      available: false,
      ok: false,
      command: result.command,
      durationMs: result.durationMs,
      endedAt: result.endedAt,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      error: "Windows posture JSON parse failed",
    };
  }
  return {
    available: true,
    ok: true,
    command: result.command,
    durationMs: result.durationMs,
    endedAt: result.endedAt,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    error: null,
    ...parsed,
  };
}

export async function collectSnapshot({ force = false } = {}) {
  const now = Date.now();
  if (!force && cachedSnapshot && now - cachedAt < 7000) return cachedSnapshot;
  if (inFlightSnapshot) return inFlightSnapshot;

  inFlightSnapshot = (async () => {
    const [statusResult, sessionsResult, tasksResult, cronStatusResult, cronListResult, securityResult, windows] = await Promise.all([
      runOpenClaw(["status", "--deep", "--json"], { timeoutMs: 18000, collector: "status" }),
      runOpenClaw(["sessions", "--all-agents", "--limit", "50", "--json"], { timeoutMs: 12000, collector: "sessions" }),
      runOpenClaw(["tasks", "list", "--json"], { timeoutMs: 12000, collector: "tasks" }),
      runOpenClaw(["cron", "status"], { timeoutMs: 12000, collector: "cronStatus" }),
      runOpenClaw(["cron", "list", "--json"], { timeoutMs: 12000, collector: "cronList" }),
      runOpenClaw(["security", "audit", "--deep"], { timeoutMs: 12000, collector: "security" }),
      collectWindowsPosture(),
    ]);

    const statusJson = tryJson(statusResult.stdout, {});
    const sessionsJson = tryJson(sessionsResult.stdout, { sessions: [] });
    const tasksJson = tryJson(tasksResult.stdout, { tasks: [] });
    const cronStatus = tryJson(cronStatusResult.stdout, {});
    const cronList = tryJson(cronListResult.stdout, { jobs: [] });
    const security = parseSecurityAudit(securityResult.stdout || securityResult.stderr || "");
    const tasks = buildTasks(tasksJson);
    const agents = buildAgents(statusJson, sessionsJson, tasksJson, now);
    const focus = chooseFocus(sessionsJson.sessions || [], tasks, now);
    const attention = buildAttention({ statusJson, tasks, security, windows });
    const transcript = await collectTranscript(sessionsJson);
    const commandEvents = [
      commandEvent("OpenClaw status", statusResult),
      commandEvent("Sessions", sessionsResult),
      commandEvent("Tasks", tasksResult),
      commandEvent("Cron status", cronStatusResult),
      commandEvent("Cron list", cronListResult),
      commandEvent("Security audit", securityResult),
      commandEvent("Windows posture", windows),
    ];
    const fileEdits = await collectFileEdits();
    const activeEvent = chooseActiveEvent({ transcript, commandEvents, tasks, attention });

    const snapshot = {
      schemaVersion: 1,
      generatedAt: new Date(now).toISOString(),
      privacy: {
        mode: "ambient",
        redactionVersion: 1,
      },
      identity: {
        product: "Agent Home",
        agentName: "Vale",
        workspace: "OpenClaw",
      },
      gateway: {
        status: statusJson?.gateway?.reachable && statusJson?.health?.ok ? "ok" : "degraded",
        version: statusJson?.runtimeVersion || statusJson?.gateway?.self?.version || null,
        url: statusJson?.gateway?.url || null,
        bind: statusJson?.gateway?.urlSource || null,
        latencyMs: statusJson?.gateway?.connectLatencyMs ?? null,
        service: statusJson?.gatewayService?.runtimeShort || null,
        warnings: [
          statusJson?.gateway?.authWarning,
          statusJson?.gatewayService?.runtime?.detail,
        ].filter(Boolean).map((item) => compactText(item, 160)),
      },
      focus,
      agents,
      tasks,
      taskSummary: statusJson?.tasks || null,
      attention,
      activeEvent,
      transcript,
      commandEvents,
      fileEdits,
      recentEvents: buildRecentEvents(statusJson, tasks, sessionsJson, security),
      integrations: buildIntegrations(statusJson, cronStatus, cronList, windows),
      collectors: {
        status: { ok: statusResult.ok, error: compactText(statusResult.error || statusResult.stderr, 120) },
        sessions: { ok: sessionsResult.ok, error: compactText(sessionsResult.error || sessionsResult.stderr, 120) },
        tasks: { ok: tasksResult.ok, error: compactText(tasksResult.error || tasksResult.stderr, 120) },
        cronStatus: { ok: cronStatusResult.ok, error: compactText(cronStatusResult.error || cronStatusResult.stderr, 120) },
        cronList: { ok: cronListResult.ok, error: compactText(cronListResult.error || cronListResult.stderr, 120) },
        security: { ok: securityResult.ok, error: compactText(securityResult.error || securityResult.stderr, 120) },
        windows: { ok: Boolean(windows?.available), error: windows?.error || null },
      },
    };
    snapshot.ui = buildUiViewModel(snapshot);

    cachedSnapshot = snapshot;
    cachedAt = Date.now();
    inFlightSnapshot = null;
    return snapshot;
  })().catch((error) => {
    inFlightSnapshot = null;
    if (cachedSnapshot) return { ...cachedSnapshot, stale: true, error: compactText(error?.message || error, 180) };
    throw error;
  });

  return inFlightSnapshot;
}

async function serveStatic(request, response) {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const rawPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const target = normalize(join(publicDir, rawPath));

  if (!target.startsWith(publicDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const data = await readFile(target);
    response.writeHead(200, {
      "content-type": contentTypes.get(extname(target)) || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(data);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

async function handleRequest(request, response) {
  try {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/api/snapshot") {
      const snapshot = await collectSnapshot({ force: url.searchParams.get("force") === "1" });
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(snapshot, null, 2));
      return;
    }

    if (url.pathname === "/api/view") {
      const snapshot = await collectSnapshot({ force: url.searchParams.get("force") === "1" });
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(snapshot.ui, null, 2));
      return;
    }

    if (url.pathname === "/api/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true, cachedAt, hasSnapshot: Boolean(cachedSnapshot) }));
      return;
    }

    await serveStatic(request, response);
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, error: compactText(error?.stack || error, 400) }));
  }
}

const isCliEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCliEntrypoint && process.argv.includes("--snapshot")) {
  const snapshot = await collectSnapshot({ force: true });
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
} else if (isCliEntrypoint) {
  createServer(handleRequest).listen(port, "127.0.0.1", () => {
    console.log(`Agent Home listening on http://127.0.0.1:${port}/`);
  });
}
