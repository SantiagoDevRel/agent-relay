# Brings an open chat to the front: selects the Windows Terminal tab whose title is
# the chat's title (UI Automation) and activates that window. Changes nothing else.
# The title arrives in an environment variable, never as code: CHATS_FOCUS_TITLE.
# Prints one JSON line: { found, matches, focused }.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace ChatsDashboard -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
'@

# Claude Code puts a status glyph (a star or a spinner) before its title; Codex does not.
function Get-Bare([string]$text) {
  if (-not $text) { return '' }
  return ($text.Normalize([Text.NormalizationForm]::FormC) -replace '^[^\p{L}\p{N}]+', '').Trim()
}

$want = Get-Bare $env:CHATS_FOCUS_TITLE
$auto = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]
$isWindow = New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
$isTab = New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
$terminals = @(Get-Process -Name WindowsTerminal -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })

$hits = New-Object System.Collections.ArrayList
if ($want -and $terminals.Count) {
  foreach ($window in $auto::RootElement.FindAll($scope::Children, $isWindow)) {
    if ($terminals -notcontains $window.Current.ProcessId) { continue }
    foreach ($tab in $window.FindAll($scope::Descendants, $isTab)) {
      if ([string]::Equals((Get-Bare $tab.Current.Name), $want, [StringComparison]::OrdinalIgnoreCase)) {
        [void]$hits.Add(@($window, $tab))
      }
    }
  }
}
if ($hits.Count -eq 0) {
  @{ found = $false; matches = 0; focused = $false } | ConvertTo-Json -Compress
  exit 0
}

$window, $tab = $hits[0]
$tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
$handle = [IntPtr]$window.Current.NativeWindowHandle
if ([ChatsDashboard.Win]::IsIconic($handle)) { [void][ChatsDashboard.Win]::ShowWindow($handle, 9) } # SW_RESTORE
[void][ChatsDashboard.Win]::SetForegroundWindow($handle)
if ([ChatsDashboard.Win]::GetForegroundWindow() -ne $handle) {
  # Windows only lets the process that received the last input take the foreground.
  # A bare Alt press and release (no character, no shortcut) makes this script that process.
  [ChatsDashboard.Win]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [void][ChatsDashboard.Win]::SetForegroundWindow($handle)
  [ChatsDashboard.Win]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
}
@{ found = $true; matches = $hits.Count; focused = ([ChatsDashboard.Win]::GetForegroundWindow() -eq $handle) } | ConvertTo-Json -Compress
