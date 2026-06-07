// Copyright 2026 Roni Tervo
// SPDX-License-Identifier: Apache-2.0

const REFRESH_RATE_MS = 3000;
let stateCache = {};

/* --- Utils & Formatters --- */
const cls = (v) => String(v || "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
const escape = (v) => String(v ?? "").replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
const timeFormat = (iso) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(iso ? new Date(iso) : new Date());

const duration = (ms) => {
  if (!ms || !Number.isFinite(Number(ms))) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = Math.floor(ms / 1000);
  return sec < 60 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(sec / 60)}m ${(sec % 60).toString().padStart(2, '0')}s`;
};

const formatBytes = (bytes) => {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const statusText = (s) => {
  if (["done", "ok", "clean"].includes(s)) return "OK";
  if (["failed", "warning", "urgent"].includes(s)) return "ERR";
  if (["running", "working", "active"].includes(s)) return "RUN";
  return String(s || "INF").toUpperCase().substring(0, 3);
};

const highlightJSON = (obj) => {
  try {
    const str = typeof obj !== 'string' ? JSON.stringify(obj, null, 2) : obj;
    return str.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, m => {
      let c = 'syn-num';
      if (/^"/.test(m)) c = /:$/.test(m) ? (m = m.slice(0, -1), 'syn-key') : 'syn-str';
      else if (/true|false|null/.test(m)) c = 'syn-bool';
      return `<span class="${c}">${escape(m)}</span>${c === 'syn-key' ? ':' : ''}`;
    });
  } catch { return escape(obj); }
};

/* --- SVGs --- */
const icons = {
  brand: `<svg class="brand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`,
  user: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`,
  att: `<svg class="att-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`,
  empty: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`
};

/* --- Component Builders --- */
const TopBar = (v) => `
  <header class="topbar">
    <div class="identity">
      ${icons.brand}
      <div class="identity-text">
        <h1>${escape(v.title || "OpenClaw Terminal")}</h1>
        <p class="font-mono">${escape(v.subtitle || "System Online")} &middot; <span class="${cls(v.mode)}">${escape(v.modeLabel)}</span></p>
      </div>
    </div>
    <div class="top-pills font-mono">
      ${(v.topPills || []).map(p => `
        <div class="pill ${cls(p.status)}">
          <div class="status-dot"></div>
          <span>${escape(p.kind === "timestamp" ? timeFormat(p.label) : p.label)}</span>
        </div>
      `).join("")}
    </div>
  </header>`;

const Chat = (c) => `
  <header class="panel-header">
    <h2>${escape(c?.title || "Agent Comm")}</h2>
    <span class="font-mono">${escape(c?.kicker || "Live")}</span>
  </header>
  <div class="panel-content chat-list">
    ${c?.messages?.length ? c.messages.map(m => `
      <div class="chat-row ${m.role === 'human' ? 'human' : 'agent'}">
        <div class="chat-meta">
          ${m.role === 'human' ? icons.user : icons.brand}
          <strong>${escape(m.actor || m.role)}</strong>
          <span class="time font-mono">${escape(timeFormat(m.at))}</span>
        </div>
        <p>${escape(m.text)}</p>
      </div>
    `).join("") : `<div class="empty-state">${icons.empty}<p>No transcript</p></div>`}
  </div>`;

// Renders deep process metrics exposing backend telemetry cleanly without inventing data.
const Activities = (activeEv, proc) => {
  const processCards = (proc?.activities || []).map(act => {
    const prog = act.progress || {};
    const isIndet = prog.percent === null;
    const pct = isIndet ? 100 : prog.percent;
    const hasNetwork = act.network?.sampleConnections?.length > 0;

    return `
      <div class="activity-card ${cls(act.status)}">
        <div class="act-head">
          <div class="act-title-row">
            <h3>${escape(act.title)}</h3>
            ${act.pid ? `<span class="act-badge font-mono">PID ${act.pid}</span>` : ''}
          </div>
          ${act.ageMs ? `<span class="act-age font-mono">T+ ${escape(duration(act.ageMs))}</span>` : ''}
        </div>
        
        ${act.command ? `<pre class="font-mono">${escape(act.command)}</pre>` : ''}
        
        <div class="act-progress-container">
          <div class="progress-metrics font-mono">
            <div class="metric-col">
              <span class="metric-label">DONE</span>
              <span class="metric-val">${formatBytes(prog.bytesDone)}</span>
            </div>
            <div class="metric-col">
              <span class="metric-label">RATE</span>
              <span class="metric-val text-cyan">${escape(prog.rateLabel || "0 B/s")}</span>
            </div>
            <div class="metric-col">
              <span class="metric-label">ETA</span>
              <div class="tooltip-wrap">
                <span class="metric-val ${prog.etaLabel === 'unknown' ? 'text-muted' : 'text-green'}">
                  ${escape(prog.etaLabel || "unknown")}
                </span>
                ${prog.reason ? `<div class="tooltip">${escape(prog.reason)}</div>` : ''}
              </div>
            </div>
            <div class="metric-col">
              <span class="metric-label">CONFIDENCE</span>
              <span class="metric-val badge-${cls(prog.confidence || 'low')}">${escape(prog.confidence || "low").toUpperCase()}</span>
            </div>
          </div>
          <div class="progress-track ${isIndet ? 'indeterminate' : ''}">
            <div class="progress-fill" style="width: ${pct}%"></div>
          </div>
        </div>

        ${hasNetwork ? `
          <div class="act-network font-mono">
            <div class="net-title">TCP Sockets (${act.network.establishedConnectionCount} Established)</div>
            ${act.network.sampleConnections.map(c => `
              <div class="net-row">
                <span class="net-state">${escape(c.state)}</span>
                <span>${escape(c.local)} &rarr; ${escape(c.remote)}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>`;
  }).join('');

  // Fallback to high-level activeEvent if no raw process telemetry is present
  const fallbackCard = activeEv ? `
    <div class="activity-card ${cls(activeEv.status)}">
      <div class="act-head">
        <div class="act-title-row">
          <h3>${escape(activeEv.title || "System Nominal")}</h3>
          <span class="act-badge font-mono">${escape(statusText(activeEv.status))}</span>
        </div>
        <span class="act-age font-mono">T+ ${escape(duration(activeEv.durationMs))}</span>
      </div>
      ${activeEv.command ? `<pre class="font-mono">${escape(activeEv.command)}</pre>` : ''}
      <p style="font-size:14px; color:var(--text-muted); line-height:1.6;">${escape(activeEv.detail || "Operating within standard parameters.")}</p>
    </div>` : `<div class="empty-state">${icons.empty}<p>System Idle</p></div>`;

  return `<div class="activities-stack">${processCards || fallbackCard}</div>`;
};

const Terminal = (t) => `
  <header class="panel-header">
    <h2>${escape(t?.title || "Execution Trace")}</h2>
    <span class="font-mono">${escape(t?.kicker || "Monitoring")}</span>
  </header>
  <div class="panel-content">
    ${t?.events?.length ? t.events.map(ev => `
      <div class="terminal-row ${cls(ev.status)}">
        <span class="term-time font-mono">${escape(timeFormat(ev.at))}</span>
        <span class="term-status font-mono ${cls(ev.status)}">${escape(statusText(ev.status))}</span>
        <div class="term-content">
          <strong>${escape(ev.title)}</strong>
          ${ev.command ? `<code class="font-mono">${escape(ev.command)}</code>` : ''}
          ${ev.detail?.startsWith('{') ? `<div class="term-json font-mono">${highlightJSON(ev.detail)}</div>`
    : ev.detail ? `<p>${escape(ev.detail)}</p>` : ''}
        </div>
      </div>
    `).join("") : `<div class="empty-state">${icons.empty}<p>No active traces</p></div>`}
  </div>`;

const Proof = (p) => `
  <div class="metric-grid">
    ${(p?.cards || []).map(c => `
      <div class="metric ${cls(c.status)}">
        <span>${escape(c.label)}</span>
        <strong class="font-mono">${escape(c.value)}</strong>
      </div>
    `).join("")}
  </div>`;

// Handles both Exact Hunks (preferable) and Raw Patch fallbacks
const Files = (f) => `
  <header class="panel-header">
    <h2>${escape(f?.title || "Workspace Edits")}</h2>
    <span class="font-mono">${escape(f?.count || 0)} FILES</span>
  </header>
  <div class="panel-content">
    ${f?.items?.length ? f.items.map(e => {
  let diffHTML = '';
  if (e.exactHunks?.length) {
    diffHTML = e.exactHunks.map(h => `
          <div class="diff-viewer font-mono"><table class="diff-table"><tbody>
            <tr class="diff-line hunk"><td>${escape(h.header)}</td></tr>
            ${h.lines.map(l => {
      const type = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'rem' : 'ctx';
      return `<tr class="diff-line ${type}"><td>${escape(l)}</td></tr>`;
    }).join('')}
          </tbody></table></div>
        `).join('');
  } else if (e.rawPatch) {
    diffHTML = `<div class="diff-viewer font-mono"><table class="diff-table"><tbody>
          ${e.rawPatch.split('\n').filter(l => l.trim()).map(l => {
      const type = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'rem' : l.startsWith('@@') ? 'hunk' : 'ctx';
      return `<tr class="diff-line ${type}"><td>${escape(l)}</td></tr>`;
    }).join('')}
        </tbody></table></div>`;
  }
  return `
        <div class="file-row">
          <div class="file-row-header font-mono">
            <strong>${escape(e.path)}</strong>
            <div class="file-row-stats">
              <span class="stat-add">+${escape(e.added ?? "?")}</span>
              <span class="stat-rem">-${escape(e.removed ?? 0)}</span>
            </div>
          </div>
          ${diffHTML}
        </div>`;
}).join("") : `<div class="empty-state">${icons.empty}<p>Working tree clean</p></div>`}
  </div>`;

const Attn = (a) => `
  <header class="panel-header">
    <h2>${escape(a?.title || "System Alerts")}</h2>
    <span class="font-mono">${escape(a?.count || 0)} ALERTS</span>
  </header>
  <div class="panel-content">
    ${a?.items?.length ? a.items.map(i => `
      <div class="attention-row ${cls(i.severity)}">
        ${icons.att}
        <div class="attention-info">
          <strong>${escape(i.title)}</strong>
          <span>${escape(i.reason || i.source)}</span>
        </div>
      </div>
    `).join("") : `<div class="empty-state">${icons.empty}<p>No critical alerts</p></div>`}
  </div>`;

const Sensors = (s) => `
  <footer class="sensor-strip font-mono">
    ${(s || []).map(item => `
      <div class="sensor ${cls(item.status)}">
        <span>${escape(item.label)}</span>
        <strong>${escape(item.value)}</strong>
      </div>
    `).join("")}
  </footer>`;

/* --- Render Engine --- */
function inject(id, data, builder, scroll = false) {
  const el = document.getElementById(id);
  if (!el || (window.getSelection()?.toString().length > 0 && el.contains(window.getSelection().anchorNode))) return;

  const hash = JSON.stringify(data || {});
  if (stateCache[id] === hash) return;
  stateCache[id] = hash;

  const contentPanels = scroll ? Array.from(el.querySelectorAll('.panel-content')) : [];
  const scrolls = contentPanels.map(p => ({ el: p, bottom: Math.abs(p.scrollHeight - p.scrollTop - p.clientHeight) < 20, top: p.scrollTop }));

  requestAnimationFrame(() => {
    el.innerHTML = builder(data);
    if (scroll) {
      el.querySelectorAll('.panel-content').forEach((p, i) => {
        if (scrolls[i]?.bottom) p.scrollTop = p.scrollHeight;
        else if (scrolls[i]) p.scrollTop = scrolls[i].top;
      });
    }
  });
}

function render(view, proc) {
  if (!document.getElementById("region-top")) {
    document.getElementById("app-mount").innerHTML = `
      <div id="region-top"></div>
      <section class="panel" id="region-chat"></section>
      <main class="center-stack">
        <div id="region-hero"></div>
        <section class="panel" id="region-term"></section>
      </main>
      <aside class="right-rail">
        <section class="panel proof" id="region-proof"></section>
        <section class="panel file-edits" id="region-files"></section>
        <section class="panel attention" id="region-attn"></section>
      </aside>
      <div id="region-sensors"></div>
    `;
  }

  inject("region-top", { title: view.title, subtitle: view.subtitle, topPills: view.topPills, mode: view.mode, modeLabel: view.modeLabel }, TopBar);
  inject("region-chat", view.conversation, Chat, true);

  // Combine view.activeEvent and proc telemetry for the rich center module
  inject("region-hero", { e: view.activeEvent, p: proc }, () => Activities(view.activeEvent, proc));

  inject("region-term", view.terminal, Terminal, true);
  inject("region-proof", view.proof, Proof);
  inject("region-files", view.fileEdits, Files, true);
  inject("region-attn", view.attention, Attn, true);
  inject("region-sensors", view.sensors, Sensors);

  const boot = document.getElementById("boot");
  if (boot && !boot.classList.contains("fade-out")) {
    boot.classList.add("fade-out");
    document.getElementById("app-mount").classList.remove("hidden");
    setTimeout(() => boot.remove(), 600);
  }
}

/* --- Mock Data Fallback --- */
const getMockView = () => ({
  title: "OpenClaw Signal Desk", subtitle: "Agent Home", mode: "working", modeLabel: "Working",
  topPills: [{ label: "Working", status: "working" }, { label: "Gateway ok", status: "ok" }, { label: new Date().toISOString(), status: "active", kind: "timestamp" }],
  conversation: {
    title: "OpenClaw Messages", kicker: "Telegram-origin session", messages: [
      { role: "human", actor: "User", text: "Can you make the progress visible without Task Manager?", at: new Date(Date.now() - 60000).toISOString() },
      { role: "agent", actor: "Agent", text: "I am adding backend Windows process telemetry and honest ETA confidence.", at: new Date().toISOString() }
    ]
  },
  activeEvent: { status: "running", title: "rclone.exe pid 4242", command: "rclone copy OneDrive:/Desktop/Sample D:/Archives", durationMs: 184000 },
  terminal: {
    title: "PowerShell Transparency", events: [
      { status: "running", title: "rclone.exe pid 4242", command: "rclone copy OneDrive:/Desktop/Sample D:/Archives", detail: "rate 4.2 MB/s · eta unknown", at: new Date().toISOString() }
    ]
  },
  proof: { cards: [{ label: "Collectors", value: "8/8 ok", status: "ok" }, { label: "Disk I/O", value: "4.2 MB/s", status: "active" }] },
  fileEdits: { title: "File Edits", count: 1, items: [{ path: "public/styles.css", added: 2, removed: 1, exactHunks: [{ header: "@@ -1,3 +1,3 @@", lines: [" context", "-old line", "+new line"] }] }] },
  attention: { title: "Attention", count: 1, items: [{ severity: "notice", title: "BitLocker", reason: "BitLocker is turned off for volume D:" }] },
  sensors: [{ label: "Proc", value: "1", status: "active" }, { label: "TCP", value: "2", status: "active" }, { label: "Updated", value: new Date().toISOString(), status: "active" }]
});

const getMockProc = () => ({
  activities: [
    {
      id: "process:4242", status: "running", title: "rclone.exe", pid: 4242, ageMs: 184000,
      command: "rclone copy OneDrive:/Desktop/Sample D:/Archives",
      progress: { percent: null, bytesDone: 528482304, rateLabel: "4.2 MB/s", etaLabel: "unknown", confidence: "medium", reason: "Windows exposes the process, TCP ownership, and disk I/O rate, but not a universal final byte total." },
      network: { establishedConnectionCount: 2, sampleConnections: [{ state: "Established", local: "192.168.1.20:53124", remote: "203.0.113.10:443" }] }
    }
  ]
});

/* --- Loop --- */
async function tick() {
  try {
    const [viewRes, procRes] = await Promise.all([
      fetch("./api/view").catch(() => null),
      fetch("./api/processes").catch(() => null)
    ]);
    if (!viewRes || !viewRes.ok) throw new Error("View API Offline");
    render(await viewRes.json(), procRes && procRes.ok ? await procRes.json() : null);
  } catch (err) {
    // Graceful fallback to Mock Data highlighting the new process metrics UI
    render(getMockView(), getMockProc());
  }
}

setTimeout(() => { tick(); setInterval(tick, REFRESH_RATE_MS); }, 1000);