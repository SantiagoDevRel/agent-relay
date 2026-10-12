# Presses Ctrl+C in the console of one process, the way User would in its
# terminal tab, so Claude Code or Codex quits normally (and Claude records a clean
# exit). It writes key presses to that console's input; it does not kill anything.
# Input in environment variables, never as code: CHATS_CLOSE_PID, CHATS_CLOSE_PRESSES.
# Prints one JSON line: { attached, sent }.
$ErrorActionPreference = 'Stop'
Add-Type -Namespace ChatsDashboard -Name Console -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct KEY_EVENT_RECORD {
  public int bKeyDown; public ushort wRepeatCount; public ushort wVirtualKeyCode;
  public ushort wVirtualScanCode; public char UnicodeChar; public uint dwControlKeyState;
}
[StructLayout(LayoutKind.Explicit)]
public struct INPUT_RECORD {
  [FieldOffset(0)] public ushort EventType;
  [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
}
[DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
static extern bool WriteConsoleInput(IntPtr handle, INPUT_RECORD[] records, uint count, out uint written);
[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

static INPUT_RECORD Key(bool down) {
  var r = new INPUT_RECORD();
  r.EventType = 1; // KEY_EVENT
  r.KeyEvent.bKeyDown = down ? 1 : 0;
  r.KeyEvent.wRepeatCount = 1;
  r.KeyEvent.wVirtualKeyCode = 0x43; // C
  r.KeyEvent.wVirtualScanCode = 0x2E;
  r.KeyEvent.UnicodeChar = (char)3;
  r.KeyEvent.dwControlKeyState = 0x0008; // LEFT_CTRL_PRESSED
  return r;
}

// Returns how many Ctrl+C presses reached the console, or -1 if it could not attach.
public static int Press(uint pid, int presses, int gapMs) {
  FreeConsole();
  if (!AttachConsole(pid)) return -1;
  IntPtr input = CreateFile("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
  if (input == new IntPtr(-1)) { FreeConsole(); return -1; }
  int sent = 0;
  try {
    for (int i = 0; i < presses; i++) {
      if (i > 0) System.Threading.Thread.Sleep(gapMs);
      uint written;
      if (WriteConsoleInput(input, new[] { Key(true), Key(false) }, 2, out written) && written == 2) sent++;
    }
  } finally {
    CloseHandle(input);
    FreeConsole();
  }
  return sent;
}
'@

$target = [uint32]$env:CHATS_CLOSE_PID
$presses = [Math]::Max(1, [Math]::Min(4, [int]$env:CHATS_CLOSE_PRESSES))
$sent = [ChatsDashboard.Console]::Press($target, $presses, 350)
@{ attached = ($sent -ge 0); sent = [Math]::Max(0, $sent) } | ConvertTo-Json -Compress
