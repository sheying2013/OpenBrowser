using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class UpperUiJitterDriver
{
    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 2;
    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    private const int VK_CONTROL = 0x11;
    private const int VK_L = 0x4C;
    private const int VK_V = 0x56;
    private const int VK_A = 0x41;
    private const int VK_T = 0x54;
    private const int VK_W = 0x57;
    private const int VK_BACK = 0x08;
    private const int VK_RETURN = 0x0D;
    private const int SW_RESTORE = 9;
    private static volatile bool sampling;
    private static int slaveForegroundSamples;

    [STAThread]
    public static int Main(string[] args)
    {
        if (args.Length != 4) return 2;
        int masterPid = int.Parse(args[0]);
        uint[] slavePids = { uint.Parse(args[1]), uint.Parse(args[2]), uint.Parse(args[3]) };
        IntPtr master = FindChromeWindow(masterPid);
        if (master == IntPtr.Zero) return 3;
        SetClipboard("data:text/html,<title>upper-sync</title><h1>upper-sync</h1>");
        Focus(master);

        sampling = true;
        Thread sampler = new Thread(delegate()
        {
            while (sampling)
            {
                uint pid;
                GetWindowThreadProcessId(GetForegroundWindow(), out pid);
                if (Array.IndexOf(slavePids, pid) >= 0) Interlocked.Increment(ref slaveForegroundSamples);
                Thread.Sleep(2);
            }
        }) { IsBackground = true };
        sampler.Start();

        for (int round = 0; round < 6; round++)
        {
            ClickAddressBar(master);
            Chord(VK_CONTROL, VK_L);
            Chord(VK_CONTROL, VK_V);
            Thread.Sleep(90);
            Chord(VK_CONTROL, VK_A);
            Key(VK_BACK, false); Key(VK_BACK, true);
            Thread.Sleep(90);
        }
        Chord(VK_CONTROL, VK_T); Thread.Sleep(180);
        Chord(VK_CONTROL, VK_T); Thread.Sleep(180);
        Chord(VK_CONTROL, VK_W); Thread.Sleep(180);
        Chord(VK_CONTROL, VK_W); Thread.Sleep(500);
        Chord(VK_CONTROL, VK_L);
        Chord(VK_CONTROL, VK_V);
        Key(VK_RETURN, false); Key(VK_RETURN, true);
        Thread.Sleep(1400);

        sampling = false;
        sampler.Join(500);
        uint finalPid;
        GetWindowThreadProcessId(GetForegroundWindow(), out finalPid);
        Console.WriteLine("MASTER_PID=" + masterPid);
        Console.WriteLine("MASTER_HWND=" + master.ToInt64());
        Console.WriteLine("SLAVE_FOREGROUND_SAMPLES=" + slaveForegroundSamples);
        Console.WriteLine("FINAL_FOREGROUND_PID=" + finalPid);
        return slaveForegroundSamples == 0 ? 0 : 5;
    }

    private static void SetClipboard(string value)
    {
        for (int i = 0; i < 20; i++) { try { Clipboard.SetText(value); return; } catch { Thread.Sleep(50); } }
    }

    private static void ClickAddressBar(IntPtr window)
    {
        RECT rect; if (!GetWindowRect(window, out rect)) return;
        int x = rect.Left + (rect.Right - rect.Left) / 2;
        int y = rect.Top + 52;
        int sx = Math.Max(1, GetSystemMetrics(0) - 1);
        int sy = Math.Max(1, GetSystemMetrics(1) - 1);
        INPUT input = new INPUT(); input.type = INPUT_MOUSE;
        input.U.mi.dx = (int)Math.Round(x * 65535.0 / sx);
        input.U.mi.dy = (int)Math.Round(y * 65535.0 / sy);
        input.U.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_LEFTUP;
        SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
        Thread.Sleep(70);
    }

    private static void Chord(int modifier, int key)
    {
        Key(modifier, false); Key(key, false); Key(key, true); Key(modifier, true); Thread.Sleep(55);
    }

    private static void Key(int key, bool up)
    {
        INPUT input = new INPUT(); input.type = INPUT_KEYBOARD;
        input.U.ki.wVk = (ushort)key; input.U.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
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
        Thread.Sleep(180);
    }

    private static IntPtr FindChromeWindow(int pid)
    {
        IntPtr result = IntPtr.Zero; long area = 0;
        EnumWindows(delegate(IntPtr window, IntPtr parameter)
        {
            if (!IsWindowVisible(window)) return true;
            uint owner; GetWindowThreadProcessId(window, out owner); if (owner != (uint)pid) return true;
            StringBuilder name = new StringBuilder(128); GetClassName(window, name, name.Capacity);
            if (!name.ToString().StartsWith("Chrome_WidgetWin_")) return true;
            RECT rect; if (!GetWindowRect(window, out rect)) return true;
            long candidate = Math.Max(0, rect.Right - rect.Left) * (long)Math.Max(0, rect.Bottom - rect.Top);
            if (candidate > area) { area = candidate; result = window; }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit, Size = 32)] private struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr extra; }
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out RECT rect);
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
