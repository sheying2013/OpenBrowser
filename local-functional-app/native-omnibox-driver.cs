using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Windows.Automation;

internal static class OmniboxDriver
{
    private static int sent;
    private static int sendFailures;
    private static volatile bool sampleForeground;
    private static int foregroundViolations;
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 2;
    private const int SW_RESTORE = 9;
    private const int VK_CONTROL = 0x11;
    private const int VK_L = 0x4C;
    private const int VK_C = 0x43;
    private const int VK_V = 0x56;

    [STAThread]
    public static int Main(string[] args)
    {
        if (args.Length < 3) return 2;
        int masterPid = int.Parse(args[0]);
        string expected = args[1];
        IntPtr master = FindChromeWindow(masterPid);
        IntPtr[] slaves = new IntPtr[args.Length - 2];
        for (int i = 2; i < args.Length; i++) slaves[i - 2] = FindChromeWindow(int.Parse(args[i]));
        if (master == IntPtr.Zero || Array.Exists(slaves, delegate(IntPtr value) { return value == IntPtr.Zero; })) return 3;
        uint[] slaveOwners = new uint[slaves.Length];
        for (int i = 0; i < slaves.Length; i++) GetWindowThreadProcessId(slaves[i], out slaveOwners[i]);

        string savedClipboard = string.Empty;
        savedClipboard = ReadClipboard(false);
        SetClipboard(expected);
        Focus(master);
        sampleForeground = true;
        Thread sampler = new Thread(delegate()
        {
            while (sampleForeground)
            {
                IntPtr foreground = GetForegroundWindow();

                uint foregroundPid;

                GetWindowThreadProcessId(foreground, out foregroundPid);

                if (Array.IndexOf(slaveOwners, foregroundPid) >= 0) Interlocked.Increment(ref foregroundViolations);
                Thread.Sleep(2);
            }
        }) { IsBackground = true };
        sampler.Start();
        Chord(VK_CONTROL, VK_L);
        Thread.Sleep(180);
        Chord(VK_CONTROL, VK_V);
        Thread.Sleep(1800);

        Console.WriteLine("MASTER_HWND=" + master.ToInt64());
        for (int i = 0; i < slaves.Length; i++) Console.WriteLine("SLAVE_" + (i + 1) + "_HWND=" + slaves[i].ToInt64());
        Console.WriteLine("FOREGROUND_AFTER_TYPE=" + GetForegroundWindow().ToInt64());
        sampleForeground = false; sampler.Join(300);
        string masterText = CopyOmnibox(master);
        string[] slaveTexts = Array.ConvertAll(slaves, CopyOmnibox);
        Console.WriteLine("MASTER=" + masterText);
        for (int i = 0; i < slaveTexts.Length; i++) Console.WriteLine("SLAVE_" + (i + 1) + "=" + slaveTexts[i]);
        SetClipboard("__copy_sentinel__");
        Focus(master);
        Chord(VK_CONTROL, VK_L);
        Chord(VK_CONTROL, VK_C);
        Thread.Sleep(350);
        string copied = ReadClipboard(true);
        Console.WriteLine("COPIED=" + copied);
        Console.WriteLine("EXPECTED=" + expected);
        Console.WriteLine("SEND_CALLS=" + sent);
        Console.WriteLine("SEND_FAILURES=" + sendFailures);
        Console.WriteLine("FOREGROUND_FINAL=" + GetForegroundWindow().ToInt64());
        Console.WriteLine("FOREGROUND_VIOLATIONS=" + foregroundViolations);
        SetClipboard(savedClipboard);
        return masterText == expected && copied == expected && foregroundViolations <= 8 && Array.TrueForAll(slaveTexts, delegate(string value) { return value == expected; }) ? 0 : 4;
    }

    private static string ReadTopEditor(IntPtr window)
    {
        RECT bounds; if (!GetWindowRect(window, out bounds)) return string.Empty;
        AutomationElement root = AutomationElement.FromHandle(window);
        AutomationElementCollection edits = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
        AutomationElement best = null; double bestWidth = 0;
        foreach (AutomationElement edit in edits)
        {
            try
            {
                System.Windows.Rect rectangle = edit.Current.BoundingRectangle;
                if (rectangle.Top - bounds.Top < 0 || rectangle.Top - bounds.Top > 170 || rectangle.Width < 180 || rectangle.Width <= bestWidth) continue;
                best = edit; bestWidth = rectangle.Width;
            }
            catch { }
        }
        if (best == null) return string.Empty;
        object pattern; return best.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) ? ((ValuePattern)pattern).Current.Value : string.Empty;
    }

    private static string ReadClipboard(bool requireValue)
    {
        for (int attempt = 0; attempt < 25; attempt++)
        {
            try
            {
                string value = Clipboard.GetText(TextDataFormat.UnicodeText);
                if (!requireValue || !string.IsNullOrEmpty(value)) return value;
            }
            catch { }
            Thread.Sleep(80);
        }
        return string.Empty;
    }

    private static void SetClipboard(string value)
    {
        for (int attempt = 0; attempt < 10; attempt++)
        {
            try { Clipboard.SetText(value ?? string.Empty); return; } catch { Thread.Sleep(60); }
        }
    }

    private static string CopyOmnibox(IntPtr window)
    {
        string sentinel = "__read_sentinel_" + Guid.NewGuid().ToString("N") + "__";
        SetClipboard(sentinel);
        Focus(window);
        Chord(VK_CONTROL, VK_L);
        Thread.Sleep(120);
        Chord(VK_CONTROL, VK_C);
        for (int attempt = 0; attempt < 25; attempt++)
        {
            try
            {
                string value = Clipboard.GetText(TextDataFormat.UnicodeText);
                if (value != sentinel) return value;
            }
            catch { }
            Thread.Sleep(80);
        }
        return sentinel;
    }

    private static void TypeCharacter(char value)
    {
        short mapped = VkKeyScan(value);
        if (mapped == -1) return;
        byte virtualKey = (byte)(mapped & 0xff);
        byte modifiers = (byte)((mapped >> 8) & 0xff);
        if ((modifiers & 1) != 0) Key(0x10, false);
        Key(virtualKey, false);
        Key(virtualKey, true);
        if ((modifiers & 1) != 0) Key(0x10, true);
    }

    private static void Chord(int modifier, int key)
    {
        Key(modifier, false); Key(key, false); Key(key, true); Key(modifier, true); Thread.Sleep(80);
    }

    private static void Key(int key, bool up)
    {
        INPUT input = new INPUT(); input.type = INPUT_KEYBOARD; input.U.ki.wVk = (ushort)key; input.U.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
        sent++; if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1) sendFailures++;
    }

    private static void Focus(IntPtr window)
    {
        IntPtr foreground = GetForegroundWindow();
        uint foregroundPid; uint targetPid;
        uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out foregroundPid);
        uint targetThread = GetWindowThreadProcessId(window, out targetPid);
        uint currentThread = GetCurrentThreadId();
        if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, true);
        if (targetThread != 0) AttachThreadInput(currentThread, targetThread, true);
        if (IsIconic(window)) ShowWindow(window, SW_RESTORE);
        BringWindowToTop(window); SetForegroundWindow(window); SetFocus(window);
        if (targetThread != 0) AttachThreadInput(currentThread, targetThread, false);
        if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, false);
        Thread.Sleep(220);
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
    [DllImport("user32.dll")] private static extern short VkKeyScan(char character);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder value, int length);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr SetFocus(IntPtr window);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
}
