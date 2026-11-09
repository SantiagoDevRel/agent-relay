$ErrorActionPreference = 'Stop'
Add-Type -Namespace AgentRelay -Name Input -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct KEY_EVENT_RECORD {
 public int bKeyDown; public ushort wRepeatCount; public ushort wVirtualKeyCode;
 public ushort wVirtualScanCode; public char UnicodeChar; public uint dwControlKeyState;
}
[StructLayout(LayoutKind.Explicit)] public struct INPUT_RECORD {
 [FieldOffset(0)] public ushort EventType;
 [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
}
[DllImport("kernel32.dll")] static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
[DllImport("kernel32.dll", SetLastError=true)] static extern uint GetConsoleProcessList(uint[] list, uint count);
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sec, uint creation, uint flags, IntPtr template);
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool WriteConsoleInput(IntPtr handle, INPUT_RECORD[] records, uint count, out uint written);
[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
[StructLayout(LayoutKind.Sequential)] public struct COORD { public short X,Y; }
[StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short L,T,R,B; }
[StructLayout(LayoutKind.Sequential)] public struct INFO { public COORD Size,Cursor; public short Attr; public SMALL_RECT Window; public COORD Max; }
[DllImport("kernel32.dll")] static extern bool GetConsoleScreenBufferInfo(IntPtr h,out INFO info);
[DllImport("kernel32.dll",CharSet=CharSet.Unicode,EntryPoint="ReadConsoleOutputCharacterW",ExactSpelling=true)] static extern bool ReadConsoleOutputCharacter(IntPtr h,[Out] char[] text,uint length,COORD start,out uint read);
// Composer state: null = empty (safe to type), otherwise the refusal reason.
// The console API exposes characters and legacy attributes only. Measured on
// 2026-11-08 (conhost and Windows Terminal 1.24 OpenConsole): SGR 2 (dim) leaves
// the attribute word unchanged, so a dim placeholder such as Claude's
// `Try "..."` cannot be told apart from a typed draft. Any visible text other
// than the literal Codex placeholder is therefore a draft.
static string ComposerRefusal() {
 var h=CreateFile("CONOUT$",0x80000000,3,IntPtr.Zero,3,0,IntPtr.Zero);
 if(h==new IntPtr(-1))return "no-composer";
 try { INFO info; if(!GetConsoleScreenBufferInfo(h,out info))return "no-composer";
  var text=new System.Text.StringBuilder();
  for(int y=Math.Max(0,info.Cursor.Y-12);y<=info.Cursor.Y;y++){
   char[] line=new char[info.Size.X]; uint n;
   if(!ReadConsoleOutputCharacter(h,line,(uint)line.Length,new COORD{X=0,Y=(short)y},out n))return "no-composer";
   text.AppendLine(new string(line,0,(int)n).TrimEnd('\0',' '));
  }
  string value=text.ToString();
  // Claude draws U+276F, older Codex U+00BB, Codex 0.161+ U+203A.
  int at=Math.Max(Math.Max(value.LastIndexOf('\u276f'),value.LastIndexOf('\u00bb')),value.LastIndexOf('\u203a'));
  if(at<0)return "no-composer";
  string draft=value.Substring(at+1).Trim();
  return draft.Length==0 || draft=="Ask Codex to do anything" ? null : "draft";
 }finally{CloseHandle(h);}
}
// Written only when nothing has been typed: the caller may report "Not sent".
public static string NotSent(string reason) {
 return "{\"submitted\":false,\"notSent\":true,\"reason\":\""+reason+"\"}";
}
static bool SameProcess(uint pid, long startedTicks, string image) {
 try {
  var p=System.Diagnostics.Process.GetProcessById((int)pid);
  return !p.HasExited && p.StartTime.ToFileTimeUtc()==startedTicks && p.ProcessName==image;
 } catch(Exception) { return false; }
}
static INPUT_RECORD Key(char c, bool down) {
 var r=new INPUT_RECORD(); r.EventType=1; r.KeyEvent.bKeyDown=down?1:0;
 r.KeyEvent.wRepeatCount=1; r.KeyEvent.UnicodeChar=c;
 r.KeyEvent.wVirtualKeyCode=c=='\r'?(ushort)13:(ushort)0;
 r.KeyEvent.wVirtualScanCode=c=='\r'?(ushort)28:(ushort)0;
 return r;
}
public static string Send(uint pid, string text, long startedTicks, string image) {
 if(text.Length==0 || text.Length>2000) throw new Exception("Invalid length");
 foreach(char c in text) if(c<32 || c>126) throw new Exception("ASCII single-line text required");
 // Every refusal below returns before the first WriteConsoleInput: nothing typed.
 if(!SameProcess(pid,startedTicks,image)) return NotSent("identity");
 FreeConsole();
 if(!AttachConsole(pid)) return NotSent("identity");
 IntPtr input=IntPtr.Zero;
 try {
  uint[] list=new uint[64]; uint n=GetConsoleProcessList(list,64);
  if(n==0 || n>64 || Array.IndexOf(list,pid)<0) return NotSent("identity");
  uint self=(uint)System.Diagnostics.Process.GetCurrentProcess().Id;
  for(int i=0;i<n;i++) {
   uint id=list[i];
   if(id==0 || id==pid || id==self) continue;
   string name;
   try { name=System.Diagnostics.Process.GetProcessById((int)id).ProcessName; } catch(Exception) { return NotSent("identity"); }
   if(name=="codex" || name=="claude") return NotSent("identity");
  }
  if(!SameProcess(pid,startedTicks,image)) return NotSent("identity");
  if(image=="codex" || image=="claude") { string refusal=ComposerRefusal(); if(refusal!=null) return NotSent(refusal); }
  input=CreateFile("CONIN$",0xC0000000,3,IntPtr.Zero,3,0,IntPtr.Zero);
  if(input==new IntPtr(-1)) return NotSent("no-composer");
  var records=new INPUT_RECORD[text.Length*2];
  for(int i=0;i<text.Length;i++){ records[2*i]=Key(text[i],true); records[2*i+1]=Key(text[i],false); }
  uint written;
  if(records.Length>0 && (!WriteConsoleInput(input,records,(uint)records.Length,out written) || written!=records.Length)) throw new Exception("Partial input; do not retry automatically");
  System.Threading.Thread.Sleep(1600);
  if(!WriteConsoleInput(input,new[]{Key('\r',true),Key('\r',false)},2,out written) || written!=2) throw new Exception("Enter failed; do not retry automatically");
  return "{\"submitted\":true,\"characters\":"+text.Length+"}";
 } finally { if(input!=IntPtr.Zero && input!=new IntPtr(-1)) CloseHandle(input); FreeConsole(); }
}
'@
$spec=Get-Content -LiteralPath $env:AGENT_RELAY_INPUT_FILE -Raw -Encoding utf8 | ConvertFrom-Json
$target=Get-Process -Id ([int]$spec.pid) -ErrorAction SilentlyContinue
if(-not $target -or $target.ProcessName -ne $spec.image) { $receipt=[AgentRelay.Input]::NotSent('identity') }
else { $receipt=[AgentRelay.Input]::Send([uint32]$spec.pid,[string]$spec.text,[long]$spec.startedTicks,[string]$spec.image) }
if($spec.receipt) { [System.IO.File]::WriteAllText([string]$spec.receipt,$receipt) }
$receipt
