using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

internal static class NativeExtensionPopupDriver
{
    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const int SW_RESTORE = 9;

    public static int Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "--probe")
        {
            int probePid;
            if (!int.TryParse(args[1], out probePid)) return 2;
            EnumWindows(delegate(IntPtr window, IntPtr parameter)
            {
                uint owner;
                GetWindowThreadProcessId(window, out owner);
                if (owner != (uint)probePid) return true;
                StringBuilder probeClass = new StringBuilder(128);
                GetClassName(window, probeClass, probeClass.Capacity);
                RECT probeRect;
                GetWindowRect(window, out probeRect);
                Console.WriteLine("TOPLEVEL=" + window.ToInt64() + "|visible=" + IsWindowVisible(window) + "|class=" + probeClass + "|rect=" + probeRect.Left + "," + probeRect.Top + "," + probeRect.Right + "," + probeRect.Bottom);
                return true;
            }, IntPtr.Zero);
            IntPtr probeWindow = FindChromeWindow(probePid);
            Console.WriteLine("WINDOW_HANDLE=" + probeWindow.ToInt64());
            return probeWindow == IntPtr.Zero ? 9 : 0;
        }
        if (args.Length == 2 && args[0] == "--f12")
        {
            int f12Pid;
            if (!int.TryParse(args[1], out f12Pid)) return 17;
            IntPtr f12Window = FindChromeWindow(f12Pid);
            if (f12Window == IntPtr.Zero) return 18;
            Focus(f12Window);
            RECT f12Rect; if (GetWindowRect(f12Window, out f12Rect)) { Click(f12Rect.Left + Math.Min(260, Math.Max(80, (f12Rect.Right - f12Rect.Left) / 3)), f12Rect.Top + Math.Min(220, Math.Max(140, (f12Rect.Bottom - f12Rect.Top) / 3))); Thread.Sleep(150); Focus(f12Window); }
            INPUT[] keys = new INPUT[] {
                new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = 0x7B } } },
                new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = 0x7B, dwFlags = KEYEVENTF_KEYUP } } }
            };
            if (SendInput((uint)keys.Length, keys, Marshal.SizeOf(typeof(INPUT))) != keys.Length) return 24;
            Thread.Sleep(700);
            Console.WriteLine("F12_SENT_" + f12Pid + "=1");
            return 0;
        }
        if (args.Length == 3 && args[0] == "--click-control")
        {
            int controlPid;
            if (!int.TryParse(args[1], out controlPid)) return 19;
            IntPtr controlWindow = FindChromeWindow(controlPid);
            if (controlWindow == IntPtr.Zero) return 20;
            Focus(controlWindow);
            POINT controlPoint;
            string controlDiagnostic;
            if (!TryFindControl(controlPid, new[] { args[2] }, out controlPoint, out controlDiagnostic))
            {
                Console.Error.WriteLine("CONTROL_NOT_FOUND_" + controlPid + "=" + args[2] + "|" + controlDiagnostic);
                return 21;
            }
            Click(controlPoint.x, controlPoint.y);
            Thread.Sleep(500);
            Console.WriteLine("CONTROL_CLICK_" + controlPid + "=" + args[2]);
            return 0;
        }
        if (args.Length >= 3 && args[0] == "--check-control")
        {
            string expectedControl = args[1];
            for (int i = 2; i < args.Length; i++)
            {
                int expectedPid;
                if (!int.TryParse(args[i], out expectedPid)) return 22;
                POINT expectedPoint;
                string expectedDiagnostic;
                bool visible = TryFindControl(expectedPid, new[] { expectedControl }, out expectedPoint, out expectedDiagnostic);
                Console.WriteLine("CONTROL_VISIBLE_" + expectedPid + "=" + expectedControl + "|" + (visible ? "1" : "0"));
                if (!visible)
                {
                    Console.Error.WriteLine("EXPECTED_CONTROL_NOT_FOUND_" + expectedPid + "=" + expectedControl + "|" + expectedDiagnostic);
                    return 23;
                }
            }
            return 0;
        }
        if (args.Length >= 2 && args[0] == "--check-menus")
        {
            for (int i = 1; i < args.Length; i++)
            {
                int menuPid;
                if (!int.TryParse(args[i], out menuPid)) return 15;
                POINT menuPoint;
                string menuDiagnostic;
                bool visible = TryFindControl(menuPid, new[] { "New tab", "New Tab", "新标签页", "新增分页" }, out menuPoint, out menuDiagnostic);
                Console.WriteLine("CHROME_MENU_VISIBLE_" + menuPid + "=" + (visible ? "1" : "0"));
                if (!visible)
                {
                    Console.Error.WriteLine("CHROME_MENU_NOT_FOUND_" + menuPid + "=" + menuDiagnostic);
                    return 16;
                }
            }
            return 0;
        }
        if (args.Length >= 3 && args[0] == "--coordinates")
        {
            if ((args.Length - 1) % 2 != 0) return 13;
            for (int i = 1; i < args.Length; i += 2)
            {
                int x; int y;
                if (!int.TryParse(args[i], out x) || !int.TryParse(args[i + 1], out y)) return 14;
                Click(x, y);
                Thread.Sleep(500);
                Console.WriteLine("NATIVE_COORDINATE_CLICK=" + x + "," + y);
            }
            return 0;
        }
        if (args.Length >= 2 && args[0] == "--sidepanel")
        {
            for (int i = 1; i < args.Length; i++)
            {
                int sidePanelPid;
                if (!int.TryParse(args[i], out sidePanelPid)) return 10;
                IntPtr window = FindChromeWindow(sidePanelPid);
                if (window == IntPtr.Zero) return 11;
                Focus(window);
                POINT openPoint;
                string openDiagnostic;
                if (!TryFindControl(sidePanelPid, new[] { "Open Side Panel" }, out openPoint, out openDiagnostic))
                {
                    RECT windowRect;
                    if (!GetWindowRect(window, out windowRect)) return 12;
                    openPoint.x = windowRect.Left + 140;
                    openPoint.y = windowRect.Top + 120;
                    Console.WriteLine("SIDE_PANEL_BUTTON_COORDINATE_FALLBACK_" + sidePanelPid + "=" + openPoint.x + "," + openPoint.y);
                }
                Click(openPoint.x, openPoint.y);
                Thread.Sleep(500);
                Console.WriteLine("SIDE_PANEL_OPEN_CLICK_" + sidePanelPid + "=1");
            }
            return 0;
        }
        if (args.Length < 1) return 2;
        int pid;
        if (!int.TryParse(args[0], out pid)) return 2;
        IntPtr master = FindChromeWindow(pid);
        if (master == IntPtr.Zero) return 3;
        Focus(master);
        POINT point;
        string diagnostic;
        if (!TryFindControl(pid, new[] { "Extensions", "扩展程序" }, out point, out diagnostic))
        {
            Console.Error.WriteLine("EXTENSIONS_BUTTON_NOT_FOUND=" + diagnostic);
            return 4;
        }
        Click(point.x, point.y);
        Thread.Sleep(900);
        if (!TryFindControl(pid, new[] { "OpenBrowser Popup Sync Probe" }, out point, out diagnostic))
        {
            Console.Error.WriteLine("EXTENSION_ITEM_NOT_FOUND=" + diagnostic);
            return 5;
        }
        Click(point.x, point.y);
        Thread.Sleep(900);
        POINT sidePanelPoint;
        string sidePanelDiagnostic;
        if (TryFindControl(pid, new[] { "Open Side Panel" }, out sidePanelPoint, out sidePanelDiagnostic))
        {
            Click(sidePanelPoint.x, sidePanelPoint.y);
            Thread.Sleep(1100);
        }
        for (int i = 0; i < args.Length; i++)
        {
            int popupPid;
            if (!int.TryParse(args[i], out popupPid)) return 7;
            POINT popupPoint;
            string popupDiagnostic;
            if (!TryFindControl(popupPid, new[] { "Unlock 0" }, out popupPoint, out popupDiagnostic))
            {
                Console.WriteLine("POPUP_UI_READY_" + popupPid + "=0");
                continue;
            }
            Console.WriteLine("POPUP_UI_READY_" + popupPid + "=1");
        }
        if (TryFindControl(pid, new[] { "Unlock 0" }, out point, out diagnostic))
        {
            Click(point.x, point.y);
            Thread.Sleep(700);
        }
        Console.WriteLine("EXTENSION_POPUP_SEQUENCE=complete");
        return 0;
    }

    private static bool TryFindPopupWindow(int pid, IntPtr main, out RECT popupRect)
    {
        for (int attempt = 0; attempt < 20; attempt++)
        {
            IntPtr best = IntPtr.Zero;
            long bestArea = long.MaxValue;
            foreach (IntPtr window in ChromeWindows(pid))
            {
                if (window == main) continue;
                RECT rect;
                if (!GetWindowRect(window, out rect)) continue;
                long area = Math.Max(0, rect.Right - rect.Left) * (long)Math.Max(0, rect.Bottom - rect.Top);
                if (area > 4000 && area < bestArea) { bestArea = area; best = window; }
            }
            if (best != IntPtr.Zero && GetWindowRect(best, out popupRect)) return true;
            Thread.Sleep(50);
        }
        popupRect = new RECT();
        return false;
    }

    private static bool TryFindControl(int pid, string[] names, out POINT point, out string diagnostic)
    {
        point = new POINT();
        List<string> observed = new List<string>();
        List<IntPtr> windows = ChromeWindows(pid);
        foreach (IntPtr window in windows)
        {
            try
            {
                AutomationElement root = AutomationElement.FromHandle(window);
                AutomationElementCollection elements = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
                foreach (AutomationElement element in elements)
                {
                    string name;
                    System.Windows.Rect rect;
                    try { name = element.Current.Name; rect = element.Current.BoundingRectangle; } catch { continue; }
                    if (!String.IsNullOrWhiteSpace(name) && observed.Count < 80) observed.Add(name);
                    if (String.IsNullOrWhiteSpace(name) || rect.Width < 4 || rect.Height < 4) continue;
                    foreach (string expected in names)
                    {
                        if (!String.Equals(name.Trim(), expected, StringComparison.OrdinalIgnoreCase)) continue;
                        point.x = (int)Math.Round(rect.Left + rect.Width / 2);
                        point.y = (int)Math.Round(rect.Top + rect.Height / 2);
                        diagnostic = name;
                        return true;
                    }
                }
            }
            catch { }
        }
        diagnostic = String.Join(" | ", observed.ToArray());
        return false;
    }

    private static List<IntPtr> ChromeWindows(int pid)
    {
        List<IntPtr> result = new List<IntPtr>();
        EnumWindows(delegate(IntPtr window, IntPtr parameter)
        {
            if (!IsWindowVisible(window)) return true;
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != (uint)pid) return true;
            StringBuilder name = new StringBuilder(128);
            GetClassName(window, name, name.Capacity);
            if (name.ToString().StartsWith("Chrome_WidgetWin_")) result.Add(window);
            return true;
        }, IntPtr.Zero);
        return result;
    }

    private static void Click(int x, int y)
    {
        INPUT move = new INPUT();
        move.type = INPUT_MOUSE;
        move.U.mi.dx = (int)Math.Round(x * 65535.0 / Math.Max(1, GetSystemMetrics(0) - 1));
        move.U.mi.dy = (int)Math.Round(y * 65535.0 / Math.Max(1, GetSystemMetrics(1) - 1));
        move.U.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
        INPUT down = new INPUT();
        down.type = INPUT_MOUSE;
        down.U.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
        INPUT up = new INPUT();
        up.type = INPUT_MOUSE;
        up.U.mi.dwFlags = MOUSEEVENTF_LEFTUP;
        if (SendInput(1, new[] { move }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new InvalidOperationException("SendInput move failed");
        Thread.Sleep(25);
        if (SendInput(1, new[] { down }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new InvalidOperationException("SendInput down failed");
        Thread.Sleep(35);
        if (SendInput(1, new[] { up }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new InvalidOperationException("SendInput up failed");
    }

    private static void Focus(IntPtr window)
    {
        IntPtr foreground = GetForegroundWindow();
        uint ignored;
        uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out ignored);
        uint targetThread = GetWindowThreadProcessId(window, out ignored);
        uint currentThread = GetCurrentThreadId();
        if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, true);
        if (targetThread != 0) AttachThreadInput(currentThread, targetThread, true);
        if (IsIconic(window)) ShowWindow(window, SW_RESTORE);
        BringWindowToTop(window);
        SetForegroundWindow(window);
        SetFocus(window);
        if (targetThread != 0) AttachThreadInput(currentThread, targetThread, false);
        if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, false);
        Thread.Sleep(250);
    }

    private static IntPtr FindChromeWindow(int pid)
    {
        IntPtr result = IntPtr.Zero;
        long largest = 0;
        EnumWindows(delegate(IntPtr window, IntPtr parameter)
        {
            if (!IsWindowVisible(window)) return true;
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != (uint)pid) return true;
            StringBuilder name = new StringBuilder(128);
            GetClassName(window, name, name.Capacity);
            if (!name.ToString().StartsWith("Chrome_WidgetWin_")) return true;
            RECT rect;
            if (!GetWindowRect(window, out rect)) return true;
            long area = Math.Max(0, rect.Right - rect.Left) * (long)Math.Max(0, rect.Bottom - rect.Top);
            if (area > largest) { largest = area; result = window; }
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
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
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
