# Copyright 2026 Roni Tervo
# SPDX-License-Identifier: Apache-2.0

param(
  [int]$Port = 18880,
  [switch]$Fullscreen
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$url = "http://127.0.0.1:$Port/"

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $listener) {
  Start-Process -FilePath "node" -ArgumentList "src/server.mjs" -WorkingDirectory $root -WindowStyle Hidden
  Start-Sleep -Seconds 2
}

$edgePaths = @(
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
)

$edge = $edgePaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if ($edge) {
  $args = @("--new-window", "--app=$url")
  if ($Fullscreen) {
    $args += "--start-fullscreen"
  }
  Start-Process -FilePath $edge -ArgumentList $args
  return
}

Start-Process $url
