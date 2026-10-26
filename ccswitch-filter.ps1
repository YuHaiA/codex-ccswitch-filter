[CmdletBinding()]
param(
    [ValidateSet('Menu', 'Panel', 'StopAll', 'Start', 'Stop', 'Restart', 'Status', 'Run', 'Test')]
    [string]$Action = 'Status',
    [ValidateRange(1024, 65535)]
    [int]$Port = 18181,
    [ValidateRange(1024, 65535)]
    [int]$PanelPort = 18180,
    [string]$Upstream,
    [string]$Config,
    [string]$Runtime,
    [string]$CcDb,
    # Launched without a console (from the .vbs): report failures in a message box.
    [switch]$Gui
)
$ErrorActionPreference = 'Stop'
if ($Gui) {
    trap {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show("控制面板启动失败：`n$($_.Exception.Message)`n`n可运行 打开控制面板.cmd 查看详细输出。", 'Codex 过滤层', 'OK', 'Warning')
        exit 1
    }
}

# Prefer an explicit Node, then any Node 24+ on PATH, then the Codex bundled runtime.
$nodeCandidates = @()
if ($env:CCSWITCH_FILTER_NODE) { $nodeCandidates += $env:CCSWITCH_FILTER_NODE }
$nodeCandidates += @(Get-Command node -All -ErrorAction SilentlyContinue | ForEach-Object Source)
$nodeCandidates += Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$nodeCandidates += Join-Path $env:LOCALAPPDATA 'Programs\Codex\resources\node.exe'
$nodeCandidates += Join-Path $env:LOCALAPPDATA 'Programs\Codex\resources\app\node.exe'
$nodeCommand = $null
foreach ($candidate in $nodeCandidates | Select-Object -Unique) {
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    $version = (& $candidate --version) -replace '^v', ''
    $major = [int](($version -split '\.')[0])
    if ($major -ge 24) { $nodeCommand = Get-Command $candidate; break }
}
if (-not $nodeCommand) {
    throw '需要 Node.js 24 或更高版本。请安装 Node.js 24+，重新打开本工具；也可将环境变量 CCSWITCH_FILTER_NODE 指向 node.exe。'
}

# Shows node output on the console and returns only the exit code (use -Capture to get the output instead).
function Invoke-Filter([string]$Operation, [switch]$Capture, [string]$Script = 'filter.cjs', [string[]]$Extra = @()) {
    $filterArguments = @((Join-Path $PSScriptRoot $Script), $Operation) + $Extra + @('--port', $Port.ToString())
    if ($Upstream) { $filterArguments += @('--upstream', $Upstream) }
    if ($Config) { $filterArguments += @('--config', $Config) }
    if ($Runtime) { $filterArguments += @('--runtime', $Runtime) }
    if ($CcDb) { $filterArguments += @('--cc-db', $CcDb) }
    if ($Capture) { return (& $nodeCommand.Source @filterArguments 2>&1 | Out-String) }
    & $nodeCommand.Source @filterArguments | Out-Host
    return $LASTEXITCODE
}

# Short human-readable status for the menu.
function Show-Brief {
    $raw = Invoke-Filter 'status' -Capture
    try {
        $s = $raw | ConvertFrom-Json
        if ($s.running) {
            $color = if ($s.state -eq 'filtering' -and $s.ccSwitchReachable) { 'Green' } else { 'Yellow' }
            Write-Host ("  状态: 运行中 ({0})  CC Switch 可达: {1}" -f $s.state, $s.ccSwitchReachable) -ForegroundColor $color
            Write-Host ("  已过滤请求: {0}  上游错误: {1}  最后过滤: {2}" -f $s.stats.filteredRequests, $s.stats.upstreamHttpErrors, $s.stats.lastFilteredAt)
        } else {
            Write-Host '  状态: 已停止 (Codex 直连 CC Switch)' -ForegroundColor Gray
        }
    } catch { Write-Host $raw -ForegroundColor Red }
}

function Show-RestartHint {
    Write-Host ''
    Write-Host '  提示: 地址已切换，请完全退出并重新打开 Codex 才会生效。' -ForegroundColor Cyan
}

if ($Action -eq 'Menu') {
    while ($true) {
        Clear-Host
        Write-Host '==== CC Switch / Codex 过滤层 ===='
        Show-Brief
        Write-Host ''
        Write-Host '  1. 启动'
        Write-Host '  2. 停止 (恢复直连)'
        Write-Host '  3. 重启 (更新脚本后使用)'
        Write-Host '  4. 详细状态'
        Write-Host '  0. 退出'
        $choice = Read-Host '请选择'
        Write-Host ''
        switch ($choice) {
            '1' { if ((Invoke-Filter 'start') -eq 0) { Show-RestartHint } }
            '2' { if ((Invoke-Filter 'stop') -eq 0) { Show-RestartHint } }
            '3' { if ((Invoke-Filter 'stop') -eq 0 -and (Invoke-Filter 'start') -eq 0) { Show-RestartHint } }
            '4' { [void](Invoke-Filter 'status') }
            '0' { exit 0 }
            default { continue }
        }
        Write-Host ''
        Read-Host '按回车返回菜单' | Out-Null
    }
}

if ($Action -in 'Panel', 'StopAll') {
    $operation = if ($Action -eq 'Panel') { 'open' } else { 'stop-all' }
    $code = Invoke-Filter $operation -Script 'panel.cjs' -Extra @('--panel-port', $PanelPort.ToString())
} elseif ($Action -eq 'Test') {
    & $nodeCommand.Source --test (Join-Path $PSScriptRoot 'filter.test.cjs') (Join-Path $PSScriptRoot 'rate-limit.test.cjs')
    $code = $LASTEXITCODE
} elseif ($Action -eq 'Restart') {
    $code = Invoke-Filter 'stop'
    if ($code -eq 0) { $code = Invoke-Filter 'start' }
} else {
    $operation = $Action.ToLowerInvariant()
    if ($Action -eq 'Run') { $operation = 'serve' }
    $code = Invoke-Filter $operation
}
if ($code -ne 0) {
    if ($Gui) { throw "命令退出代码 $code。详见 .runtime\panel.log" }
    exit $code
}
