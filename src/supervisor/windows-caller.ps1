param(
  [string]$ClientAddress, [int]$ClientPort, [string]$ServerAddress, [int]$ServerPort,
  [string]$Jobs = '', [string]$Runners = ''
)
# The dashboard's caller lookup (local-admission.mjs checkCaller, caller-lookup.mjs). It names the process at the client
# end of one IPv4 loopback connection, by the whole endpoint tuple, then its parent chain and which of the named job
# objects (AIWorks's open runs) it or a process above it is in. It prints one JSON line or exits 1: it never guesses.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;

public static class CallerLookup {
  const uint LIMITED = 0x1000, JOB_QUERY = 0x0004, STILL_ACTIVE = 259;
  const int ESTABLISHED = 5, ROW = 160, MAX_DEPTH = 64;
  [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int kind, uint reserved);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int kind, ref Basic info, int size, out int returned);
  [StructLayout(LayoutKind.Sequential)] struct Basic { public IntPtr exitStatus, peb, affinity, priority, pid, parent; }
  struct Row { public int state, pid; public long created; }

  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static long Created(IntPtr process) { long creation, exit, kernel, user; Check(GetProcessTimes(process, out creation, out exit, out kernel, out user)); return creation; }
  static uint Address(string text) {
    IPAddress address = IPAddress.Parse(text);
    byte[] bytes = address.GetAddressBytes();
    if (address.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork || bytes[0] != 127) throw new InvalidOperationException("not IPv4 loopback");
    return BitConverter.ToUInt32(bytes, 0);
  }
  static int Port(IntPtr row, int offset) { return (Marshal.ReadByte(row, offset) << 8) | Marshal.ReadByte(row, offset + 1); }

  // The one TCP row whose local end is the client's endpoint and whose remote end is the dashboard's: the client's side
  // of this exact connection, with its owner and the time its socket was created (TCP_TABLE_OWNER_MODULE_ALL, IPv4).
  static Row Find(uint clientAddress, int clientPort, uint serverAddress, int serverPort) {
    int size = 0;
    IntPtr table = IntPtr.Zero;
    try {
      for (int attempt = 0; ; attempt++) {
        uint status = GetExtendedTcpTable(table, ref size, false, 2, 8, 0);
        if (status == 0) break;
        if (status != 122 || attempt > 4) throw new Win32Exception((int)status);
        if (table != IntPtr.Zero) Marshal.FreeHGlobal(table);
        table = Marshal.AllocHGlobal(size);
      }
      int count = Marshal.ReadInt32(table), found = 0;
      Row match = new Row();
      for (int i = 0; i < count; i++) {
        IntPtr row = new IntPtr(table.ToInt64() + 8 + (long)i * ROW);
        if ((uint)Marshal.ReadInt32(row, 4) != clientAddress || Port(row, 8) != clientPort
            || (uint)Marshal.ReadInt32(row, 12) != serverAddress || Port(row, 16) != serverPort) continue;
        found++;
        match = new Row { state = Marshal.ReadInt32(row, 0), pid = Marshal.ReadInt32(row, 20), created = Marshal.ReadInt64(row, 24) };
      }
      if (found != 1) throw new InvalidOperationException(found == 0 ? "no such connection" : "ambiguous connection");
      if (match.state != ESTABLISHED || match.pid <= 0 || match.created <= 0) throw new InvalidOperationException("connection not established");
      return match;
    } finally { if (table != IntPtr.Zero) Marshal.FreeHGlobal(table); }
  }
  static bool Running(IntPtr process) { uint code; Check(GetExitCodeProcess(process, out code)); return code == STILL_ACTIVE; }
  static int Parent(IntPtr process) {
    Basic info = new Basic(); int returned;
    int status = NtQueryInformationProcess(process, 0, ref info, Marshal.SizeOf(typeof(Basic)), out returned);
    if (status != 0) throw new Win32Exception("parent unavailable");
    return (int)info.parent.ToInt64();
  }
  // An open process handle, or zero when no process has that pid now. A process that exists but cannot be opened throws.
  static IntPtr Open(int pid) {
    IntPtr process = OpenProcess(LIMITED, false, pid);
    if (process == IntPtr.Zero && Marshal.GetLastWin32Error() != 87) throw new Win32Exception(Marshal.GetLastWin32Error());
    return process;
  }

  public static string Lookup(string clientText, int clientPort, string serverText, int serverPort, string[] jobs, string[] runners) {
    uint client = Address(clientText), server = Address(serverText);
    List<IntPtr> held = new List<IntPtr>();
    try {
      Row row = Find(client, clientPort, server, serverPort);
      IntPtr caller = Open(row.pid);
      if (caller == IntPtr.Zero) throw new InvalidOperationException("caller exited");
      held.Add(caller);
      // The handle now pins the pid. A process created after the socket is not its owner (the pid was reused), and the
      // same tuple must still name the same owner and socket while the handle is held.
      long callerCreated = Created(caller);
      if (!Running(caller) || callerCreated > row.created) throw new InvalidOperationException("caller identity changed");
      Row again = Find(client, clientPort, server, serverPort);
      if (again.pid != row.pid || again.created != row.created) throw new InvalidOperationException("connection changed");

      // The parent chain, each process held open. A parent created after its child is a reused pid: the real parent has
      // exited and the chain ends there (an AIWorks run's descendants are still named by its job).
      List<int> ancestors = new List<int>();
      IntPtr current = caller; long currentCreated = callerCreated;
      for (int depth = 0; ; depth++) {
        if (depth >= MAX_DEPTH) throw new InvalidOperationException("ancestry too deep");
        int parentPid = Parent(current);
        if (parentPid <= 0) break;
        IntPtr parent = Open(parentPid);
        if (parent == IntPtr.Zero) break;
        held.Add(parent);
        long parentCreated = Created(parent);
        if (parentCreated > currentCreated) break;
        ancestors.Add(parentPid);
        current = parent; currentCreated = parentCreated;
      }

      List<string> member = new List<string>();
      for (int i = 0; i < jobs.Length; i++) {
        IntPtr job = OpenJobObject(JOB_QUERY, false, jobs[i]);
        if (job == IntPtr.Zero) {
          int error = Marshal.GetLastWin32Error();
          if (error != 2) throw new Win32Exception(error);
          // No job by that name, yet its runner is still alive: this process cannot see the job, so it cannot tell.
          if (RunnerAlive(runners[i])) throw new InvalidOperationException("job not visible");
          continue;
        }
        try {
          foreach (IntPtr process in held) {
            bool inside; Check(IsProcessInJob(process, job, out inside));
            if (inside) { member.Add(jobs[i]); break; }
          }
        } finally { CloseHandle(job); }
      }

      StringBuilder json = new StringBuilder("{\"pid\":" + row.pid + ",\"ancestors\":[");
      for (int i = 0; i < ancestors.Count; i++) json.Append(i > 0 ? "," : "").Append(ancestors[i]);
      json.Append("],\"jobs\":[");
      for (int i = 0; i < member.Count; i++) json.Append(i > 0 ? "," : "").Append("\"" + member[i].Replace("\\", "\\\\") + "\"");
      return json.Append("]}").ToString();
    } finally { foreach (IntPtr process in held) CloseHandle(process); }
  }
  // "pid:creationTime" of the runner that holds the job's only handle; an unknown identity counts as alive.
  static bool RunnerAlive(string identity) {
    string[] parts = (identity ?? "").Split(':');
    int pid; long expected;
    if (parts.Length != 2 || !int.TryParse(parts[0], out pid) || !long.TryParse(parts[1], out expected) || pid <= 0) return true;
    IntPtr process = Open(pid);
    if (process == IntPtr.Zero) return false;
    try { return Created(process) == expected && Running(process); } finally { CloseHandle(process); }
  }
}
'@
try {
  $jobList = [string[]]@($Jobs -split '\|' | Where-Object { $_ })
  $runnerList = [string[]]@($Runners -split '\|' | Where-Object { $_ })
  if ($jobList.Count -ne $runnerList.Count) { exit 1 }
  [CallerLookup]::Lookup($ClientAddress, $ClientPort, $ServerAddress, $ServerPort, $jobList, $runnerList)
} catch { exit 1 }
