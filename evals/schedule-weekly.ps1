# Relay Evals weekly task: one Windows Task Scheduler entry, Sundays 20:00.
# Headless (conhost --headless), AC power only, runs as soon as possible after a
# missed start, 2-hour limit, no repetition, no second instance.
#   install | status | run | disable | enable | remove
param([ValidateSet('install','status','run','disable','enable','remove')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$name = 'Agent Relay Evals weekly'
$cli = Join-Path $PSScriptRoot 'cli.mjs'
$node = (Get-Command node.exe).Source
$conhost = Join-Path $env:WINDIR 'System32\conhost.exe'

switch ($Action) {
  'install' {
    $arguments = '--headless "' + $node + '" --no-warnings "' + $cli + '" weekly --trigger weekly'
    $taskAction = New-ScheduledTaskAction -Execute $conhost -Argument $arguments -WorkingDirectory (Split-Path $PSScriptRoot)
    $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '20:00'
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
      -MultipleInstances IgnoreNew -Priority 7
    # New-ScheduledTaskSettingsSet defaults to "start only on AC" and "stop on battery"; keep them explicit.
    $settings.DisallowStartIfOnBatteries = $true
    $settings.StopIfGoingOnBatteries = $true
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $name -Action $taskAction -Trigger $trigger -Settings $settings -Principal $principal `
      -Description 'Builds the Relay Evals weekly report (tools/chats-dashboard/evals). Pause: disable. Delete: remove.' -Force | Out-Null
  }
  'run' { Start-ScheduledTask -TaskName $name }
  'disable' { Disable-ScheduledTask -TaskName $name | Out-Null }
  'enable' { Enable-ScheduledTask -TaskName $name | Out-Null }
  'remove' { Unregister-ScheduledTask -TaskName $name -Confirm:$false }
}
if ($Action -ne 'remove') {
  $task = Get-ScheduledTask -TaskName $name
  $info = Get-ScheduledTaskInfo -TaskName $name
  [ordered]@{
    name = $name; state = [string]$task.State; execute = $task.Actions[0].Execute; arguments = $task.Actions[0].Arguments
    trigger = 'Weekly ' + ($task.Triggers[0].DaysOfWeek) + ' ' + ([datetime]$task.Triggers[0].StartBoundary).ToString('HH:mm')
    repetition = [string]$task.Triggers[0].Repetition.Interval
    acOnly = $task.Settings.DisallowStartIfOnBatteries; stopOnBattery = $task.Settings.StopIfGoingOnBatteries
    startWhenAvailable = $task.Settings.StartWhenAvailable; timeLimit = $task.Settings.ExecutionTimeLimit
    lastRun = $info.LastRunTime; lastResult = $info.LastTaskResult; nextRun = $info.NextRunTime
  } | ConvertTo-Json
}
