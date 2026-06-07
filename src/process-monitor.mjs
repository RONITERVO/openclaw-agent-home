// Copyright 2026 Roni Tervo
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { homedir } from "node:os";

const isWindows = process.platform === "win32";
const fileSamples = new Map();
const processSamples = new Map();
const lifecycleEvents = [];

const redactPatterns = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /(token|password|secret|api[_-]?key|authorization)\s*[:=]\s*["']?[^"'\s,;]+/gi,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
];

const interestingProcessNames = /^(powershell|pwsh|cmd|codex|openclaw|rclone|curl|wget|aria2c|git|node|npm|npx|python|py|ffmpeg|yt-dlp|robocopy|xcopy|tar|7z|winget|msiexec|chrome|msedge|onedrive)$/i;
const noisyDirectories = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  "dist",
  "build",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  "AppData",
  "$RECYCLE.BIN",
  "System Volume Information",
]);

function runFile(file, args, { timeoutMs = 9000, displayCommand = null } = {}) {
  return new Promise((resolveRun) => {
    const startedAt = Date.now();
    execFile(
      file,
      args,
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 12 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const endedAt = Date.now();
        resolveRun({
          ok: !error,
          command: displayCommand || [file, ...args].join(" "),
          collector: "processMonitor",
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

function compactText(value, max = 180) {
  const text = redact(value ?? "")
    .replace(/\uFFFD/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}...`;
}

function redact(value) {
  if (value == null) return value;
  let text = String(value);
  for (const pattern of redactPatterns) {
    text = text.replace(pattern, "[redacted]");
  }
  return text;
}

function tryJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function byteLabel(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = Math.max(0, numeric);
  let index = 0;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current >= 10 || index === 0 ? current.toFixed(0) : current.toFixed(1)} ${units[index]}`;
}

function rateLabel(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "0 B/s";
  return `${byteLabel(numeric)}/s`;
}

function parsePowerShellDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function collectWindowsProcessProbe() {
  if (!isWindows) {
    return {
      result: {
        ok: false,
        command: "powershell process monitor",
        durationMs: 0,
        endedAt: Date.now(),
        error: "Windows process transparency is only available on Windows.",
      },
      data: null,
    };
  }

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$perfRows = @{}
Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object {
  if ($_.IDProcess -ne $null) { $perfRows[[string]$_.IDProcess] = $_ }
}
$processRows = Get-CimInstance Win32_Process | ForEach-Object {
  $perf = $perfRows[[string]$_.ProcessId]
  $created = $null
  if ($_.CreationDate) {
    try {
      if ($_.CreationDate -is [datetime]) {
        $created = $_.CreationDate.ToUniversalTime().ToString('o')
      } else {
        $created = [System.Management.ManagementDateTimeConverter]::ToDateTime($_.CreationDate).ToUniversalTime().ToString('o')
      }
    } catch {}
  }
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    parentPid = [int]$_.ParentProcessId
    name = $_.Name
    executablePath = $_.ExecutablePath
    commandLine = $_.CommandLine
    creationTime = $created
    elapsedSeconds = if ($perf) { [int64]$perf.ElapsedTime } else { $null }
    cpuPercent = if ($perf) { [double]$perf.PercentProcessorTime } else { $null }
    workingSetBytes = if ($perf) { [int64]$perf.WorkingSet } else { $null }
    privateBytes = if ($perf) { [int64]$perf.PrivateBytes } else { $null }
    ioReadBytesPerSec = if ($perf) { [int64]$perf.IOReadBytesPersec } else { $null }
    ioWriteBytesPerSec = if ($perf) { [int64]$perf.IOWriteBytesPersec } else { $null }
    ioDataBytesPerSec = if ($perf) { [int64]$perf.IODataBytesPersec } else { $null }
    ioOtherBytesPerSec = if ($perf) { [int64]$perf.IOOtherBytesPersec } else { $null }
    handleCount = if ($perf) { [int]$perf.HandleCount } else { $null }
    threadCount = if ($perf) { [int]$perf.ThreadCount } else { $null }
  }
}
$connections = Get-NetTCPConnection | Where-Object { $_.OwningProcess -gt 0 } | ForEach-Object {
  [pscustomobject]@{
    owningProcess = [int]$_.OwningProcess
    state = $_.State.ToString()
    localAddress = $_.LocalAddress
    localPort = [int]$_.LocalPort
    remoteAddress = $_.RemoteAddress
    remotePort = [int]$_.RemotePort
    appliedSetting = if ($_.AppliedSetting) { $_.AppliedSetting.ToString() } else { $null }
  }
}
[pscustomobject]@{
  collectedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  processCount = @($processRows).Count
  connectionCount = @($connections).Count
  processes = @($processRows)
  connections = @($connections)
} | ConvertTo-Json -Depth 6
`;

  const result = await runFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    timeoutMs: 10000,
    displayCommand: "powershell Win32_Process; Win32_PerfFormattedData_PerfProc_Process; Get-NetTCPConnection",
  });

  return { result, data: tryJson(result.stdout, null) };
}

function normalizeConnection(connection) {
  return {
    state: connection.state || "Unknown",
    local: `${connection.localAddress || "?"}:${connection.localPort || "?"}`,
    remote: connection.remoteAddress && connection.remoteAddress !== "::" && connection.remoteAddress !== "0.0.0.0"
      ? `${connection.remoteAddress}:${connection.remotePort || "?"}`
      : null,
    appliedSetting: connection.appliedSetting || null,
  };
}

function normalizeProcess(processRow, connectionsByPid, now) {
  const pid = toNumber(processRow.pid, null);
  const connectionRows = connectionsByPid.get(pid) || [];
  const establishedConnections = connectionRows.filter((item) => String(item.state).toLowerCase() === "established");
  const commandLine = redact(processRow.commandLine || "");
  const creationTime = parsePowerShellDate(processRow.creationTime);
  const startedMs = creationTime ? new Date(creationTime).getTime() : null;
  const ageMs = startedMs ? Math.max(0, now - startedMs) : null;
  const writeBps = toNumber(processRow.ioWriteBytesPerSec, 0);
  const readBps = toNumber(processRow.ioReadBytesPerSec, 0);
  const dataBps = toNumber(processRow.ioDataBytesPerSec, 0);
  const cpuPercent = toNumber(processRow.cpuPercent, 0);

  return {
    pid,
    parentPid: toNumber(processRow.parentPid, null),
    name: processRow.name || "unknown",
    executablePath: redact(processRow.executablePath || ""),
    commandLine,
    commandSummary: compactText(commandLine, 260),
    creationTime,
    ageMs,
    cpuPercent,
    workingSetBytes: toNumber(processRow.workingSetBytes, null),
    privateBytes: toNumber(processRow.privateBytes, null),
    ioReadBytesPerSec: readBps,
    ioWriteBytesPerSec: writeBps,
    ioDataBytesPerSec: dataBps,
    ioOtherBytesPerSec: toNumber(processRow.ioOtherBytesPerSec, 0),
    handleCount: toNumber(processRow.handleCount, null),
    threadCount: toNumber(processRow.threadCount, null),
    tcpConnectionCount: connectionRows.length,
    establishedTcpConnectionCount: establishedConnections.length,
    tcpStates: Object.entries(connectionRows.reduce((acc, item) => {
      const key = item.state || "Unknown";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {})).map(([state, count]) => ({ state, count })),
    sample: {
      diskReadRate: rateLabel(readBps),
      diskWriteRate: rateLabel(writeBps),
      ioDataRate: rateLabel(dataBps),
      memory: byteLabel(processRow.workingSetBytes),
    },
    connections: connectionRows
      .filter((item) => item.remoteAddress && item.remoteAddress !== "::" && item.remoteAddress !== "0.0.0.0")
      .slice(0, 8)
      .map(normalizeConnection),
  };
}

function scoreProcess(processInfo) {
  if (processInfo.pid == null || processInfo.pid <= 4 || /^(System Idle Process|System)$/i.test(processInfo.name || "")) {
    return -1000;
  }
  let score = 0;
  if (interestingProcessNames.test(processInfo.name)) score += 35;
  if (processInfo.establishedTcpConnectionCount > 0) score += 25 + Math.min(processInfo.establishedTcpConnectionCount, 10);
  if (processInfo.ioWriteBytesPerSec > 0) score += Math.min(30, Math.ceil(processInfo.ioWriteBytesPerSec / 65536));
  if (processInfo.ioReadBytesPerSec > 262144) score += 8;
  if (processInfo.cpuPercent >= 5) score += Math.min(25, Math.ceil(processInfo.cpuPercent));
  if (processInfo.ageMs != null && processInfo.ageMs < 45 * 60 * 1000) score += 10;
  if (/openclaw|codex|rclone|curl|download|https?:|powershell|pwsh|Työpöytä|Desktop|Downloads|Archives/i.test(processInfo.commandLine || "")) score += 18;
  if (/^(chrome|msedge)$/i.test(processInfo.name) && processInfo.establishedTcpConnectionCount === 0 && processInfo.ioWriteBytesPerSec === 0) score -= 20;
  return score;
}

function updateLifecycle(processes, now) {
  const current = new Map(processes.map((item) => [item.pid, item]));
  for (const processInfo of processes) {
    if (!processSamples.has(processInfo.pid)) {
      lifecycleEvents.push({
        at: new Date(now).toISOString(),
        status: "started",
        pid: processInfo.pid,
        name: processInfo.name,
        command: compactText(processInfo.commandLine, 180),
      });
    }
    processSamples.set(processInfo.pid, {
      pid: processInfo.pid,
      name: processInfo.name,
      commandLine: processInfo.commandLine,
      seenAt: now,
    });
  }

  for (const [pid, previous] of processSamples) {
    if (!current.has(pid) && now - previous.seenAt > 15000) {
      lifecycleEvents.push({
        at: new Date(now).toISOString(),
        status: "ended",
        pid,
        name: previous.name,
        command: compactText(previous.commandLine, 180),
      });
      processSamples.delete(pid);
    }
  }

  while (lifecycleEvents.length > 40) lifecycleEvents.shift();
}

function extractPathCandidates(text) {
  if (!text) return [];
  const candidates = new Set();
  const quoted = [...String(text).matchAll(/["']([A-Za-z]:\\[^"']+)["']/g)].map((match) => match[1]);
  const bare = [...String(text).matchAll(/\b[A-Za-z]:\\[^\s"'<>|]+/g)].map((match) => match[0]);
  for (const candidate of [...quoted, ...bare]) {
    const cleaned = candidate.replace(/[),.;]+$/g, "");
    if (cleaned.length > 4) candidates.add(cleaned);
  }
  return [...candidates].slice(0, 12);
}

function scanRootsFromEnvironment({ rootDir, workspaceDir, processes }) {
  const roots = new Set();
  const add = (value) => {
    if (!value) return;
    const normalized = resolve(value);
    if (existsSync(normalized)) roots.add(normalized);
  };

  add(rootDir);
  add(workspaceDir);
  add(join(homedir(), "Downloads"));
  add(join(homedir(), "Desktop"));
  add(join(homedir(), "OneDrive", "Desktop"));
  add("D:\\Archives\\OneDrive");

  for (const configured of String(process.env.AGENT_HOME_PROGRESS_ROOTS || "").split(";")) {
    add(configured.trim());
  }

  for (const processInfo of processes.slice(0, 18)) {
    for (const candidate of extractPathCandidates(processInfo.commandLine)) {
      if (!existsSync(candidate)) continue;
      try {
        const normalized = resolve(candidate);
        add(dirname(normalized));
      } catch {
        // Ignore malformed command-line path fragments.
      }
    }
  }

  return [...roots].slice(0, 14);
}

async function walkRecentFiles(root, now, deadline, output, depth = 0) {
  if (Date.now() > deadline || depth > 5 || output.length >= 120) return;
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (Date.now() > deadline || output.length >= 120) return;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!noisyDirectories.has(entry.name)) await walkRecentFiles(path, now, deadline, output, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const info = await stat(path);
      const ageMs = now - info.mtimeMs;
      const isPartial = /\.(partial|crdownload|tmp|download)$/i.test(entry.name);
      if (ageMs <= 20 * 60 * 1000 || (isPartial && ageMs <= 4 * 60 * 60 * 1000)) {
        output.push({
          path: normalize(path),
          sizeBytes: info.size,
          modifiedAt: info.mtime.toISOString(),
          modifiedAgeMs: ageMs,
          partial: isPartial,
        });
      }
    } catch {
      // File may have moved while scanning; ignore it.
    }
  }
}

async function collectRecentFiles({ rootDir, workspaceDir, processes, now }) {
  const roots = scanRootsFromEnvironment({ rootDir, workspaceDir, processes });
  const files = [];
  for (const root of roots) {
    await walkRecentFiles(root, now, Date.now() + 850, files);
  }

  const deduped = new Map();
  for (const file of files) deduped.set(file.path, file);

  return [...deduped.values()]
    .sort((a, b) => Number(b.modifiedAgeMs <= 120000) - Number(a.modifiedAgeMs <= 120000) || b.sizeBytes - a.sizeBytes)
    .slice(0, 80);
}

function annotateFileGrowth(files, now) {
  const annotated = files.map((file) => {
    const previous = fileSamples.get(file.path);
    let growthBytesPerSec = null;
    if (previous && now > previous.at) {
      const deltaBytes = file.sizeBytes - previous.sizeBytes;
      const deltaSeconds = (now - previous.at) / 1000;
      growthBytesPerSec = deltaSeconds > 0 && deltaBytes > 0 ? deltaBytes / deltaSeconds : 0;
    }
    fileSamples.set(file.path, { sizeBytes: file.sizeBytes, at: now });
    return {
      ...file,
      growthBytesPerSec,
      sizeLabel: byteLabel(file.sizeBytes),
      growthLabel: growthBytesPerSec == null ? "needs second sample" : rateLabel(growthBytesPerSec),
    };
  });

  const knownPaths = new Set(files.map((file) => file.path));
  for (const [path, sample] of fileSamples) {
    if (!knownPaths.has(path) && now - sample.at > 30 * 60 * 1000) fileSamples.delete(path);
  }

  return annotated;
}

function isBrowserProcess(processInfo) {
  return /^(chrome|msedge)$/i.test(processInfo.name || "");
}

function isUserToolProcess(processInfo) {
  return /^(powershell|pwsh|cmd|codex|openclaw|rclone|curl|wget|aria2c|git|node|npm|npx|python|py|ffmpeg|yt-dlp|robocopy|xcopy|tar|7z|winget|msiexec)$/i.test(processInfo.name || "");
}

function isSystemServiceProcess(processInfo) {
  return /^(svchost|registry|csrss|lsass|services|smss|wininit|winlogon|fontdrvhost|dwm|wmiprvse)$/i.test(processInfo.name || "");
}

function isAgentHomeCollectorProcess(processInfo) {
  const command = processInfo.commandLine || "";
  return /openclaw\.mjs\s+(status --deep --json|sessions --all-agents|tasks list|cron status|cron list --json|security audit)/i.test(command)
    || /openclaw\.mjs\s+gateway run/i.test(command)
    || /src[\\\/]server\.mjs/i.test(command)
    || /Get-MpComputerStatus|Get-NetFirewallProfile|Win32_PerfFormattedData_PerfProc_Process|Get-NetTCPConnection/i.test(command);
}

function isLikelyActiveWork(processInfo) {
  if (processInfo.pid == null || processInfo.pid <= 4 || /^(System Idle Process|System)$/i.test(processInfo.name || "")) return false;
  if (isAgentHomeCollectorProcess(processInfo)) return false;
  const writeBps = Number(processInfo.ioWriteBytesPerSec) || 0;
  const readBps = Number(processInfo.ioReadBytesPerSec) || 0;
  const dataBps = Number(processInfo.ioDataBytesPerSec) || 0;
  const cpuPercent = Number(processInfo.cpuPercent) || 0;
  const recent = processInfo.ageMs != null && processInfo.ageMs < 2 * 60 * 60 * 1000;
  const hasNetwork = processInfo.establishedTcpConnectionCount > 0;
  const hasUserPath = /openclaw|codex|rclone|curl|download|https?:|Työpöytä|Desktop|Downloads|Archives|Projects/i.test(processInfo.commandLine || "");
  const userTool = isUserToolProcess(processInfo);

  if (isSystemServiceProcess(processInfo)) return false;
  if (userTool && (writeBps >= 32768 || dataBps >= 1048576)) return true;
  if ((userTool || hasUserPath) && hasNetwork && (writeBps >= 8192 || readBps >= 262144)) return true;
  if (userTool && recent && (hasNetwork || cpuPercent >= 1 || hasUserPath)) return true;
  if (isBrowserProcess(processInfo) && writeBps >= 5 * 1024 * 1024) return true;
  return false;
}

function isActiveFileSignal(file) {
  const growth = Number(file.growthBytesPerSec) || 0;
  const downloadPartial = /\.(partial|crdownload|download)$/i.test(file.path || "");
  return growth > 0 || (downloadPartial && file.modifiedAgeMs <= 20 * 60 * 1000);
}

function buildActivities({ processes, recentFiles }) {
  const activeFiles = recentFiles
    .filter(isActiveFileSignal)
    .slice(0, 10);
  const activeProcesses = processes
    .filter(isLikelyActiveWork)
    .slice(0, 18);

  const activities = activeProcesses.map((processInfo) => {
    const totalRate = Math.max(
      processInfo.ioWriteBytesPerSec,
      processInfo.ioReadBytesPerSec,
      processInfo.ioDataBytesPerSec,
    );
    const likelyTransfer = processInfo.establishedTcpConnectionCount > 0 && processInfo.ioWriteBytesPerSec > 0;
    return {
      id: `process:${processInfo.pid}`,
      status: "running",
      title: `${processInfo.name} pid ${processInfo.pid}`,
      pid: processInfo.pid,
      parentPid: processInfo.parentPid,
      startedAt: processInfo.creationTime,
      ageMs: processInfo.ageMs,
      command: processInfo.commandSummary,
      evidence: [
        processInfo.establishedTcpConnectionCount ? `${processInfo.establishedTcpConnectionCount} established TCP connection(s)` : null,
        processInfo.ioWriteBytesPerSec ? `disk write ${rateLabel(processInfo.ioWriteBytesPerSec)}` : null,
        processInfo.ioReadBytesPerSec ? `disk read ${rateLabel(processInfo.ioReadBytesPerSec)}` : null,
        processInfo.cpuPercent ? `cpu ${Math.round(processInfo.cpuPercent)}%` : null,
      ].filter(Boolean),
      progress: {
        percent: null,
        bytesDone: null,
        bytesTotal: null,
        rateBytesPerSec: totalRate || null,
        rateLabel: rateLabel(totalRate),
        etaSeconds: null,
        etaLabel: "unknown",
        confidence: likelyTransfer ? "medium" : "low",
        reason: likelyTransfer
          ? "Windows exposes the process, TCP ownership, and disk I/O rate, but not a universal final byte total."
          : "Process is observable, but no reliable total-size signal is available from Windows alone.",
      },
      network: {
        connectionCount: processInfo.tcpConnectionCount,
        establishedConnectionCount: processInfo.establishedTcpConnectionCount,
        sampleConnections: processInfo.connections,
      },
    };
  });

  if (activeFiles.length) {
    activities.unshift({
      id: "files:growing",
      status: "running",
      title: "Recently growing output files",
      evidence: activeFiles.map((file) => `${file.sizeLabel} ${file.growthLabel} ${file.path}`).slice(0, 6),
      progress: {
        percent: null,
        bytesDone: activeFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
        bytesTotal: null,
        rateBytesPerSec: activeFiles.reduce((sum, file) => sum + Math.max(0, Number(file.growthBytesPerSec) || 0), 0),
        rateLabel: rateLabel(activeFiles.reduce((sum, file) => sum + Math.max(0, Number(file.growthBytesPerSec) || 0), 0)),
        etaSeconds: null,
        etaLabel: "unknown",
        confidence: "medium",
        reason: "Windows can show local files growing; ETA needs a trustworthy total size from the producing tool or source.",
      },
      files: activeFiles,
    });
  }

  return activities.slice(0, 20);
}

function summarize(processes, connections, recentFiles, activities) {
  const activeNetworkOwners = processes.filter((item) => item.establishedTcpConnectionCount > 0).length;
  const activeWriters = processes.filter((item) => item.ioWriteBytesPerSec > 0).length;
  const observedDiskWriteBps = processes.reduce((sum, item) => sum + Math.max(0, Number(item.ioWriteBytesPerSec) || 0), 0);
  const activeProcessIds = new Set(activities.map((activity) => activity.pid).filter((pid) => pid != null));
  const activeDiskWriteBps = processes
    .filter((item) => activeProcessIds.has(item.pid))
    .reduce((sum, item) => sum + Math.max(0, Number(item.ioWriteBytesPerSec) || 0), 0);
  const growingFiles = recentFiles.filter(isActiveFileSignal);
  const growingBytesPerSec = growingFiles.reduce((sum, file) => sum + Math.max(0, Number(file.growthBytesPerSec) || 0), 0);
  return {
    status: activities.length ? "active" : "quiet",
    interestingProcessCount: processes.length,
    activeNetworkOwners,
    activeWriters,
    tcpConnectionCount: connections.length,
    establishedTcpConnectionCount: connections.filter((item) => String(item.state).toLowerCase() === "established").length,
    totalDiskWriteBytesPerSec: activeDiskWriteBps + growingBytesPerSec,
    totalDiskWriteRate: rateLabel(activeDiskWriteBps + growingBytesPerSec),
    observedDiskWriteBytesPerSec: observedDiskWriteBps,
    observedDiskWriteRate: rateLabel(observedDiskWriteBps),
    growingFileCount: growingFiles.length,
    growingBytesPerSec,
    activeActivityCount: activities.length,
  };
}

export async function collectProcessMonitor({ rootDir = process.cwd(), workspaceDir = rootDir } = {}) {
  const now = Date.now();
  const { result, data } = await collectWindowsProcessProbe();
  if (!data?.processes) {
    return {
      available: false,
      generatedAt: new Date(now).toISOString(),
      source: "windows-process-table",
      status: "unavailable",
      error: compactText(result.error || result.stderr || "Process monitor probe returned no data."),
      command: result.command,
      durationMs: result.durationMs,
      collectors: {
        processTable: { ok: false, error: compactText(result.error || result.stderr, 180) },
        fileGrowth: { ok: false, error: "Skipped because process table probe failed." },
      },
      limitations: [
        "Windows process transparency is implemented through built-in process, performance counter, and TCP ownership data.",
      ],
    };
  }

  const connections = Array.isArray(data.connections) ? data.connections : [];
  const connectionsByPid = new Map();
  for (const connection of connections) {
    const pid = toNumber(connection.owningProcess, null);
    if (pid == null) continue;
    const list = connectionsByPid.get(pid) || [];
    list.push(connection);
    connectionsByPid.set(pid, list);
  }

  const allProcesses = (Array.isArray(data.processes) ? data.processes : [])
    .map((row) => normalizeProcess(row, connectionsByPid, now))
    .filter((processInfo) => processInfo.pid != null)
    .map((processInfo) => ({ ...processInfo, score: scoreProcess(processInfo) }));

  updateLifecycle(allProcesses, now);

  const interestingProcesses = allProcesses
    .filter((processInfo) => processInfo.score > 0)
    .sort((a, b) => b.score - a.score || b.ioWriteBytesPerSec - a.ioWriteBytesPerSec || b.establishedTcpConnectionCount - a.establishedTcpConnectionCount)
    .slice(0, 50);

  const recentFiles = annotateFileGrowth(await collectRecentFiles({
    rootDir,
    workspaceDir,
    processes: interestingProcesses,
    now,
  }), now);
  const activities = buildActivities({ processes: interestingProcesses, recentFiles });

  return {
    schemaVersion: 1,
    available: true,
    generatedAt: new Date(now).toISOString(),
    status: activities.length ? "active" : "quiet",
    source: "windows-process-table-plus-file-growth",
    summary: summarize(interestingProcesses, connections, recentFiles, activities),
    activities,
    processes: interestingProcesses,
    network: {
      totalConnections: connections.length,
      byProcess: interestingProcesses
        .filter((processInfo) => processInfo.tcpConnectionCount > 0)
        .map((processInfo) => ({
          pid: processInfo.pid,
          name: processInfo.name,
          connectionCount: processInfo.tcpConnectionCount,
          establishedConnectionCount: processInfo.establishedTcpConnectionCount,
          states: processInfo.tcpStates,
          sampleConnections: processInfo.connections,
        }))
        .slice(0, 30),
    },
    fileActivity: {
      roots: scanRootsFromEnvironment({ rootDir, workspaceDir, processes: interestingProcesses }),
      recentFiles,
      growingFiles: recentFiles
        .filter((file) => file.partial || Number(file.growthBytesPerSec) > 0)
        .slice(0, 30),
    },
    lifecycleEvents: lifecycleEvents.slice(-20),
    collectors: {
      processTable: {
        ok: result.ok && Boolean(data?.processes),
        command: result.command,
        durationMs: result.durationMs,
        error: compactText(result.error || result.stderr, 180),
      },
      fileGrowth: {
        ok: true,
        durationMs: null,
        error: null,
      },
    },
    limitations: [
      "Per-process TCP ownership is available through Windows, but universal per-process network byte totals are not exposed by Get-NetTCPConnection.",
      "ETA is only emitted when a reliable total byte count is inferable; otherwise the API reports live rate and explains why ETA is unknown.",
      "File-growth evidence is bounded to recent files under likely workspace/download/archive roots to keep the ambient collector lightweight.",
    ],
  };
}
