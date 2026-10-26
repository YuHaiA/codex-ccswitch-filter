$ErrorActionPreference = 'Stop'

function Show-Result([bool]$Ok, [string]$Text) {
    $mark = if ($Ok) { '[OK]' } else { '[CHECK]' }
    $color = if ($Ok) { 'Green' } else { 'Yellow' }
    Write-Host "$mark $Text" -ForegroundColor $color
}

Write-Host 'CC Switch / Codex Filter - Environment Check' -ForegroundColor Cyan
Write-Host ''

$nodeCandidates = @()
if ($env:CCSWITCH_FILTER_NODE) { $nodeCandidates += $env:CCSWITCH_FILTER_NODE }
$nodeCandidates += @(Get-Command node -All -ErrorAction SilentlyContinue | ForEach-Object Source)
$nodeCandidates += Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$nodeCandidates += Join-Path $env:LOCALAPPDATA 'Programs\Codex\resources\node.exe'
$nodeCandidates += Join-Path $env:LOCALAPPDATA 'Programs\Codex\resources\app\node.exe'
$node = $null
foreach ($candidate in $nodeCandidates | Select-Object -Unique) {
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    try {
        $version = (& $candidate --version) -replace '^v', ''
        if ([int](($version -split '\.')[0]) -ge 24) {
            $node = [pscustomobject]@{ Path = $candidate; Version = $version }
            break
        }
    } catch {}
}
$nodeText = if ($node) { "Node.js $($node.Version): $($node.Path)" } else { 'Node.js 24+ was not found. Install it before using this tool.' }
Show-Result ($null -ne $node) $nodeText

$codexConfig = if ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME 'config.toml' } else { Join-Path $env:USERPROFILE '.codex\config.toml' }
Show-Result (Test-Path -LiteralPath $codexConfig) "Codex config: $codexConfig"

$ccDb = Join-Path $env:USERPROFILE '.cc-switch\cc-switch.db'
Show-Result (Test-Path -LiteralPath $ccDb) "CC Switch config: $ccDb"

$ports = @(18180, 18181) | ForEach-Object {
    Get-NetTCPConnection -State Listen -LocalPort $_ -ErrorAction SilentlyContinue
}
$portText = if ($ports) { 'Port 18180 or 18181 is in use. Ignore this only when this tool is already running.' } else { 'Default ports 18180 and 18181 are available.' }
Show-Result (-not $ports) $portText

Write-Host ''
if ($node -and (Test-Path -LiteralPath $codexConfig) -and (Test-Path -LiteralPath $ccDb)) {
    Write-Host 'Basic requirements are ready. Enable Local Proxy and Codex takeover in CC Switch, then open the control panel.' -ForegroundColor Green
} else {
    Write-Host 'Resolve each CHECK item above. This package does not install Node.js, CC Switch, or account settings.' -ForegroundColor Yellow
}
