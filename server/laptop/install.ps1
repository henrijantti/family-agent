# Installs the laptop's Claude Code permissions for server work (Machina).
# Run in PowerShell from the repo root:  powershell -ExecutionPolicy Bypass -File server\laptop\install.ps1
# 1. Copies project-settings.json to .claude\settings.local.json (this repo only).
# 2. Merges the "autoMode" block of user-automode.json into ~\.claude\settings.json,
#    keeping every other user setting. Backs the file up first and refuses to save
#    anything that does not parse as JSON. Restart Claude Code afterwards.
$ErrorActionPreference = 'Stop'
# Write UTF-8 without a BOM (Windows PowerShell 5 adds one with -Encoding UTF8).
$utf8 = New-Object System.Text.UTF8Encoding $false
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here '..\..')

$project = Get-Content (Join-Path $here 'project-settings.json') -Raw
$null = $project | ConvertFrom-Json
New-Item -ItemType Directory -Force (Join-Path $repo '.claude') | Out-Null
[IO.File]::WriteAllText((Join-Path $repo '.claude\settings.local.json'), $project, $utf8)
Write-Output 'project settings: written'

$userFile = Join-Path $HOME '.claude\settings.json'
if (Test-Path $userFile) {
  Copy-Item $userFile "$userFile.before-install" -Force
  $user = Get-Content $userFile -Raw | ConvertFrom-Json
} else {
  New-Item -ItemType Directory -Force (Split-Path $userFile) | Out-Null
  $user = [pscustomobject]@{}
}
$auto = (Get-Content (Join-Path $here 'user-automode.json') -Raw | ConvertFrom-Json).autoMode
$user | Add-Member -NotePropertyName autoMode -NotePropertyValue $auto -Force
$out = $user | ConvertTo-Json -Depth 50
$null = $out | ConvertFrom-Json
[IO.File]::WriteAllText($userFile, $out, $utf8)
Write-Output 'user settings: autoMode merged (backup: settings.json.before-install). Restart Claude Code.'
