using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class TabShortcutDriver
{
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 2;
    private const int VK_CONTROL = 0x11;
    private const int VK_T = 0x54;
    private const int VK_W = 0x57;
    private const int SW_RESTORE = 9;

    public static int Main(string[] args)
    {
        if (args.Length != 2) return 2;
        int pid = int.Parse(args[0]);
        int key = args[1] == "open" ? VK_T : args[1] == "close" ? VK_W : 0;
        if (key == 0) return 3;
        IntPtr window = FindChromeWindow(pid); if (window == IntPtr.Zero) return 4;
        Focus(window); Key(VK_CONTROL, false); Key(key, false); Key(key, true); Key(VK_CONTROL, true); Thread.Sleep(120);
        return 0;
    }

    private static void Key(int key, bool up)
    {
        INPUT input = new INPUT(); input.type = INPUT_KEYBOARD; input.U.ki.wVk = (ushort)key; input.U.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
        if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new InvalidOperationException("SendInput failed");
    }

    private static void Focus(IntPtr window)
    {
        IntPtr foreground = GetForegroundWindow(); uint foregroundPid; uint targetPid;
        uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out foregroundPid);
        uint targetThread = GetWindowThreadProcessId(window, out targetPid); uint currentThread = GetCurrentThreadId();
        if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, true);
        if (targetThread != 0) AttachThreadInput(currentThread, targetThread, true);
        if (IsIconic(window)) ShowWindow(window, SW_RESTORE);
        BringWindowToTop(window); SetForegroundWindow(window); SetFocus(window);
        if (targetThread != 0) AttachThreadInput(currentThread, targetThread, false);
        if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, false);
        Thread.Sleep(120);
    }

    private static IntPtr FindChromeWindow(int pid)
    {
        IntPtr result = IntPtr.Zero; long largestArea = 0;
        EnumWindows(delegate(IntPtr window, IntPtr parameter)
        {
            if (!IsWindowVisible(window)) return true;
            uint owner; GetWindowThreadProcessId(window, out owner); if (owner != (uint)pid) return true;
            StringBuilder className = new StringBuilder(128); GetClassName(window, className, className.Capacity);
            if (!className.ToString().StartsWith("Chrome_WidgetWin_")) return true;
            RECT rectangle; if (!GetWindowRect(window, out rectangle)) return true;
            long area = Math.Max(0, rectangle.Right - rectangle.Left) * (long)Math.Max(0, rectangle.Bottom - rectangle.Top);
            if (area > largestArea) { largestArea = area; result = window; }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit, Size = 32)] private struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder value, int length);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr SetFocus(IntPtr window);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
}
