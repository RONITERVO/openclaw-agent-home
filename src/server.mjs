// Copyright 2026 Roni Tervo
// SPDX-License-Identifier: Apache-2.0

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { collectProcessMonitor } from "./process-monitor.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = resolve(__dirname, "..");
const workspaceDir = resolve(rootDir, "..");
const publicDir = resolve(rootDir, "public");
const port = Number(process.env.AGENT_HOME_PORT || 18880);
const isWindows = process.platform === "win32";
const transcriptSessionLimit = envInt("AGENT_HOME_TRANSCRIPT_SESSION_LIMIT", 8);
const transcriptMessageLimit = envInt("AGENT_HOME_TRANSCRIPT_MESSAGE_LIMIT", 9);
const taskFailureAttentionMs = envInt("AGENT_HOME_TASK_FAILURE_ATTENTION_MINUTES", 45) * 60 * 1000;

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

function envInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function isPathInsideDirectory(parent, target) {
  const relativePath = relative(parent, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

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

function timestampMs(value) {
  if (value == null) return null;
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function durationLabel(ms) {
  const duration = Math.max(0, Number(ms) || 0);
  if (duration < 1000) return "now";
  const seconds = Math.round(duration / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function confidenceRank(value) {
  if (value === "high") return 3;
  if (value === "medium") return 2;
  if (value === "low") return 1;
  return 0;
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

function taskAttentionItem(task, now) {
  if (!["failed", "timed_out", "cancelled", "lost", "blocked"].includes(task.status)) return null;
  if (task.status !== "blocked") {
    const eventAt = timestampMs(task.endedAt || task.lastEventAt || task.startedAt || task.createdAt);
    if (eventAt != null && now - eventAt > taskFailureAttentionMs) return null;
  }

  const eventAt = timestampMs(task.endedAt || task.lastEventAt || task.startedAt || task.createdAt);
  const ageLabel = eventAt == null ? "" : ` ${durationLabel(now - eventAt)} ago`;
  return {
    severity: task.status === "cancelled" ? "notice" : "warning",
    source: "task",
    title: task.label || "Task needs review",
    reason: compactText(`${task.summary || `Task status is ${task.status}.`}${ageLabel ? ` (${task.status}${ageLabel})` : ""}`, 220),
  };
}

function buildAttention({ statusJson, tasks, security, windows, processMonitor, now }) {
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
    const item = taskAttentionItem(task, now);
    if (item) items.push(item);
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

  if (processMonitor?.summary?.activeActivityCount) {
    const unknownEtaCount = (processMonitor.activities || [])
      .filter((activity) => activity.progress?.etaSeconds == null && activity.progress?.reason)
      .length;
    if (unknownEtaCount) {
      items.push({
        severity: "info",
        source: "process",
        title: "Process progress is observable",
        reason: `${processMonitor.summary.activeActivityCount} active process/file signal(s); ETA is marked unknown when Windows does not expose a reliable total.`,
      });
    }
  }

  return items.slice(0, 8);
}

function buildRecentEvents(statusJson, tasks, sessionsJson, security, processMonitor) {
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

  for (const event of processMonitor?.lifecycleEvents || []) {
    events.push({
      at: event.at || null,
      source: "process",
      title: `${event.name || "process"} ${event.status}`,
      detail: event.command || `pid ${event.pid}`,
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

function normalizeForecastItem(item, now) {
  const atMs = timestampMs(item.atMs ?? item.at);
  const etaMs = Number.isFinite(Number(item.etaMs)) ? Math.max(0, Number(item.etaMs)) : null;
  return {
    kind: item.kind || "unknown",
    status: item.status || "unknown",
    source: item.source || "backend",
    title: compactText(item.title || "Agent reaction signal", 96),
    detail: compactText(item.detail || "", 220),
    confidence: item.confidence || "low",
    at: atMs == null ? null : new Date(atMs).toISOString(),
    inMs: atMs == null ? null : Math.max(0, atMs - now),
    inLabel: atMs == null ? "unknown" : durationLabel(atMs - now),
    etaMs,
    etaLabel: etaMs == null ? "unknown" : durationLabel(etaMs),
    reason: compactText(item.reason || "", 260),
    evidence: (item.evidence || []).filter(Boolean).map((value) => compactText(value, 180)).slice(0, 5),
  };
}

function nextCronTimestamp(job) {
  const candidates = [
    job?.nextWakeAtMs,
    job?.nextRunAtMs,
    job?.nextAtMs,
    job?.nextRunAt,
    job?.nextAt,
    job?.scheduledAt,
  ];
  return candidates.map(timestampMs).find((value) => value != null) ?? null;
}

function heartbeatForecastItems(statusJson, now) {
  const heartbeat = statusJson?.heartbeat || {};
  const agents = Array.isArray(heartbeat.agents) ? heartbeat.agents : [];
  const lastHeartbeatAt = timestampMs(statusJson?.lastHeartbeat?.ts);
  return agents
    .filter((agent) => agent?.enabled && Number.isFinite(Number(agent.everyMs)))
    .map((agent) => {
      const everyMs = Number(agent.everyMs);
      let nextAt = lastHeartbeatAt == null ? null : lastHeartbeatAt + everyMs;
      if (nextAt != null && nextAt < now) {
        nextAt += Math.ceil((now - nextAt) / everyMs) * everyMs;
      }
      return normalizeForecastItem({
        kind: "heartbeat",
        status: "scheduled",
        source: "openclaw-status",
        title: `${agent.agentId || heartbeat.defaultAgentId || "agent"} heartbeat window`,
        detail: nextAt == null ? "Heartbeat is enabled, but the last heartbeat timestamp is not known." : `Every ${agent.every || durationLabel(everyMs)}.`,
        confidence: "medium",
        atMs: nextAt,
        reason: "Heartbeat is a scheduled opportunity for the agent to react. It can still skip when HEARTBEAT.md is empty, during quiet hours, or when there is nothing useful to say.",
        evidence: [
          `enabled=${Boolean(agent.enabled)}`,
          agent.every ? `interval=${agent.every}` : `intervalMs=${everyMs}`,
          statusJson?.lastHeartbeat?.status ? `last=${statusJson.lastHeartbeat.status}` : null,
        ],
      }, now);
    });
}

function cronForecastItems(cronStatus, cronList, now) {
  const items = [];
  const nextWakeAtMs = timestampMs(cronStatus?.nextWakeAtMs);
  if (cronStatus?.enabled && nextWakeAtMs != null) {
    items.push(normalizeForecastItem({
      kind: "cron-wake",
      status: "scheduled",
      source: "cron-status",
      title: "Next cron wake",
      detail: "OpenClaw cron reports a next wake timestamp.",
      confidence: "high",
      atMs: nextWakeAtMs,
      reason: "Cron exposes a concrete next wake timestamp. Delivery can still depend on the job and channel state.",
      evidence: [`jobs=${cronStatus.jobs ?? "unknown"}`],
    }, now));
  }

  for (const job of (cronList?.jobs || []).slice(0, 12)) {
    const atMs = nextCronTimestamp(job);
    if (atMs == null) continue;
    items.push(normalizeForecastItem({
      kind: "cron-job",
      status: "scheduled",
      source: "cron-list",
      title: job.name || job.id || "Scheduled job",
      detail: compactText(job.description || job.command || job.message || "", 180),
      confidence: "high",
      atMs,
      reason: "A cron job exposes its own next scheduled run time.",
      evidence: [job.id ? `id=${job.id}` : null, job.enabled === false ? "disabled" : "enabled"],
    }, now));
  }

  const seen = new Set();
  return items
    .filter((item) => {
      const key = `${item.kind}:${item.at}:${item.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => Number(a.inMs ?? Number.MAX_SAFE_INTEGER) - Number(b.inMs ?? Number.MAX_SAFE_INTEGER));
}

function processForecastItems(processMonitor, now) {
  return (processMonitor?.activities || []).slice(0, 6).map((activity) => {
    const etaSeconds = Number(activity.progress?.etaSeconds);
    const hasEta = Number.isFinite(etaSeconds) && etaSeconds >= 0;
    return normalizeForecastItem({
      kind: "process-completion",
      status: "working",
      source: "process-monitor",
      title: activity.title || "Observed local work",
      detail: compactText(activity.command || activity.progress?.reason || "", 180),
      confidence: hasEta ? activity.progress?.confidence || "medium" : "low",
      atMs: hasEta ? now + etaSeconds * 1000 : null,
      etaMs: hasEta ? etaSeconds * 1000 : null,
      reason: hasEta
        ? "A process activity exposes a concrete ETA."
        : activity.progress?.reason || "The PC exposes activity but not a reliable final total.",
      evidence: [
        activity.progress?.rateLabel ? `rate ${activity.progress.rateLabel}` : null,
        ...(activity.evidence || []),
      ],
    }, now);
  });
}

function latestRoleTimestamp(messages, role) {
  return messages
    .filter((message) => message.role === role)
    .map((message) => timestampMs(message.at))
    .filter((value) => value != null)
    .sort((a, b) => b - a)[0] ?? null;
}

function buildReactionForecast({ now, statusJson, cronStatus, cronList, tasks, transcript, processMonitor, attention }) {
  const items = [];
  const blockingAttention = (attention || []).find((item) => ["urgent", "warning"].includes(item.severity));
  if (blockingAttention) {
    items.push(normalizeForecastItem({
      kind: "needs-human",
      status: "waiting-for-user",
      source: blockingAttention.source || "attention",
      title: blockingAttention.title || "Needs you",
      detail: blockingAttention.reason || "",
      confidence: "high",
      reason: "The backend sees an unresolved attention item. The next useful agent reaction depends on human review or a state change.",
      evidence: [`severity=${blockingAttention.severity}`],
    }, now));
  }

  const openToolCalls = Array.isArray(transcript?.openToolCalls) ? transcript.openToolCalls : [];
  for (const call of openToolCalls.slice(0, 5)) {
    const startedAt = timestampMs(call.at);
    items.push(normalizeForecastItem({
      kind: "tool-return",
      status: "working",
      source: "session-trajectory",
      title: `${call.kind || "tool"} is running`,
      detail: call.command || call.detail || "",
      confidence: "medium",
      reason: "The session trajectory has a tool.call without a matching tool.result. The agent can react after that tool returns.",
      evidence: [
        startedAt == null ? null : `age ${durationLabel(now - startedAt)}`,
        call.detail || null,
      ],
    }, now));
  }

  for (const task of tasks.filter((item) => ["running", "queued"].includes(item.status)).slice(0, 8)) {
    const startedAt = timestampMs(task.startedAt);
    items.push(normalizeForecastItem({
      kind: task.status === "queued" ? "queued-task" : "running-task",
      status: task.status,
      source: task.runtime || "task",
      title: task.label || "OpenClaw task",
      detail: task.summary || "",
      confidence: task.status === "queued" ? "low" : "medium",
      reason: task.status === "queued"
        ? "A task is queued. The backend knows it should run, but not exactly when the runtime will start it."
        : "A task is running. The agent can react when the task posts a result or progress event.",
      evidence: [
        task.runId ? `run ${String(task.runId).slice(0, 8)}` : null,
        startedAt == null ? null : `age ${durationLabel(now - startedAt)}`,
      ],
    }, now));
  }

  items.push(...processForecastItems(processMonitor, now));

  const latestHumanAt = latestRoleTimestamp(transcript?.messages || [], "human");
  const latestAgentAt = latestRoleTimestamp(transcript?.messages || [], "agent");
  if (latestHumanAt != null && (latestAgentAt == null || latestHumanAt > latestAgentAt)) {
    items.push(normalizeForecastItem({
      kind: "pending-reply",
      status: "responding",
      source: "transcript",
      title: "Human message is newer than the latest agent message",
      detail: "The stored conversation has a human message without a newer agent reply.",
      confidence: "medium",
      reason: "This is a current-turn signal, not a future timer. It means the agent is expected to react as soon as the runtime advances.",
      evidence: [`message age ${durationLabel(now - latestHumanAt)}`],
    }, now));
  }

  items.push(...cronForecastItems(cronStatus, cronList, now));
  items.push(...heartbeatForecastItems(statusJson, now));

  const workingItems = items.filter((item) => ["working", "running", "queued", "responding"].includes(item.status));
  const scheduledItems = items.filter((item) => item.at != null && item.status === "scheduled");
  const blockingItem = items.find((item) => item.status === "waiting-for-user");
  const timedWorkingItem = workingItems
    .filter((item) => item.at != null)
    .sort((a, b) => Number(a.inMs ?? Number.MAX_SAFE_INTEGER) - Number(b.inMs ?? Number.MAX_SAFE_INTEGER))[0] || null;
  const nextScheduledItem = scheduledItems
    .sort((a, b) => Number(a.inMs ?? Number.MAX_SAFE_INTEGER) - Number(b.inMs ?? Number.MAX_SAFE_INTEGER))[0] || null;

  const activeWork = workingItems.find((item) => item.kind !== "pending-reply") || null;
  const pendingReply = items.find((item) => item.kind === "pending-reply") || null;
  let state = "idle";
  let primary = nextScheduledItem;
  let label = "No known future reaction";
  let detail = "The backend does not see active work, queued work, cron wakeups, or heartbeat timing beyond the current quiet state.";

  if (blockingItem) {
    state = "waiting-for-user";
    primary = blockingItem;
    label = "Waiting for you";
    detail = blockingItem.reason;
  } else if (activeWork) {
    state = "working";
    primary = timedWorkingItem || activeWork;
    label = timedWorkingItem
      ? `Likely next reaction in ${timedWorkingItem.inLabel}`
      : "Working; next reaction is after current work returns";
    detail = primary.reason || "Active work is visible, but no reliable return time is exposed.";
  } else if (pendingReply) {
    state = "responding";
    primary = pendingReply;
    label = "Reaction expected now";
    detail = pendingReply.reason;
  } else if (nextScheduledItem) {
    state = "scheduled";
    primary = nextScheduledItem;
    label = `Next scheduled opportunity in ${nextScheduledItem.inLabel}`;
    detail = nextScheduledItem.reason;
  }

  const nextKnown = state === "working" ? timedWorkingItem : state === "scheduled" ? nextScheduledItem : null;
  const confidence = primary?.confidence || (state === "idle" ? "high" : "low");

  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    state,
    label,
    detail: compactText(detail, 260),
    confidence,
    primarySource: primary?.source || null,
    nextKnownAt: nextKnown?.at || null,
    nextKnownInMs: nextKnown?.inMs ?? null,
    nextKnownLabel: nextKnown?.inLabel || "unknown",
    knownFutureAvailable: Boolean(nextKnown?.at),
    items: items
      .sort((a, b) => {
        if (a.status === "waiting-for-user" && b.status !== "waiting-for-user") return -1;
        if (b.status === "waiting-for-user" && a.status !== "waiting-for-user") return 1;
        if (a.status !== "scheduled" && b.status === "scheduled") return -1;
        if (b.status !== "scheduled" && a.status === "scheduled") return 1;
        if (a.at && b.at) return Number(a.inMs ?? 0) - Number(b.inMs ?? 0);
        return confidenceRank(b.confidence) - confidenceRank(a.confidence);
      })
      .slice(0, 14),
    limitations: [
      "Agent Home reports future reactions only when local OpenClaw state exposes them.",
      "Running model inference usually has no OS-level ETA; active tool/process work is observable, but completion time is unknown unless a trustworthy ETA exists.",
      "Heartbeat and cron entries are scheduled opportunities, not guaranteed visible messages.",
    ],
  };
}

function latestSession(sessionsJson) {
  const sessions = Array.isArray(sessionsJson?.sessions) ? sessionsJson.sessions : [];
  return [...sessions].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0] || null;
}

function transcriptSessionCandidates(sessionsJson) {
  const sessions = Array.isArray(sessionsJson?.sessions) ? sessionsJson.sessions : [];
  return [...sessions]
    .filter((session) => session?.agentId && session?.sessionId)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, transcriptSessionLimit);
}

function inferSessionChannel(session) {
  if (!session) return "openclaw";
  if (session.sourceChannel) return session.sourceChannel;
  if (session.kind === "spawn-child") return "subagent";
  const keyParts = String(session.key || "").split(":").filter(Boolean);
  const directIndex = keyParts.indexOf("direct");
  if (directIndex > 1) return keyParts[directIndex - 1] || "openclaw";
  return "openclaw";
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

function sessionEventFields(session) {
  return {
    sessionKey: session?.key || null,
    sessionId: session?.sessionId || null,
    sessionKind: session?.kind || null,
    sessionChannel: inferSessionChannel(session),
  };
}

function toolCommandFromMessage(message, session) {
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
    ...sessionEventFields(session),
  }));
}

function parseTranscriptMessages(lines, session) {
  const messages = [];
  const toolEvents = [];
  const sessionFields = sessionEventFields(session);

  for (const row of lines) {
    const message = row.message || {};
    const at = row.timestamp || message.timestamp || null;
    if (message.role === "user") {
      messages.push({
        at,
        channel: message.sourceChannel || sessionFields.sessionChannel || "openclaw",
        actor: message.senderName || "Roni",
        role: "human",
        text: textFromContent(message.content, 360),
        ...sessionFields,
      });
    } else if (message.role === "assistant") {
      const text = textFromContent(message.content, 360);
      if (text) {
        messages.push({
          at,
          channel: message.sourceChannel || "openclaw",
          actor: "Vale",
          role: "agent",
          text,
          ...sessionFields,
        });
      }
      toolEvents.push(...toolCommandFromMessage(message, session));
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
        ...sessionFields,
      });
    }
  }

  return {
    messages: messages.filter((item) => item.text),
    toolEvents: toolEvents.filter((item) => item.title),
  };
}

function parseTrajectory(lines, session) {
  const events = [];
  const openToolCalls = new Map();
  const sessionFields = sessionEventFields(session);

  for (const row of lines) {
    const data = row.data || {};
    if (row.type === "tool.call") {
      const event = {
        id: data.toolCallId || null,
        at: row.ts,
        source: "trajectory",
        kind: data.name || "tool",
        status: "running",
        title: `${data.name || "tool"} command`,
        command: compactValue(data.arguments?.command || data.arguments || "", 220),
        detail: compactText(data.arguments?.cwd || row.sessionKey || "", 140),
        ...sessionFields,
      };
      events.push(event);
      openToolCalls.set(`${session?.key || "session"}:${event.id || `${row.ts}:${event.kind}`}`, event);
      continue;
    }
    if (row.type === "tool.result") {
      const event = {
        id: data.toolCallId || null,
        at: row.ts,
        source: "trajectory",
        kind: data.name || "tool",
        status: data.isError ? "failed" : statusLabel(data.status || data.result?.status),
        title: `${data.name || "tool"} ${data.isError ? "failed" : "finished"}`,
        command: compactText(data.result ? JSON.stringify(data.result) : "", 140),
        detail: compactText(data.output || "", 240),
        durationMs: data.result?.durationMs ?? null,
        ...sessionFields,
      };
      events.push(event);
      if (event.id) openToolCalls.delete(`${session?.key || "session"}:${event.id}`);
    }
  }

  return {
    events: events.filter(Boolean),
    openToolCalls: [...openToolCalls.values()]
      .filter((event) => event.status === "running")
      .slice(-8),
  };
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function eventTime(value) {
  return timestampMs(value?.at) || 0;
}

function messageDedupeKey(message) {
  return [
    message.sessionKey || "",
    timestampMs(message.at) || message.at || "",
    message.role || "",
    message.channel || "",
    message.text || "",
  ].join("|");
}

function buildTranscriptChannels(messages) {
  const byChannel = new Map();
  for (const message of messages) {
    const id = message.channel || "openclaw";
    const current = byChannel.get(id) || { id, count: 0, latestAt: null, humanCount: 0, agentCount: 0 };
    current.count += 1;
    if (message.role === "human") current.humanCount += 1;
    if (message.role === "agent") current.agentCount += 1;
    if ((timestampMs(message.at) || 0) > (timestampMs(current.latestAt) || 0)) current.latestAt = message.at || current.latestAt;
    byChannel.set(id, current);
  }
  return [...byChannel.values()].sort((a, b) => (timestampMs(b.latestAt) || 0) - (timestampMs(a.latestAt) || 0));
}

function transcriptKicker(channels, sessionCount) {
  const channelIds = channels
    .map((channel) => channel.id)
    .filter(Boolean)
    .slice(0, 3);
  if (channelIds.length) {
    const suffix = channels.length > channelIds.length ? ` +${channels.length - channelIds.length}` : "";
    return `Unified local thread // ${channelIds.join(" + ")}${suffix}`;
  }
  if (sessionCount > 1) return `Unified local thread // ${sessionCount} sessions`;
  return "Local OpenClaw thread";
}

async function collectTranscript(sessionsJson) {
  const latest = latestSession(sessionsJson);
  const sessions = transcriptSessionCandidates(sessionsJson);
  const hasDirectSessions = sessions.some((session) => session.kind !== "spawn-child");
  const collected = await Promise.all(sessions.map(async (session) => {
    const transcriptLines = await readJsonlTail(sessionArtifactPath(session, ".jsonl"), 140);
    const trajectoryLines = await readJsonlTail(sessionArtifactPath(session, ".trajectory.jsonl"), 140);
    const parsed = parseTranscriptMessages(transcriptLines, session);
    const trajectory = parseTrajectory(trajectoryLines, session);
    const includeMessages = !hasDirectSessions || session.kind !== "spawn-child";
    return {
      session,
      includeMessages,
      parsed,
      trajectory,
      transcriptLines: transcriptLines.length,
      trajectoryLines: trajectoryLines.length,
    };
  }));

  const allMessages = dedupeBy(
    collected
      .flatMap((item) => (item.includeMessages ? item.parsed.messages : []))
      .filter((message) => message.text)
      .sort((a, b) => eventTime(a) - eventTime(b)),
    messageDedupeKey,
  );
  const channels = buildTranscriptChannels(allMessages);
  const toolEvents = collected
    .flatMap((item) => [...item.parsed.toolEvents, ...item.trajectory.events])
    .filter((item) => item.title)
    .sort((a, b) => eventTime(a) - eventTime(b));
  const openToolCalls = collected
    .flatMap((item) => item.trajectory.openToolCalls)
    .filter((event) => event.status === "running")
    .slice(-8);

  return {
    sessionKey: latest?.key || null,
    sessionId: latest?.sessionId || null,
    primarySessionKey: latest?.key || null,
    scope: "unified-local-sessions",
    kicker: transcriptKicker(channels, sessions.length),
    channels,
    sessions: collected.map((item) => ({
      key: item.session.key,
      kind: item.session.kind || "session",
      agentId: item.session.agentId || null,
      channel: inferSessionChannel(item.session),
      updatedAt: item.session.updatedAt || null,
      includedMessages: item.includeMessages,
      messageCount: item.parsed.messages.length,
      toolEventCount: item.parsed.toolEvents.length + item.trajectory.events.length,
      transcriptLines: item.transcriptLines,
      trajectoryLines: item.trajectoryLines,
    })),
    sessionCount: sessions.length,
    directSessionCount: sessions.filter((session) => session.kind !== "spawn-child").length,
    messageCount: allMessages.length,
    toolEventCount: toolEvents.length,
    messages: allMessages.slice(-transcriptMessageLimit),
    toolEvents: toolEvents
      .slice(-14),
    openToolCalls,
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

function processMonitorCommandEvent(processMonitor) {
  const processCollector = processMonitor?.collectors?.processTable || {};
  const summary = processMonitor?.summary || {};
  return commandEvent("Process monitor", {
    ok: Boolean(processMonitor?.available),
    collector: "processMonitor",
    command: processCollector.command || "windows process monitor",
    durationMs: processCollector.durationMs ?? null,
    endedAt: processMonitor?.generatedAt ? new Date(processMonitor.generatedAt).getTime() : Date.now(),
    stdout: [
      `${summary.interestingProcessCount || 0} interesting processes`,
      `${summary.activeActivityCount || 0} active work signals`,
      `${summary.establishedTcpConnectionCount || 0} established TCP`,
      `${summary.totalDiskWriteRate || "0 B/s"} disk write`,
    ].join(" · "),
    error: processMonitor?.error || processCollector.error || null,
  });
}

function processMonitorEvents(processMonitor) {
  const activities = Array.isArray(processMonitor?.activities) ? processMonitor.activities : [];
  return activities.slice(0, 8).map((activity) => ({
    at: processMonitor.generatedAt || new Date().toISOString(),
    source: "process",
    kind: "process-monitor",
    status: activity.status || "running",
    title: activity.title || "Observed process activity",
    command: activity.command || "",
    detail: compactText([
      activity.progress?.rateLabel ? `rate ${activity.progress.rateLabel}` : null,
      activity.progress?.etaLabel ? `eta ${activity.progress.etaLabel}` : null,
      activity.progress?.reason || null,
      ...(activity.evidence || []).slice(0, 2),
    ].filter(Boolean).join(" · "), 260),
    durationMs: activity.ageMs ?? null,
  }));
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
  if (snapshot.reactionForecast?.state === "waiting-for-user") return "needs-you";
  if (["working", "responding"].includes(snapshot.reactionForecast?.state)) return "working";
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

function isManualTerminalEvent(event) {
  return event?.source === "trajectory" || event?.source === "tool";
}

function terminalEventView(event) {
  return {
    at: event.at || null,
    status: event.status || "unknown",
    title: event.title || event.kind || "event",
    command: event.command || event.kind || "",
    detail: event.detail || "",
    durationMs: event.durationMs ?? null,
    source: event.source || "openclaw",
    kind: event.kind || "event",
    isManual: isManualTerminalEvent(event),
  };
}

function buildUiViewModel(snapshot) {
  const mode = currentMode(snapshot);
  const channel = snapshot.integrations?.channels?.[0] || null;
  const transcriptChannels = snapshot.transcript?.channels || [];
  const transcriptChannelLabel = transcriptChannels.length
    ? transcriptChannels
      .slice(0, 3)
      .map((item) => item.id)
      .join("+")
    : "none";
  const sessions = flattenSessions(snapshot);
  const current = sessions[0]?.session || null;
  const collectors = Object.entries(snapshot.collectors || {});
  const okCollectors = collectors.filter(([, value]) => value.ok).length;
  const windows = snapshot.integrations?.windows || {};
  const processSummary = snapshot.processMonitor?.summary || {};
  const allTerminalEvents = [...processMonitorEvents(snapshot.processMonitor), ...(snapshot.transcript?.toolEvents || []), ...(snapshot.commandEvents || [])]
    .sort((a, b) => new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime());
  const terminalEvents = allTerminalEvents.slice(0, 9).map(terminalEventView);
  const manualTerminalEvents = allTerminalEvents.filter(isManualTerminalEvent).slice(0, 9).map(terminalEventView);

  const proofCards = [
    ["Context", current?.percentUsed != null ? `${current.percentUsed}% used` : "unknown", current?.percentUsed > 80 ? "warning" : "ok"],
    ["Tokens", current ? `${numberLabel(current.totalTokens)} / ${numberLabel(current.contextTokens)}` : "unknown", "neutral"],
    ["Collectors", `${okCollectors}/${collectors.length} ok`, okCollectors === collectors.length ? "ok" : "warning"],
    ["Tasks", `${snapshot.taskSummary?.active || 0} live`, snapshot.taskSummary?.active ? "active" : "neutral"],
    ["Processes", `${processSummary.activeActivityCount || 0} live`, processSummary.activeActivityCount ? "active" : "neutral"],
    ["Disk I/O", processSummary.totalDiskWriteRate || "0 B/s", processSummary.totalDiskWriteBytesPerSec ? "active" : "neutral"],
    ["Defender", windows.defender?.RealTimeProtectionEnabled === true ? "on" : "unknown", windows.defender?.RealTimeProtectionEnabled === true ? "ok" : "notice"],
    ["Gateway", snapshot.gateway?.latencyMs != null ? `${snapshot.gateway.latencyMs} ms` : snapshot.gateway?.status || "unknown", snapshot.gateway?.status || "unknown"],
  ].map(([label, value, status]) => ({ label, value, status }));

  const sensors = [
    ["Mode", modeLabel(mode), mode],
    ["Messages", `${snapshot.transcript?.messageCount ?? snapshot.transcript?.messages?.length ?? 0}`, "active"],
    ["Tool Events", `${snapshot.transcript?.toolEventCount ?? snapshot.transcript?.toolEvents?.length ?? 0}`, "active"],
    ["Commands", `${snapshot.commandEvents?.length || 0}`, "active"],
    ["Proc", `${processSummary.activeActivityCount || 0}`, processSummary.activeActivityCount ? "active" : "neutral"],
    ["TCP", `${processSummary.establishedTcpConnectionCount || 0}`, processSummary.establishedTcpConnectionCount ? "active" : "neutral"],
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
      { label: `Conv ${transcriptChannelLabel}`, status: transcriptChannels.length ? "active" : "unknown" },
      { label: `${snapshot.transcript?.messageCount ?? snapshot.transcript?.messages?.length ?? 0} messages`, status: "active" },
      { label: snapshot.generatedAt, status: "active", kind: "timestamp" },
    ],
    conversation: {
      title: "OpenClaw Conversation",
      kicker: snapshot.transcript?.kicker || "Unified local thread",
      source: snapshot.transcript?.source || "unknown",
      sessionKey: snapshot.transcript?.sessionKey || null,
      scope: snapshot.transcript?.scope || "unknown",
      channels: transcriptChannels,
      sessions: snapshot.transcript?.sessions || [],
      sessionCount: snapshot.transcript?.sessionCount || 0,
      messageCount: snapshot.transcript?.messageCount ?? snapshot.transcript?.messages?.length ?? 0,
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
      manualEvents: manualTerminalEvents,
      filters: [
        { id: "all", label: "All", count: terminalEvents.length },
        { id: "manual", label: "Manual", count: manualTerminalEvents.length },
      ],
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
    reactionForecast: snapshot.reactionForecast || null,
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
      reactionForecastUrl: "/api/reaction",
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
  const target = resolve(rootDir, relativePath);
  if (!isPathInsideDirectory(rootDir, target)) return null;
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
    const [statusResult, sessionsResult, tasksResult, cronStatusResult, cronListResult, securityResult, windows, processMonitor] = await Promise.all([
      runOpenClaw(["status", "--deep", "--json"], { timeoutMs: 18000, collector: "status" }),
      runOpenClaw(["sessions", "--all-agents", "--limit", "50", "--json"], { timeoutMs: 12000, collector: "sessions" }),
      runOpenClaw(["tasks", "list", "--json"], { timeoutMs: 12000, collector: "tasks" }),
      runOpenClaw(["cron", "status"], { timeoutMs: 12000, collector: "cronStatus" }),
      runOpenClaw(["cron", "list", "--json"], { timeoutMs: 12000, collector: "cronList" }),
      runOpenClaw(["security", "audit", "--deep"], { timeoutMs: 12000, collector: "security" }),
      collectWindowsPosture(),
      collectProcessMonitor({ rootDir, workspaceDir }),
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
    const attention = buildAttention({ statusJson, tasks, security, windows, processMonitor, now });
    const transcript = await collectTranscript(sessionsJson);
    const reactionForecast = buildReactionForecast({
      now,
      statusJson,
      cronStatus,
      cronList,
      tasks,
      transcript,
      processMonitor,
      attention,
    });
    const commandEvents = [
      commandEvent("OpenClaw status", statusResult),
      commandEvent("Sessions", sessionsResult),
      commandEvent("Tasks", tasksResult),
      commandEvent("Cron status", cronStatusResult),
      commandEvent("Cron list", cronListResult),
      commandEvent("Security audit", securityResult),
      commandEvent("Windows posture", windows),
      processMonitorCommandEvent(processMonitor),
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
      reactionForecast,
      transcript,
      commandEvents,
      fileEdits,
      processMonitor,
      recentEvents: buildRecentEvents(statusJson, tasks, sessionsJson, security, processMonitor),
      integrations: buildIntegrations(statusJson, cronStatus, cronList, windows),
      collectors: {
        status: { ok: statusResult.ok, error: compactText(statusResult.error || statusResult.stderr, 120) },
        sessions: { ok: sessionsResult.ok, error: compactText(sessionsResult.error || sessionsResult.stderr, 120) },
        tasks: { ok: tasksResult.ok, error: compactText(tasksResult.error || tasksResult.stderr, 120) },
        cronStatus: { ok: cronStatusResult.ok, error: compactText(cronStatusResult.error || cronStatusResult.stderr, 120) },
        cronList: { ok: cronListResult.ok, error: compactText(cronListResult.error || cronListResult.stderr, 120) },
        security: { ok: securityResult.ok, error: compactText(securityResult.error || securityResult.stderr, 120) },
        windows: { ok: Boolean(windows?.available), error: windows?.error || null },
        processMonitor: { ok: Boolean(processMonitor?.available), error: processMonitor?.error || processMonitor?.collectors?.processTable?.error || null },
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
  let rawPath;
  try {
    rawPath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^[/\\]+/, "");
  } catch {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Bad request");
    return;
  }
  const target = resolve(publicDir, rawPath);

  if (!isPathInsideDirectory(publicDir, target)) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
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

    if (url.pathname === "/api/processes") {
      const snapshot = await collectSnapshot({ force: url.searchParams.get("force") === "1" });
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(snapshot.processMonitor || { available: false }, null, 2));
      return;
    }

    if (url.pathname === "/api/reaction") {
      const snapshot = await collectSnapshot({ force: url.searchParams.get("force") === "1" });
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(snapshot.reactionForecast || { schemaVersion: 1, state: "unknown" }, null, 2));
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
