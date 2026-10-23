param([Parameter(Mandatory=$true)][string]$Payload)
$ErrorActionPreference = 'Stop'
$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
$appId = if ($env:CHATS_NOTIFICATION_APP_ID) { $env:CHATS_NOTIFICATION_APP_ID } else { 'AgentRelay.ChatsDashboard.Notifications' }
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Programs')) 'Chats notifications.lnk'

# Unpackaged desktop toasts require a Start-menu AUMID and a stub activation
# CLSID. A dedicated signed protocol focuses the existing chat, never runs commands.
if (!(Test-Path -LiteralPath $shortcutPath)) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $shortcut.Arguments = '"' + (Join-Path (Split-Path $PSScriptRoot) 'start-hidden.vbs') + '" --open'
  $shortcut.WorkingDirectory = Split-Path $PSScriptRoot
  $shortcut.IconLocation = (Join-Path (Split-Path $PSScriptRoot) 'chats.ico') + ',0'
  $shortcut.Save()
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ChatsShortcut {
  [StructLayout(LayoutKind.Sequential)] public struct Key { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit, Size=24)] public struct Value {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr ptr;
  }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface Store {
    void GetCount(out uint count); void GetAt(uint index, out Key key);
    void GetValue(ref Key key, out Value value); void SetValue(ref Key key, ref Value value); void Commit();
  }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
  static extern void SHGetPropertyStoreFromParsingName(string path, IntPtr context, uint flags, ref Guid iid, out Store store);
  public static void Register(string path, string appId) {
    Guid iid = typeof(Store).GUID; Store store;
    SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, 2, ref iid, out store);
    var key = new Key { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid=5 };
    var value = new Value { vt=31, ptr=Marshal.StringToCoTaskMemUni(appId) };
    try { store.SetValue(ref key, ref value); }
    finally { Marshal.FreeCoTaskMem(value.ptr); }
    key.pid=26;
    value = new Value { vt=72, ptr=Marshal.AllocCoTaskMem(16) };
    Marshal.StructureToPtr(new Guid("99FA5E10-FB4D-4AD5-97F5-088B50F059CF"), value.ptr, false);
    try { store.SetValue(ref key, ref value); store.Commit(); }
    finally { Marshal.FreeCoTaskMem(value.ptr); Marshal.ReleaseComObject(store); }
  }
}
'@
  [ChatsShortcut]::Register($shortcutPath, $appId)
}
# Register a separate protocol; preserve the existing chats-dashboard:start handler.
$protocol = 'HKCU:\Software\Classes\chats-dashboard-toast'
$handler = Join-Path (Split-Path $PSScriptRoot) 'notification-click.vbs'
$command = '"' + (Join-Path $env:WINDIR 'System32\wscript.exe') + '" "' + $handler + '" "%1"'
if (!(Test-Path -LiteralPath ($protocol + '\shell\open\command'))) {
  New-Item -Path ($protocol + '\shell\open\command') -Force | Out-Null
}
Set-ItemProperty -LiteralPath $protocol -Name '(default)' -Value 'URL:Chats notification'
Set-ItemProperty -LiteralPath $protocol -Name 'URL Protocol' -Value ''
Set-ItemProperty -LiteralPath ($protocol + '\shell\open\command') -Name '(default)' -Value $command
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
[Windows.UI.Notifications.ToastNotifier, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
[Windows.UI.Notifications.NotificationSetting, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] > $null
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
$setting = [string]$notifier.Setting
if (!$setting) { $setting = 'Unknown' }
if ($setting -notin @('Enabled', 'Unknown')) { throw ('Windows notifications: ' + $setting) }
$tag = ''
if ($data.title) {
  $url = [Uri]$data.url
  $local = $url.Scheme -eq 'http' -and $url.Host -eq '127.0.0.1'
  $chat = $url.AbsoluteUri -match '^chats-dashboard-toast:[0-9]{1,5}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}$'
  # The weekly Relay Evals report: a local HTML file in a dated reports folder.
  $report = $url.Scheme -eq 'file' -and $url.IsLoopback -and $url.LocalPath -match '\\relay-evals\\reports\\\d{4}-\d{2}-\d{2}\\report\.html$'
  if (!$local -and !$chat -and !$report) { throw 'Only a local dashboard, signed chat or Evals report link can be opened' }
  $esc = [Security.SecurityElement]
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml('<toast activationType="protocol" launch="' + $esc::Escape($url.AbsoluteUri) + '"><visual><binding template="ToastGeneric"><text>' + $esc::Escape([string]$data.title) + '</text><text>' + $esc::Escape([string]$data.text) + '</text></binding></visual></toast>')
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  $tag = [Guid]::NewGuid().ToString('N').Substring(0,16)
  $toast.Tag = $tag
  $toast.Group = 'chats'
  $toast.ExpirationTime = [DateTimeOffset]::Now.AddHours(4)
  $notifier.Show($toast)
}
[Windows.UI.Notifications.ToastNotificationHistory, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
$accepted = $false
if ($tag) {
  for ($attempt=0; $attempt -lt 3; $attempt++) {
    $accepted = @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($appId) | Where-Object { $_.Tag -eq $tag }).Count -gt 0
    if ($accepted) { break }
    Start-Sleep -Milliseconds 200
  }
}
@{ setting=$setting; tag=$tag; appId=$appId; accepted=$accepted } | ConvertTo-Json -Compress
