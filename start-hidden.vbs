' Starts the Chats dashboard server without a console window and opens its window.
' Used by the "Chats" Desktop shortcut, the Startup-folder shortcut (with --boot,
' which waits for the network and Windows to settle first) and the
' chats-dashboard: link behind the app's "Encender" button (with --quiet).
' All three are created by setup-windows.ps1.
' If the server is already running it only opens the window. --quiet starts it
' without opening a window (open pages reconnect by themselves).
' Log: %TEMP%\chats-dashboard.log
Set sh = CreateObject("WScript.Shell")
root = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
openFlag = " --open"
If WScript.Arguments.Count > 0 Then
  If WScript.Arguments(0) = "--boot" Then WScript.Sleep 15000
  If WScript.Arguments(0) = "--quiet" Then openFlag = ""
End If
cmd = "cmd /c node --disable-warning=ExperimentalWarning """ & root & "\server\server.mjs""" & openFlag & " >> ""%TEMP%\chats-dashboard.log"" 2>&1"
sh.Run cmd, 0, False
