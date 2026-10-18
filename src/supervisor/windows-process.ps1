param(
  [ValidateSet('Run', 'Drain', 'Stop')][string]$Mode,
  [string]$RunDir, [string]$JobName, [int]$RunnerPid, [string]$CreationTime
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class SupervisorProcess {
  const uint QUERY = 0x1000, TERMINATE = 1, SYNCHRONIZE = 0x100000, DUP_HANDLE = 0x40;
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref Limits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting info, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr from, IntPtr handle, IntPtr to, out IntPtr duplicate, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string name, uint access, uint share, ref Security attributes, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long processTime, jobTime; public uint flags; public UIntPtr minWorking, maxWorking; public uint activeLimit; public UIntPtr affinity; public uint priority, scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct Limits { public BasicLimits basic; public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; public UIntPtr processMemory, jobMemory, peakProcess, peakJob; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long userTime, kernelTime, periodUser, periodKernel; public uint faults, total, active, terminated; }
  [StructLayout(LayoutKind.Sequential)] struct Security { public int size; public IntPtr descriptor; public int inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup { public int size; public string reserved, desktop, title; public uint x, y, width, height, charsX, charsY, fill, flags; public short show, reservedBytes; public IntPtr reservedPointer, input, output, error; }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }

  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static long Created(IntPtr process) { long creation, exit, kernel, user; Check(GetProcessTimes(process, out creation, out exit, out kernel, out user)); return creation; }
  static IntPtr Job(string name) {
    IntPtr job = OpenJobObject(0x0008 | 0x0004, false, name);
    if (job == IntPtr.Zero && Marshal.GetLastWin32Error() != 2) throw new Win32Exception(Marshal.GetLastWin32Error());
    return job;
  }
  static void Empty(IntPtr job) {
    Check(TerminateJobObject(job, 1));
    for (int i = 0; i < 1000; i++) {
      Accounting info;
      Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
      if (info.active == 0) return;
      Thread.Sleep(10);
    }
    throw new TimeoutException("Job did not stop");
  }
  public static string Drain(string name) {
    IntPtr job = Job(name);
    if (job == IntPtr.Zero) return "stop-failed";
    try { Empty(job); return "stopped"; } finally { CloseHandle(job); }
  }
  public static string Stop(string name, int pid, string expected) {
    IntPtr process = OpenProcess(QUERY | TERMINATE | SYNCHRONIZE, false, pid);
    if (process == IntPtr.Zero && Marshal.GetLastWin32Error() != 87) return "ownership-unavailable";
    IntPtr job = IntPtr.Zero;
    try {
      if (process != IntPtr.Zero && Created(process).ToString() != expected) return "identity-mismatch";
      job = Job(name);
      if (process != IntPtr.Zero && WaitForSingleObject(process, 0) != 0) {
        if (job == IntPtr.Zero) return "ownership-unavailable";
        Check(TerminateProcess(process, 1));
        if (WaitForSingleObject(process, 10000) != 0) return "stop-failed";
      }
      if (job != IntPtr.Zero) Empty(job);
      return process == IntPtr.Zero ? "not-running" : "stopped";
    } finally { if (job != IntPtr.Zero) CloseHandle(job); if (process != IntPtr.Zero) CloseHandle(process); }
  }
  static void Attach(string name, int parentPid, string expected) {
    IntPtr parent = OpenProcess(QUERY | DUP_HANDLE, false, parentPid);
    if (parent == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    IntPtr job = IntPtr.Zero;
    try {
      long creation = Created(parent);
      if (creation.ToString() != expected) throw new InvalidOperationException("Runner process identity changed");
      job = CreateJobObject(IntPtr.Zero, name);
      int error = Marshal.GetLastWin32Error();
      if (job == IntPtr.Zero || error == 183) throw new Win32Exception(error);
      Limits limits = new Limits();
      limits.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE; neither breakaway flag is permitted.
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(Limits))));
      IntPtr owned;
      Check(DuplicateHandle(GetCurrentProcess(), job, parent, out owned, 0, false, 2));
      Check(AssignProcessToJobObject(job, GetCurrentProcess()));
      CloseHandle(job); job = IntPtr.Zero;
      Console.WriteLine("{\"ready\":true,\"creationTime\":\"" + creation + "\"}");
      Console.Out.Flush();
    } finally { if (job != IntPtr.Zero) CloseHandle(job); CloseHandle(parent); }
  }
  static string Quote(string arg) {
    StringBuilder text = new StringBuilder("\""); int slashes = 0;
    foreach (char c in arg) {
      if (c == '\\') { slashes++; continue; }
      text.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); text.Append(c); slashes = 0;
    }
    text.Append('\\', slashes * 2); return text.Append('"').ToString();
  }
  static IntPtr FileHandle(string path, bool input) {
    Security attributes = new Security { size = Marshal.SizeOf(typeof(Security)), inherit = 1 };
    IntPtr handle = CreateFile(path, input ? 0x80000000u : 0x40000000u, 7, ref attributes, input ? 3u : 2u, 0x80, IntPtr.Zero);
    if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return handle;
  }
  public static void Run(string name, int parentPid, string expected, string directory, string cwd, string[] argv, uint timeout) {
    Attach(name, parentPid, expected);
    IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
    IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero;
    ProcessInfo child = new ProcessInfo();
    try {
      input = FileHandle(Path.Combine(directory, "prompt.txt"), true);
      output = FileHandle(Path.Combine(directory, "stdout.json"), false);
      error = FileHandle(Path.Combine(directory, "stderr.log"), false);
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      attributes = Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size));
      handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
      Marshal.WriteIntPtr(handles, 0, input);
      Marshal.WriteIntPtr(handles, IntPtr.Size, output);
      Marshal.WriteIntPtr(handles, IntPtr.Size * 2, error);
      Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
      StartupEx startup = new StartupEx { startup = new Startup { size = Marshal.SizeOf(typeof(StartupEx)),
        flags = 0x100, input = input, output = output, error = error }, attributes = attributes };
      StringBuilder command = new StringBuilder();
      foreach (string arg in argv) { if (command.Length > 0) command.Append(' '); command.Append(Quote(arg)); }
      Check(CreateProcess(null, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080000, IntPtr.Zero, cwd, ref startup, out child));
      uint waited = WaitForSingleObject(child.process, timeout);
      if (waited != 0 && waited != 258) throw new Win32Exception(Marshal.GetLastWin32Error());
      uint code; Check(GetExitCodeProcess(child.process, out code));
      Console.WriteLine("{\"outcome\":{\"exitCode\":" + code + ",\"timedOut\":" + (waited == 258 ? "true" : "false") + "}}");
    } finally {
      if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
      if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
      if (child.thread != IntPtr.Zero) CloseHandle(child.thread);
      if (child.process != IntPtr.Zero) CloseHandle(child.process);
      if (input != IntPtr.Zero) CloseHandle(input);
      if (output != IntPtr.Zero) CloseHandle(output);
      if (error != IntPtr.Zero) CloseHandle(error);
    }
  }
}
'@
try {
  switch ($Mode) {
    'Run' {
      $spec = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $RunDir 'spec.json') | ConvertFrom-Json
      [SupervisorProcess]::Run($JobName, $RunnerPid, $CreationTime, $RunDir, $spec.cwd, [string[]]$spec.argv, [uint32]$spec.timeoutMs)
    }
    'Drain' { [SupervisorProcess]::Drain($JobName) }
    'Stop' { [SupervisorProcess]::Stop($JobName, $RunnerPid, $CreationTime) }
  }
} catch { exit 1 }
