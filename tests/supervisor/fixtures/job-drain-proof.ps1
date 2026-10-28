param([string]$Helper, [string]$Node)
$ErrorActionPreference = 'Stop'
# Load the production public Drain entry point; no source extraction or alternate
# implementation. The deliberately absent job starts no process.
$null = . $Helper -Mode Drain -JobName ('Local\aiworks-absent-' + [guid]::NewGuid().ToString())
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
public static class DrainWitness {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static void Check(Type production, string node) {
    MethodInfo drain = production.GetMethod("Drain");
    for (int trial = 0; trial < 12; trial++) {
      string name = "Local\\aiworks-drain-proof-" + Guid.NewGuid().ToString();
      IntPtr job = CreateJobObject(IntPtr.Zero, name);
      Process child = null;
      try {
        if (job == IntPtr.Zero) throw new Exception("synthetic job could not be created");
        child = Process.Start(new ProcessStartInfo(node, "-e \"setInterval(() => {}, 1000)\"") {
          UseShellExecute = false, CreateNoWindow = true });
        IntPtr witness = child.Handle; // retain identity before asking production to drain
        if (!AssignProcessToJobObject(job, witness)) throw new Exception("synthetic child could not join its job");
        Thread.Sleep(100);
        string answer = (string)drain.Invoke(null, new object[] { name });
        uint waited = WaitForSingleObject(witness, 0);
        if (answer != "stopped" || waited != 0)
          throw new Exception("drain returned " + answer + " with child wait " + waited + " in trial " + trial);
      } finally {
        if (job != IntPtr.Zero) { TerminateJobObject(job, 1); CloseHandle(job); }
        if (child != null) { child.WaitForExit(10000); child.Dispose(); }
      }
    }
  }
}
'@
[DrainWitness]::Check([SupervisorProcess], $Node)
Write-Output 'all owned child handles were signaled at drain completion'
