<#
  chrome-debug.ps1 — 开关「可被 agent 操作的浏览器调试实例」

  为什么需要它：Chrome 136+ 只允许用**非默认**数据目录开启远程调试，所以这里用独立的
  profile + 固定端口。传统端口模式不做逐连接授权，因此不会有授权弹窗。

  用法（默认 toggle）：
    powershell -NoProfile -ExecutionPolicy Bypass -File chrome-debug.ps1 toggle
    powershell ... -File chrome-debug.ps1 start | stop | status
#>
param([ValidateSet('start', 'stop', 'toggle', 'status')][string]$Action = 'toggle')

$ErrorActionPreference = 'SilentlyContinue'

function Find-Browser {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
  )
  foreach ($p in $candidates) { if ($p -and (Test-Path $p)) { return $p } }
  return $null
}

# 调试 profile：优先沿用早期版本用的目录，避免丢掉已经登好的登录态
$legacyProfile = Join-Path $env:USERPROFILE 'chrome-dsh-debug'
$modernProfile = Join-Path $env:USERPROFILE 'winchrome-profile'
$profile = if (Test-Path $legacyProfile) { $legacyProfile } else { $modernProfile }
$port = 9222
$exe = Find-Browser

function Test-Listening { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }
function Get-DebugProc { @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*$profile*" }) }

function Do-Start {
  if (-not $exe) { Write-Host '找不到 Chrome/Edge，请检查安装位置' -ForegroundColor Red; return }
  if (Test-Listening) { Write-Host "调试实例已在运行（端口 $port），无需重复启动" -ForegroundColor Yellow; return }
  Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$port", "--user-data-dir=$profile", '--no-first-run', '--no-default-browser-check'
  for ($i = 0; $i -lt 24; $i++) { Start-Sleep -Milliseconds 500; if (Test-Listening) { break } }
  if (Test-Listening) { Write-Host "已启动调试实例（端口 $port），agent 现在可以操作它" -ForegroundColor Green }
  else { Write-Host '启动后端口仍未监听，检查是否有策略限制' -ForegroundColor Red }
}

function Do-Stop {
  $p = Get-DebugProc
  if (-not $p.Count) { Write-Host '调试实例未在运行' -ForegroundColor Yellow; return }
  $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host ("已关闭调试实例（{0} 个进程）；agent 的浏览器工具会暂时不可用" -f $p.Count) -ForegroundColor Green
}

switch ($Action) {
  'start' { Do-Start }
  'stop' { Do-Stop }
  'status' {
    Write-Host ("浏览器    : {0}" -f $(if ($exe) { $exe } else { '未找到' }))
    Write-Host ("数据目录  : {0}" -f $profile)
    if (Test-Listening) { Write-Host ("状态      : 运行中（端口 {0}，{1} 个进程）" -f $port, (Get-DebugProc).Count) -ForegroundColor Green }
    else { Write-Host '状态      : 未运行' -ForegroundColor Yellow }
  }
  default { if (Test-Listening) { Do-Stop } else { Do-Start } }
}
