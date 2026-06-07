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
        <p class="font-mono">${escape(v.subtitle || "System Online")}</p>
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

const Hero = (ev, mode) => {
  const stat = ev?.status || mode;
  return `
    <div class="active-event-card ${cls(stat)}">
      <div class="event-head">
        <span>STAT // ${escape(statusText(stat))}</span>
        <span class="font-mono">T+ ${escape(duration(ev?.durationMs) || "LIVE")}</span>
      </div>
      <h2>${escape(ev?.title || "System Nominal")}</h2>
      ${ev?.command ? `<pre class="font-mono">${escape(ev.command)}</pre>` : ''}
      <p>${escape(ev?.detail || "All routines operating within standard parameters.")}</p>
    </div>`;
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
    : ev.detail ? `<p style="font-size:12px; color:var(--text-dim); margin-top:4px;">${escape(ev.detail)}</p>` : ''}
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

const Files = (f) => `
  <header class="panel-header">
    <h2>${escape(f?.title || "Workspace Edits")}</h2>
    <span class="font-mono">${escape(f?.count || 0)} FILES</span>
  </header>
  <div class="panel-content">
    ${f?.items?.length ? f.items.map(e => `
      <div class="file-row">
        <div class="file-row-header font-mono">
          <strong>${escape(e.path)}</strong>
          <div class="file-row-stats">
            <span class="stat-add">+${escape(e.added ?? "?")}</span>
            <span class="stat-rem">-${escape(e.removed ?? 0)}</span>
          </div>
        </div>
        ${e.rawPatch ? `<div class="diff-viewer font-mono"><table class="diff-table"><tbody>
          ${e.rawPatch.split('\n').filter(l => l.trim()).map(l => {
  const type = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'rem' : l.startsWith('@@') ? 'hunk' : 'ctx';
  return `<tr class="diff-line ${type}"><td>${escape(l)}</td></tr>`;
}).join('')}
        </tbody></table></div>` : ''}
      </div>
    `).join("") : `<div class="empty-state">${icons.empty}<p>Working tree clean</p></div>`}
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

function render(v) {
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

  inject("region-top", { t: v.title, s: v.subtitle, p: v.topPills }, () => TopBar(v));
  inject("region-chat", v.conversation, Chat, true);
  inject("region-hero", { e: v.activeEvent, m: v.mode }, () => Hero(v.activeEvent, v.mode));
  inject("region-term", v.terminal, Terminal, true);
  inject("region-proof", v.proof, Proof);
  inject("region-files", v.fileEdits, Files, true);
  inject("region-attn", v.attention, Attn, true);
  inject("region-sensors", v.sensors, Sensors);

  const boot = document.getElementById("boot");
  if (boot && !boot.classList.contains("fade-out")) {
    boot.classList.add("fade-out");
    document.getElementById("app-mount").classList.remove("hidden");
    setTimeout(() => boot.remove(), 600);
  }
}

/* --- Mock Data Fallback --- */
const getMockData = () => ({
  title: "OpenClaw Protocol", subtitle: "Agent Sandbox v2.4",
  topPills: [{ label: "Node.js", status: "ok" }, { label: "Memory: 1.2GB", status: "ok" }, { label: new Date().toISOString(), kind: "timestamp", status: "running" }],
  conversation: {
    title: "Session", kicker: "Dev", messages: [
      { role: "human", actor: "User", text: "Refactor the authentication module to use JWT.", at: new Date().toISOString() },
      { role: "agent", actor: "OpenClaw", text: "Acknowledged. I will scan `auth.ts`, update the session handling, and generate the necessary asymmetric keys.", at: new Date().toISOString() }
    ]
  },
  activeEvent: { status: "running", durationMs: 4200, title: "Generating Cryptographic Keys", command: "$ openssl genpkey -algorithm RSA", detail: "Creating secure RSA-2048 keypair for JWT signing." },
  terminal: {
    title: "Agent Execution Trace", events: [
      { status: "done", title: "Read auth.ts", command: "cat src/auth.ts", at: new Date(Date.now() - 5000).toISOString() },
      { status: "running", title: "NPM Install", command: "npm i jsonwebtoken", detail: '{\n  "added": 14,\n  "audited": 240\n}', at: new Date().toISOString() }
    ]
  },
  proof: { cards: [{ label: "Tokens", value: "4,028", status: "ok" }, { label: "Cost", value: "$0.14", status: "ok" }] },
  fileEdits: { title: "Diff Viewer", count: 1, items: [{ path: "src/auth.ts", added: 4, removed: 1, rawPatch: "@@ -14,2 +14,5 @@\n- export const session = {};\n+ import jwt from 'jsonwebtoken';\n+ export const generateToken = (id) => {\n+   return jwt.sign({ id }, process.env.SECRET);\n+ };" }] },
  attention: { title: "Alerts", count: 1, items: [{ severity: "warning", title: "Missing ENV Variable", reason: "JWT_SECRET is not defined in .env" }] },
  sensors: [{ label: "CPU", value: "14%", status: "ok" }, { label: "Network", value: "42ms", status: "ok" }, { label: "Model", value: "GPT-4", status: "ok" }]
});

/* --- Loop --- */
async function tick() {
  try {
    const res = await fetch("./api/view");
    if (!res.ok) throw new Error("API Offline");
    render(await res.json());
  } catch (err) {
    // Graceful fallback to Mock Data so the UI can be previewed immediately 
    render(getMockData());
  }
}

setTimeout(() => { tick(); setInterval(tick, REFRESH_RATE_MS); }, 1000);
