// Copyright 2026 Roni Tervo
// SPDX-License-Identifier: Apache-2.0

const REFRESH_RATE_MS = 3000;
let stateCache = {};
let terminalFilter = "all";
let latestView = null;
let latestProc = null;

/* --- Utils & Formatters --- */
const cls = (v) => String(v || "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
const escape = (v) => String(v ?? "").replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
const timeFormat = (iso) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(iso ? new Date(iso) : new Date());

const duration = (ms) => {
  if (ms === undefined || ms === null || !Number.isFinite(Number(ms))) return "";
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
  if (["done", "ok", "clean", "quiet", "idle"].includes(s)) return "OK";
  if (["scheduled"].includes(s)) return "DUE";
  if (["needs-you", "waiting-for-user"].includes(s)) return "YOU";
  if (["failed", "warning", "urgent"].includes(s)) return "ERR";
  if (["running", "working", "active", "responding"].includes(s)) return "RUN";
  return String(s || "INF").toUpperCase().substring(0, 3);
};

const shortText = (value, max = 120) => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trim()}...` : text;
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
          <span class="chat-channel font-mono ${cls(m.channel)}">${escape(m.channel || (m.role === "agent" ? "agent" : "openclaw"))}</span>
          <span class="time font-mono">${escape(timeFormat(m.at))}</span>
        </div>
        <p>${escape(m.text)}</p>
      </div>
    `).join("") : `<div class="empty-state">${icons.empty}<p>No transcript</p></div>`}
  </div>`;

const ReactionForecast = (forecast) => {
  if (!forecast || (!forecast.state && !forecast.label && !(forecast.items || []).length)) return "";
  const primary = (forecast.items || [])[0] || {};
  const state = forecast.state || primary.status || "unknown";
  const source = forecast.primarySource || primary.source || "";
  const when = forecast.knownFutureAvailable && forecast.nextKnownLabel && forecast.nextKnownLabel !== "unknown"
    ? forecast.nextKnownLabel
    : primary.etaLabel && primary.etaLabel !== "unknown"
      ? primary.etaLabel
      : "unknown";
  const label = forecast.label || primary.title || "Next reaction unknown";
  const detail = forecast.detail || primary.reason || primary.detail || "";

  return `
    <div class="next-reaction ${cls(state)}">
      <div class="next-reaction-top font-mono">
        <span>NEXT // ${escape(statusText(state))}</span>
        <span>${escape(when)}</span>
      </div>
      <div class="next-reaction-main">
        <strong>${escape(shortText(label, 96))}</strong>
        <span>${escape(forecast.confidence || primary.confidence || "unknown")} confidence${source ? ` / ${escape(source)}` : ""}</span>
      </div>
      ${detail ? `<p>${escape(shortText(detail, 150))}</p>` : ""}
    </div>`;
};

// Renders deep process metrics exposing backend telemetry cleanly without inventing data.
const Activities = (activeEv, proc, forecast) => {
  const processCards = (proc?.activities || []).map(act => {
    const prog = act.progress || {};
    const percent = Number(prog.percent);
    const hasPercent = Number.isFinite(percent);
    const isIndet = !hasPercent;
    const pct = isIndet ? 100 : Math.max(0, Math.min(100, percent));
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

  return `<div class="activities-stack">${ReactionForecast(forecast)}${processCards || fallbackCard}</div>`;
};

const Terminal = (t) => {
  const filters = t?.filters?.length ? t.filters : [
    { id: "all", label: "All", count: t?.events?.length || 0 },
    { id: "manual", label: "Manual", count: t?.manualEvents?.length || 0 },
  ];
  const events = terminalFilter === "manual" ? (t?.manualEvents || []) : (t?.events || []);

  return `
  <header class="panel-header terminal-header">
    <h2>${escape(t?.title || "Execution Trace")}</h2>
    <div class="terminal-header-tools">
      <span class="font-mono">${escape(t?.kicker || "Monitoring")}</span>
      <div class="terminal-filter font-mono" aria-label="Trace filter">
        ${filters.map(f => `
          <button type="button" class="${terminalFilter === f.id ? "active" : ""}" data-term-filter="${escape(f.id)}" aria-pressed="${terminalFilter === f.id}">
            ${escape(f.label)} <span>${escape(f.count ?? 0)}</span>
          </button>
        `).join("")}
      </div>
    </div>
  </header>
  <div class="panel-content">
    ${events.length ? events.map(ev => `
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
    `).join("") : `<div class="empty-state">${icons.empty}<p>${terminalFilter === "manual" ? "No manual commands" : "No active traces"}</p></div>`}
  </div>`;
};

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
  latestView = view;
  latestProc = proc;

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

  // Combine view.activeEvent, process telemetry, and reaction forecast for the rich center module.
  inject("region-hero", { e: view.activeEvent, p: proc, r: view.reactionForecast }, () => Activities(view.activeEvent, proc, view.reactionForecast));

  inject("region-term", { terminal: view.terminal, filter: terminalFilter }, () => Terminal(view.terminal), true);
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

const emptyView = () => ({
  title: "OpenClaw Signal Desk",
  subtitle: "Agent Home",
  mode: "quiet",
  modeLabel: "Quiet",
  topPills: [],
  conversation: { title: "OpenClaw Messages", kicker: "", messages: [] },
  activeEvent: null,
  terminal: {
    title: "PowerShell Transparency",
    events: [],
    manualEvents: [],
    filters: [
      { id: "all", label: "All", count: 0 },
      { id: "manual", label: "Manual", count: 0 },
    ],
  },
  proof: { cards: [] },
  fileEdits: { title: "File Edits", count: 0, items: [] },
  attention: { title: "Attention", count: 0, items: [] },
  sensors: []
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
    render(emptyView(), null);
  }
}

document.addEventListener("click", (event) => {
  const filterButton = event.target.closest("[data-term-filter]");
  if (!filterButton) return;
  const nextFilter = filterButton.dataset.termFilter || "all";
  if (nextFilter === terminalFilter) return;
  terminalFilter = nextFilter;
  delete stateCache["region-term"];
  if (latestView) render(latestView, latestProc);
});

setTimeout(() => { tick(); setInterval(tick, REFRESH_RATE_MS); }, 1000);
