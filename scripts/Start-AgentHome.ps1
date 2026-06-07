# Copyright 2026 Roni Tervo
# SPDX-License-Identifier: Apache-2.0

param(
  [int]$Port = 18880,
  [switch]$Open
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$env:AGENT_HOME_PORT = [string]$Port

if ($Open) {
  Start-Process "http://127.0.0.1:$Port/"
}

Push-Location $root
try {
  npm start
}
finally {
  Pop-Location
}
