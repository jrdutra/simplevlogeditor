<#
.SYNOPSIS
  Installs the SimpleVlogEditor plugin into Claude Code.

.DESCRIPTION
  Does the four things that have to happen in order, and stops at the first one
  that fails with the command that fixes it:

    1. installs the Electron dependencies, if they are missing
    2. builds the web bundle, if it is missing
    3. runs the plugin doctor, which records where this checkout is
    4. adds the local marketplace and installs the plugin

  Step 3 is not optional and not cosmetic. Claude Code copies a plugin into
  ~/.claude/plugins/cache when it installs it, so the installed copy has no way
  to know where this repository is. The doctor writes that location under
  LOCALAPPDATA, and the plugin's launcher reads it from there.

.PARAMETER SkipBuild
  Leaves the web bundle alone. Use it when you have just built, or when you want
  to build yourself.

.PARAMETER SkipTests
  Skips the MCP protocol tests the doctor normally runs.

.EXAMPLE
  .\ai-client\claude\install.ps1
#>

[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'

$marketplaceRoot = $PSScriptRoot
$pluginRoot = Join-Path $marketplaceRoot 'plugins\simple-vlog-editor'
$projectRoot = (Resolve-Path (Join-Path $marketplaceRoot '..\..')).Path

function Write-Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "    $text" -ForegroundColor Green }
function Fail($text, $remedy) {
  Write-Host "`nFAIL $text" -ForegroundColor Red
  if ($remedy) { Write-Host "     $remedy" -ForegroundColor Yellow }
  exit 1
}

Write-Host "SimpleVlogEditor -> Claude Code" -ForegroundColor White
Write-Host "Repository: $projectRoot"

# ---------------------------------------------------------------- prerequisites
Write-Step 'Checking node and claude'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail 'Node.js was not found on PATH.' 'Install Node.js 18 or newer, then run this script again.'
}
$nodeMajor = [int](((node --version) -replace '^v', '') -split '\.')[0]
if ($nodeMajor -lt 18) { Fail "Node.js $nodeMajor is too old." 'Install Node.js 18 or newer.' }
Write-Ok "node $(node --version)"

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Fail 'The claude CLI was not found on PATH.' 'Install Claude Code, then run this script again.'
}
Write-Ok 'claude CLI found'

# ------------------------------------------------------------------ dependencies
$electronDir = Join-Path $projectRoot 'electron'
if (-not (Test-Path (Join-Path $electronDir 'node_modules\electron\package.json'))) {
  Write-Step 'Installing Electron dependencies (this takes a few minutes the first time)'
  Push-Location $electronDir
  try { npm install } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { Fail 'npm install failed in electron.' "Run it yourself in $electronDir and read the error." }
}
Write-Ok 'Electron dependencies present'

# ------------------------------------------------------------------- web bundle
$webDir = Join-Path $projectRoot 'web'
$bundle = Join-Path $webDir 'dist\browser\index.html'
if ($SkipBuild) {
  Write-Ok 'Web bundle: skipped (-SkipBuild)'
} elseif (-not (Test-Path $bundle)) {
  Write-Step 'Building the web bundle (this takes a few minutes)'
  Push-Location $webDir
  try { npm run build:site } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { Fail 'The web build failed.' "Run npm run build:site in $webDir and read the error." }
  Write-Ok 'Web bundle built'
} else {
  Write-Ok 'Web bundle present'
  Write-Host '    (it is not rebuilt automatically — run npm run build:site after changing the editor)' -ForegroundColor DarkGray
}

# ----------------------------------------------------------------------- doctor
Write-Step 'Running the plugin doctor'
$doctorArgs = @((Join-Path $pluginRoot 'scripts\doctor.mjs'))
if ($SkipTests) { $doctorArgs += '--skip-tests' }
& node @doctorArgs
if ($LASTEXITCODE -ne 0) { Fail 'The doctor found problems.' 'Fix what it listed above, then run this script again.' }

# ---------------------------------------------------------------------- install
Write-Step 'Adding the local marketplace'
& claude plugin marketplace add $marketplaceRoot
if ($LASTEXITCODE -ne 0) {
  Write-Host '    already added, or the add failed — trying to continue' -ForegroundColor DarkGray
}

Write-Step 'Installing the plugin'
& claude plugin install 'simple-vlog-editor@simplevlogeditor'
if ($LASTEXITCODE -ne 0) {
  Fail 'claude plugin install failed.' 'Read the error above. You can retry with: claude plugin install simple-vlog-editor@simplevlogeditor'
}

Write-Host "`nInstalled." -ForegroundColor Green
Write-Host @'
    Start a NEW Claude Code session so its tools and skill are loaded, from the
    folder that holds your videos and where the exports should go — that folder
    is what the editor is allowed to read and write.

    Then just ask, for example:
      "Edit my vlog, cut the repeated takes and place the screenshots where I mention them."
'@
