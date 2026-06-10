# Copyright 2026 Roni Tervo
# SPDX-License-Identifier: Apache-2.0

param(
  [int]$Port = 18880,
  [int]$Width = 1920,
  [int]$Height = 1080
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$url = "http://127.0.0.1:$Port/"
$serverProcess = $null

Push-Location $root
try {
  node src/server.mjs --snapshot | ConvertFrom-Json | Out-Null
  Write-Host "Snapshot ok"

  Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
    Where-Object { $_.CommandLine -like "*agent-home*" -and $_.CommandLine -like "*src/server.mjs*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object {
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($_.OwningProcess)" -ErrorAction SilentlyContinue
      if ($proc.Name -eq "node.exe" -and $proc.CommandLine -like "*src/server.mjs*") {
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
      }
    }
  $serverProcess = Start-Process -FilePath "node" -ArgumentList "src/server.mjs" -WorkingDirectory $root -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 2

  $edgePaths = @(
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
  )
  $edge = $edgePaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $edge) {
    Write-Warning "Edge not found; skipping viewport verification."
    return
  }

  $debugPort = 9230
  $profile = Join-Path $root ".edge-verify-profile"
  Start-Process -FilePath $edge -ArgumentList @(
    "--headless=new",
    "--remote-debugging-port=$debugPort",
    "--user-data-dir=$profile",
    "--disable-gpu",
    "about:blank"
  ) -WindowStyle Hidden
  Start-Sleep -Seconds 2

  $env:AGENT_HOME_VERIFY_PORT = [string]$debugPort
  $env:AGENT_HOME_VERIFY_WIDTH = [string]$Width
  $env:AGENT_HOME_VERIFY_HEIGHT = [string]$Height
  $env:AGENT_HOME_VERIFY_URL = $url
  $env:AGENT_HOME_VERIFY_SCREENSHOT = (Join-Path $root "agent-home-signal-desk-1920-current.png")

  $probe = @'
const port = Number(process.env.AGENT_HOME_VERIFY_PORT);
const width = Number(process.env.AGENT_HOME_VERIFY_WIDTH);
const height = Number(process.env.AGENT_HOME_VERIFY_HEIGHT);
const url = process.env.AGENT_HOME_VERIFY_URL;
const screenshotPath = process.env.AGENT_HOME_VERIFY_SCREENSHOT;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function getJson(target) {
  const response = await fetch(target);
  if (!response.ok) throw new Error(`${target} -> ${response.status}`);
  return response.json();
}
async function main() {
  const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
  const target = targets.find((item) => item.type === "page") || targets[0];
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  await new Promise((resolve) => { ws.onopen = resolve; });
  const send = (method, params = {}) => new Promise((resolve) => {
    const callId = ++id;
    pending.set(callId, resolve);
    ws.send(JSON.stringify({ id: callId, method, params }));
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  for (let i = 0; i < 25; i++) {
    const ready = await send("Runtime.evaluate", { returnByValue: true, expression: "Boolean(document.querySelector('#app-mount:not(.hidden) #region-top') && document.querySelectorAll('.panel').length >= 3)" });
    if (ready.result.result.value) break;
    await sleep(1000);
  }
  const result = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => ({
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      overflowY: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      visiblePanels: [...document.querySelectorAll('.panel')].filter((node) => getComputedStyle(node).display !== 'none').length,
      screen: document.querySelector('#region-term h2')?.innerText || null,
      sensors: document.querySelectorAll('.sensor').length
    }))()`
  });
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  if (shot.result?.data && screenshotPath) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(screenshotPath, Buffer.from(shot.result.data, "base64"));
  }
  console.log(JSON.stringify(result.result.result.value, null, 2));
  if (result.result.result.value.overflowX || result.result.result.value.overflowY) {
    process.exitCode = 1;
  }
  ws.close();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
'@

  $probe | node -
  if ($LASTEXITCODE -ne 0) {
    throw "Viewport verification failed."
  }
}
finally {
  Get-CimInstance Win32_Process -Filter "name = 'msedge.exe'" |
    Where-Object { $_.CommandLine -like "*remote-debugging-port=9230*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($serverProcess -and -not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
  }
  Pop-Location
}
