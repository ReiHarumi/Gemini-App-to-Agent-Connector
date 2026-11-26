Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32Window {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

$script:hiddenChromeHandles = New-Object System.Collections.Generic.List[IntPtr]

function Hide-ChromeToTray {
  $procs = Get-Process -Name "chrome" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero }
  $count = 0
  foreach ($p in $procs) {
    $h = $p.MainWindowHandle
    [Win32Window]::ShowWindow($h, 0) | Out-Null # SW_HIDE
    if (-not $script:hiddenChromeHandles.Contains($h)) {
      $script:hiddenChromeHandles.Add($h)
    }
    $count++
  }
  return $count
}

function Show-ChromeFromTray {
  $count = 0
  foreach ($h in $script:hiddenChromeHandles) {
    [Win32Window]::ShowWindow($h, 5) | Out-Null # SW_SHOW
    [Win32Window]::SetForegroundWindow($h) | Out-Null
    $count++
  }
  $script:hiddenChromeHandles.Clear()
  return $count
}

# Single-instance guard so login/restarts never create duplicate tray icons
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Global\GeminiMcpTray", [ref]$createdNew)
if (-not $createdNew) {
  exit 0
}

$baseDir = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $PSScriptRoot "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { $nodeExe = "node.exe" }

$servers = @(
  @{
    Name = "gemini-browser-mcp"
    Dir  = Join-Path $baseDir "gemini-browser-mcp"
    Port = 3000
    Proc = $null
  },
  @{
    Name = "agent-relay-mcp"
    Dir  = Join-Path $baseDir "agent-relay-mcp"
    Port = 3001
    Proc = $null
  }
)

function Start-McpServer($svc) {
  $outLog = Join-Path $logDir "$($svc.Name).out.log"
  $errLog = Join-Path $logDir "$($svc.Name).err.log"
  $svc.Proc = Start-Process -FilePath $nodeExe `
    -ArgumentList "dist/index.js" `
    -WorkingDirectory $svc.Dir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -PassThru
}

function Stop-AllServers {
  foreach ($svc in $servers) {
    if ($svc.Proc -and -not $svc.Proc.HasExited) {
      try { Stop-Process -Id $svc.Proc.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
    $svc.Proc = $null
  }
}

function Ensure-AllRunning {
  foreach ($svc in $servers) {
    if (-not $svc.Proc -or $svc.Proc.HasExited) {
      Start-McpServer $svc
    }
  }
}

# Start both MCP servers silently
Ensure-AllRunning

# Build Hidden Icons Tray App (zero taskbar window)
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = [System.Drawing.SystemIcons]::Application
$tray.Text = "Gemini MCP Servers (3000 & 3001)"
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$statusItem = $menu.Items.Add("Check Status")
$statusItem.Add_Click({
  $lines = foreach ($svc in $servers) {
    $state = if ($svc.Proc -and -not $svc.Proc.HasExited) { "RUNNING (PID $($svc.Proc.Id))" } else { "STOPPED" }
    "$($svc.Name) [:$($svc.Port)] - $state"
  }
  $tray.BalloonTipTitle = "Gemini MCP Status"
  $tray.BalloonTipText = ($lines -join "`n")
  $tray.ShowBalloonTip(5000)
})

$restartItem = $menu.Items.Add("Restart Both MCP Servers")
$restartItem.Add_Click({
  Stop-AllServers
  Start-Sleep -Milliseconds 600
  Ensure-AllRunning
  $tray.BalloonTipTitle = "Gemini MCP"
  $tray.BalloonTipText = "Restarted gemini-browser-mcp (:3000) & agent-relay-mcp (:3001)"
  $tray.ShowBalloonTip(4000)
})

$openDevItem = $menu.Items.Add("Open Gemini DevMode")
$openDevItem.Add_Click({
  Show-ChromeFromTray | Out-Null
  Start-Process "https://gemini.google.com/devmode"
})

$hideChromeItem = $menu.Items.Add("Hide Chrome to Tray (Keep Running)")
$hideChromeItem.Add_Click({
  $n = Hide-ChromeToTray
  $tray.BalloonTipTitle = "Chrome Hidden to Tray"
  $tray.BalloonTipText = "Hid $n Chrome window(s) from taskbar. Gemini relay stays live!"
  $tray.ShowBalloonTip(3500)
})

$showChromeItem = $menu.Items.Add("Show Chrome Window")
$showChromeItem.Add_Click({
  $n = Show-ChromeFromTray
  if ($n -eq 0) { Start-Process "chrome.exe" }
})

$logsItem = $menu.Items.Add("Open Logs Folder")
$logsItem.Add_Click({
  Start-Process explorer.exe $logDir
})

$null = $menu.Items.Add("-")

$exitItem = $menu.Items.Add("Exit (Stop MCP Servers)")
$exitItem.Add_Click({
  Show-ChromeFromTray | Out-Null
  Stop-AllServers
  $tray.Visible = $false
  $tray.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$tray.ContextMenuStrip = $menu

# Watchdog timer: auto-restart either server if it exits unexpectedly
$watchdog = New-Object System.Windows.Forms.Timer
$watchdog.Interval = 10000
$watchdog.Add_Tick({ Ensure-AllRunning })
$watchdog.Start()

$tray.BalloonTipTitle = "Gemini MCP Ready"
$tray.BalloonTipText = "Browser MCP (:3000) & Relay MCP (:3001) running silently in background."
$tray.ShowBalloonTip(3500)

[System.Windows.Forms.Application]::Run()
$mutex.ReleaseMutex()
