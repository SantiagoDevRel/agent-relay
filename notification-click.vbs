' A dedicated toast protocol. Reject all input except the signed data-only URI.
If WScript.Arguments.Count <> 1 Then WScript.Quit 1
uri = WScript.Arguments(0)
Set pattern = New RegExp
pattern.Pattern = "^chats-dashboard-toast:[0-9]{1,5}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}$"
pattern.IgnoreCase = True
If Not pattern.Test(uri) Then WScript.Quit 1
Set sh = CreateObject("WScript.Shell")
root = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "node """ & root & "\server\notification-click.mjs"" """ & uri & """", 0, False
