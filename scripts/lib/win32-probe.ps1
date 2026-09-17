# =============================================================================
# Win32 helpers for driving/inspecting the desktop pet from outside.
#
# Dot-source this file:
#     . (Join-Path $PSScriptRoot 'lib\win32-probe.ps1')
#
# THIS FILE MUST STAY PURE ASCII.
#   Windows PowerShell 5.1 reads a .ps1 with no BOM as ANSI, so any non-ASCII
#   literal -- a path with Chinese characters, say -- gets mangled at parse time
#   and the script dies with a confusing syntax error. Keeping this file ASCII
#   avoids the whole class of problem: callers pass real paths in as parameters.
# =============================================================================

if (-not ("Win32Probe" -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Win32Probe {
  public delegate bool E(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(E cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }

  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (Title(h) == title) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // How many top-level windows carry this exact title. >1 means duplicate pets.
  public static int CountTitled(string title) {
    int n = 0;
    EnumWindows(delegate(IntPtr h, IntPtr p) { if (Title(h) == title) n++; return true; }, IntPtr.Zero);
    return n;
  }

  // Visible top-level windows with a title, as "hwnd|class|title|WxH|left,top"
  public static List<string> List() {
    List<string> outp = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      string t = Title(h);
      if (t.Length == 0 || !IsWindowVisible(h)) return true;
      RECT r; GetWindowRect(h, out r);
      outp.Add(h.ToString() + "|" + Cls(h) + "|" + t + "|" + (r.Right-r.Left) + "x" + (r.Bottom-r.Top) + "|" + r.Left + "," + r.Top);
      return true;
    }, IntPtr.Zero);
    return outp;
  }

  // Same as List(), but keeps untitled windows too: WPF menus/popups have no title.
  public static List<string> ListAll() {
    List<string> outp = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      RECT r; GetWindowRect(h, out r);
      string t = Title(h);
      if (t.Length == 0 && (r.Right - r.Left) <= 1) return true;
      outp.Add(h.ToString() + "|" + Cls(h) + "|" + (t.Length == 0 ? "(untitled)" : t) + "|" +
                (r.Right-r.Left) + "x" + (r.Bottom-r.Top) + "|" + r.Left + "," + r.Top);
      return true;
    }, IntPtr.Zero);
    return outp;
  }

  public static string Describe(IntPtr h) {
    RECT r; GetWindowRect(h, out r);
    return "#" + h.ToString() + " " + Cls(h) + " '" + Title(h) + "' " + (r.Right-r.Left) + "x" +
           (r.Bottom-r.Top) + " at " + r.Left + "," + r.Top;
  }

  public static IntPtr At(int x, int y) { POINT p; p.X = x; p.Y = y; return WindowFromPoint(p); }

  public static void Move(uint f, uint dx, uint dy) { mouse_event(f, dx, dy, 0, IntPtr.Zero); }
  public static void Wheel(int delta) { mouse_event(0x0800, 0, 0, unchecked((uint)delta), IntPtr.Zero); }
  public static void Click(uint down, uint up) {
    mouse_event(down, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(35);
    mouse_event(up, 0, 0, 0, IntPtr.Zero);
  }

  // Park the cursor on a physical pixel, retrying until it actually sticks.
  // A human using the mouse at the same time will keep stealing it, so this can
  // legitimately fail -- callers must treat that as "inconclusive", not "broken".
  public static bool Park(int x, int y, int tries) {
    POINT p;
    for (int i = 0; i < tries; i++) {
      SetCursorPos(x, y);
      System.Threading.Thread.Sleep(200);
      GetCursorPos(out p);
      if (System.Math.Abs(p.X - x) <= 6 && System.Math.Abs(p.Y - y) <= 6) return true;
    }
    return false;
  }

  public static int CursorX() { POINT p; GetCursorPos(out p); return p.X; }
  public static int CursorY() { POINT p; GetCursorPos(out p); return p.Y; }
  public static string Rect(IntPtr h) { RECT r; GetWindowRect(h, out r); return r.Left + "," + r.Top + " " + (r.Right-r.Left) + "x" + (r.Bottom-r.Top); }
  public static int RectL(IntPtr h) { RECT r; GetWindowRect(h, out r); return r.Left; }
  public static int RectT(IntPtr h) { RECT r; GetWindowRect(h, out r); return r.Top; }
  public static int RectW(IntPtr h) { RECT r; GetWindowRect(h, out r); return r.Right-r.Left; }
  public static int RectH(IntPtr h) { RECT r; GetWindowRect(h, out r); return r.Bottom-r.Top; }
}
"@
}
[void][Win32Probe]::SetProcessDPIAware()
