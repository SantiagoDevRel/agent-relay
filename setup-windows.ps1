# Creates the Windows entry points of the Chats dashboard. Safe to run again.
#   - Desktop shortcut "Chats" and the Startup-folder shortcut (starts with Windows)
#   - the chats-dashboard: link that the app's "Encender" button opens to start
#     the server; it ignores the link's text, so a web page cannot pass it options
# Everything is per user (HKCU, %APPDATA%): no admin rights needed.
#
#   powershell -ExecutionPolicy Bypass -File setup-windows.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $root 'start-hidden.vbs'
$ico = Join-Path $root 'chats.ico'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$shell = New-Object -ComObject WScript.Shell

function Set-Shortcut([string]$Path, [string]$Arguments, [string]$Description) {
  $link = $shell.CreateShortcut($Path)
  $link.TargetPath = $wscript
  $link.Arguments = ("`"$vbs`" $Arguments").Trim()
  $link.WorkingDirectory = $root
  $link.IconLocation = "$ico,0"
  $link.Description = $Description
  $link.Save()
  "shortcut: $Path"
}

Set-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Chats.lnk') '' 'Live status of your Claude Code and Codex chats'
Set-Shortcut (Join-Path ([Environment]::GetFolderPath('Startup')) 'Chats dashboard.lnk') '--boot' 'Start Agent Relay at Windows login'

$key = 'HKCU:\Software\Classes\chats-dashboard'
if (-not (Test-Path "$key\shell\open\command")) { New-Item -Path "$key\shell\open\command" -Force | Out-Null }
Set-ItemProperty -Path $key -Name '(default)' -Value 'URL:Chats dashboard'
Set-ItemProperty -Path $key -Name 'URL Protocol' -Value ''
Set-ItemProperty -Path "$key\shell\open\command" -Name '(default)' -Value "`"$wscript`" `"$vbs`" --quiet"
"link: chats-dashboard: -> $vbs --quiet"
