param(
  [Parameter(Mandatory=$true)][int]$HostProcessId,
  [switch]$Probe,
  [string]$EvidenceDirectory
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @'
using System;
using System.Text;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class DshDesktopIcons {
  public delegate bool WindowCallback(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Identifier { public uint cbSize; public IntPtr hWnd; public uint uID; public Guid guidItem; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct NotifyData {
    public uint cbSize; public IntPtr hWnd; public uint uID, uFlags, uCallbackMessage; public IntPtr hIcon;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string szTip;
    public uint dwState, dwStateMask;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string szInfo;
    public uint uTimeoutOrVersion;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string szInfoTitle;
    public uint dwInfoFlags; public Guid guidItem; public IntPtr hBalloonIcon;
  }
  [DllImport("user32.dll")] public static extern bool EnumWindows(WindowCallback callback, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder text, int n);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetSystemMetricsForDpi(int index, uint dpi);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr h, uint message, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr LoadImage(IntPtr instance, string name, uint type, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
  public static bool OwnedWindow(IntPtr h, uint process, string kind) { uint owner; GetWindowThreadProcessId(h,out owner); return owner == process && Class(h) == kind; }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern bool Shell_NotifyIcon(uint message, ref NotifyData data);
  [DllImport("shell32.dll")] static extern int Shell_NotifyIconGetRect(ref Identifier id, out Rect rect);
  public static IntPtr Message(IntPtr h, uint message, int kind, IntPtr icon) {
    IntPtr result;
    if (SendMessageTimeout(h, message, (IntPtr)kind, icon, 2, 1000, out result) == IntPtr.Zero)
      throw new InvalidOperationException("DSH window did not answer icon message");
    return result;
  }
  public static string Class(IntPtr h) { var text = new StringBuilder(256); GetClassName(h,text,text.Capacity); return text.ToString(); }
  public static IntPtr[] Windows(uint process) {
    var result = new System.Collections.Generic.List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr p) { uint owner; GetWindowThreadProcessId(h,out owner); if(owner == process) result.Add(h); return true; }, IntPtr.Zero);
    return result.ToArray();
  }
  public static Rect TrayRect(IntPtr h) {
    var id = new Identifier { cbSize=(uint)Marshal.SizeOf(typeof(Identifier)), hWnd=h, uID=3, guidItem=Guid.Empty };
    Rect rect; int code=Shell_NotifyIconGetRect(ref id,out rect);
    if(code != 0) throw new InvalidOperationException("DSH tray uID 3 not found: " + code);
    return rect;
  }
  public static bool SetTray(IntPtr h, IntPtr icon) {
    var data = new NotifyData { cbSize=(uint)Marshal.SizeOf(typeof(NotifyData)),hWnd=h,uID=3,uFlags=2,hIcon=icon };
    return Shell_NotifyIcon(1,ref data);
  }
  public static IntPtr Circle(int size) {
    using(var bitmap=new Bitmap(size,size,PixelFormat.Format32bppArgb)) {
      using(var graphics=Graphics.FromImage(bitmap)) {
        graphics.Clear(Color.Transparent); graphics.SmoothingMode=SmoothingMode.AntiAlias;
        using(var brush=new SolidBrush(Color.FromArgb(0x1e,0x3a,0x8a))) graphics.FillEllipse(brush,0.5f,0.5f,size-1,size-1);
      }
      return bitmap.GetHicon();
    }
  }
  public static System.Threading.Tasks.Task<string> StopSignal() { return System.Threading.Tasks.Task.Run(() => Console.ReadLine()); }
  public static void Screenshot(string path, int left, int top, int width, int height) {
    using(var bitmap=new Bitmap(width,height)) {
      using(var graphics=Graphics.FromImage(bitmap)) graphics.CopyFromScreen(left,top,0,0,new Size(width,height));
      bitmap.Save(path,ImageFormat.Png);
    }
  }
}
'@ -ReferencedAssemblies System.Drawing

# Resolve only the supplied Host and its direct Electron parent; never scan unrelated processes.
$hostInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$HostProcessId"
if (-not $hostInfo -or $hostInfo.CommandLine -notmatch '[\\/]@deepseek-ai[\\/]dsh-desktop-host[\\/]lib[\\/]index[.]js') {
  throw 'Desktop icons require the DSH desktop Host process'
}
$electronId = [int]$hostInfo.ParentProcessId
$electron = Get-CimInstance Win32_Process -Filter "ProcessId=$electronId"
if (-not $electron -or [IO.Path]::GetFileName($electron.ExecutablePath) -cne 'DeepSeek Harness.exe' -or
    $electron.ExecutablePath -ine $hostInfo.ExecutablePath -or
    $electron.CommandLine.Trim() -ine ('"' + $electron.ExecutablePath + '"')) {
  throw 'Desktop icons require the exact DSH Electron parent executable'
}
$hostProcess = [Diagnostics.Process]::GetProcessById($HostProcessId)
$hostStarted = $hostProcess.StartTime
$electronProcess = [Diagnostics.Process]::GetProcessById($electronId)
$electronStarted = $electronProcess.StartTime
for ($attempt=0; $attempt -lt 15; $attempt++) {
  $windows = [DshDesktopIcons]::Windows($electronId)
  $mainWindows = @($windows | Where-Object { [DshDesktopIcons]::Class($_) -eq 'Chrome_WidgetWin_1' })
  $trayWindows = @($windows | Where-Object { [DshDesktopIcons]::Class($_) -eq 'Electron_NotifyIconHostWindow' })
  if ($mainWindows.Count -gt 1 -or $trayWindows.Count -gt 1) { throw 'DSH desktop window identity is ambiguous' }
  if ($mainWindows.Count -eq 1 -and $trayWindows.Count -eq 1) { break }
  Start-Sleep -Milliseconds 1000
}
if ($mainWindows.Count -ne 1 -or $trayWindows.Count -ne 1) { throw 'DSH desktop windows did not become ready' }
$main = $mainWindows[0]; $tray = $trayWindows[0]
[DshDesktopIcons]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$trayRect = [DshDesktopIcons]::TrayRect($tray)
$stockTray = Join-Path ([IO.Path]::GetDirectoryName($electron.ExecutablePath)) 'resources/tray.ico'
if (-not (Test-Path -LiteralPath $stockTray -PathType Leaf)) { throw 'Original DSH tray icon is required for rollback' }
$dpi = [DshDesktopIcons]::GetDpiForWindow($main)
$smallSize = [DshDesktopIcons]::GetSystemMetricsForDpi(49,$dpi)
$largeSize = [DshDesktopIcons]::GetSystemMetricsForDpi(11,$dpi)
$small = [IntPtr]::Zero
$large = [IntPtr]::Zero
$originalTray = [IntPtr]::Zero
$originalSmall = [IntPtr]::Zero
$originalLarge = [IntPtr]::Zero
$smallApplied=$false; $largeApplied=$false; $trayApplied=$false
$mutex = [Threading.Mutex]::new($false, "Local\DSH.SessionTop.DesktopIcons.$electronId")
$locked = $false
try {
  try { $locked = $mutex.WaitOne(5000) } catch [Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw 'DSH desktop icon helper is already active' }
  $originalTray = [DshDesktopIcons]::LoadImage([IntPtr]::Zero,$stockTray,1,$smallSize,$smallSize,0x10)
  if ($originalTray -eq [IntPtr]::Zero) { throw 'Could not load original DSH tray icon' }
  $originalSmall = [DshDesktopIcons]::Message($main,0x7f,0,[IntPtr]::Zero)
  $originalLarge = [DshDesktopIcons]::Message($main,0x7f,1,[IntPtr]::Zero)
  $small = [DshDesktopIcons]::Circle($smallSize)
  $large = [DshDesktopIcons]::Circle($largeSize)
  if ($Probe) {
    if (-not $EvidenceDirectory) { throw 'Probe requires an evidence directory' }
    [IO.Directory]::CreateDirectory($EvidenceDirectory) | Out-Null
    [DshDesktopIcons]::Screenshot((Join-Path $EvidenceDirectory 'before-tray.png'),$trayRect.Left-8,$trayRect.Top-8,$trayRect.Right-$trayRect.Left+16,$trayRect.Bottom-$trayRect.Top+16)
    [DshDesktopIcons]::Screenshot((Join-Path $EvidenceDirectory 'before-taskbar.png'),0,([System.Windows.Forms.SystemInformation]::VirtualScreen.Height-100),[System.Windows.Forms.SystemInformation]::VirtualScreen.Width,100)
  }
  [DshDesktopIcons]::Message($main,0x80,0,$small) | Out-Null; $smallApplied=$true
  [DshDesktopIcons]::Message($main,0x80,1,$large) | Out-Null; $largeApplied=$true
  $trayApplied=[DshDesktopIcons]::SetTray($tray,$small)
  if (-not $trayApplied) { throw 'Shell_NotifyIcon NIM_MODIFY refused the DSH tray icon' }
  $readSmall=[DshDesktopIcons]::Message($main,0x7f,0,[IntPtr]::Zero)
  $readLarge=[DshDesktopIcons]::Message($main,0x7f,1,[IntPtr]::Zero)
  if ($readSmall -ne $small -or $readLarge -ne $large) { throw 'DSH window icon native readback differs' }
  $verifiedRect=[DshDesktopIcons]::TrayRect($tray)
  [pscustomobject]@{status='applied';electronPid=$electronId;hostPid=$HostProcessId;executable=$electron.ExecutablePath;mainHwnd=$main.ToInt64();trayHwnd=$tray.ToInt64();trayId=3;dpi=$dpi;smallSize=$smallSize;largeSize=$largeSize;smallIcon=$small.ToInt64();largeIcon=$large.ToInt64();readSmall=$readSmall.ToInt64();readLarge=$readLarge.ToInt64();originalSmall=$originalSmall.ToInt64();originalLarge=$originalLarge.ToInt64();notifyIcon=$trayApplied;trayRect=$verifiedRect} | ConvertTo-Json -Compress
  if ($Probe) {
    Start-Sleep -Milliseconds 800
    [DshDesktopIcons]::Screenshot((Join-Path $EvidenceDirectory 'after-tray.png'),$trayRect.Left-8,$trayRect.Top-8,$trayRect.Right-$trayRect.Left+16,$trayRect.Bottom-$trayRect.Top+16)
    [DshDesktopIcons]::Screenshot((Join-Path $EvidenceDirectory 'after-taskbar.png'),0,([System.Windows.Forms.SystemInformation]::VirtualScreen.Height-100),[System.Windows.Forms.SystemInformation]::VirtualScreen.Width,100)
  } else {
    $stop = [DshDesktopIcons]::StopSignal()
    while (-not $stop.Wait(1000)) {
      $hostProcess.Refresh()
      if ($hostProcess.HasExited -or $hostProcess.StartTime -ne $hostStarted) { break }
    }
  }
} finally {
  try {
    $electronProcess.Refresh()
    $sameElectron = -not $electronProcess.HasExited -and $electronProcess.StartTime -eq $electronStarted
    $ownsSmall=$false; $ownsLarge=$false
    if ($sameElectron -and [DshDesktopIcons]::OwnedWindow($main,$electronId,'Chrome_WidgetWin_1')) {
      $ownsSmall = $smallApplied -and [DshDesktopIcons]::Message($main,0x7f,0,[IntPtr]::Zero) -eq $small
      $ownsLarge = $largeApplied -and [DshDesktopIcons]::Message($main,0x7f,1,[IntPtr]::Zero) -eq $large
      if ($ownsSmall) { [DshDesktopIcons]::Message($main,0x80,0,$originalSmall) | Out-Null }
      if ($ownsLarge) { [DshDesktopIcons]::Message($main,0x80,1,$originalLarge) | Out-Null }
    }
    # Tray exposes no HICON getter. Restore only while our paired window icons still own the update.
    if ($trayApplied -and ($ownsSmall -or $ownsLarge) -and [DshDesktopIcons]::OwnedWindow($tray,$electronId,'Electron_NotifyIconHostWindow')) {
      if (-not [DshDesktopIcons]::SetTray($tray,$originalTray)) { throw 'DSH tray rollback failed' }
    }
    if ($Probe) {
      Start-Sleep -Milliseconds 300
      [DshDesktopIcons]::Screenshot((Join-Path $EvidenceDirectory 'restored-tray.png'),$trayRect.Left-8,$trayRect.Top-8,$trayRect.Right-$trayRect.Left+16,$trayRect.Bottom-$trayRect.Top+16)
    }
    [pscustomobject]@{status='restored';mainHwnd=$main.ToInt64();smallRestored=$ownsSmall;largeRestored=$ownsLarge} | ConvertTo-Json -Compress
  } finally {
    if ($small -ne [IntPtr]::Zero) { [DshDesktopIcons]::DestroyIcon($small) | Out-Null }
    if ($large -ne [IntPtr]::Zero) { [DshDesktopIcons]::DestroyIcon($large) | Out-Null }
    if ($originalTray -ne [IntPtr]::Zero) { [DshDesktopIcons]::DestroyIcon($originalTray) | Out-Null }
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}
