using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

internal static class NativeSyncHotkeys
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;
    private const int WM_QUIT = 0x0012;
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint VK_CONTROL = 0x11;
    private const uint VK_MENU = 0x12;
    private const uint VK_LCONTROL = 0xA2;
    private const uint VK_RCONTROL = 0xA3;
    private const uint VK_LMENU = 0xA4;
    private const uint VK_RMENU = 0xA5;
    private const uint VK_A = 0x41;
    private const uint VK_D = 0x44;
    private const uint VK_R = 0x52;
    private const uint VK_S = 0x53;
    private static readonly UIntPtr SelfTestMarker = new UIntPtr(0x0B05A012);
    private static readonly HashSet<uint> Held = new HashSet<uint>();
    private static LowLevelKeyboardProc callback;
    private static IntPtr hook = IntPtr.Zero;
    private static bool controlDown;
    private static bool altDown;
    private static bool selfTest;
    private static int selfTestActions;
    private static uint messageThread;

    public static int Main(string[] args)
    {
        selfTest = args.Length == 1 && String.Equals(args[0], "--selftest", StringComparison.OrdinalIgnoreCase);
        messageThread = GetCurrentThreadId();
        callback = HookCallback;
        hook = SetWindowsHookEx(WH_KEYBOARD_LL, callback, GetModuleHandle(null), 0);
        if (hook == IntPtr.Zero)
        {
            Console.Error.WriteLine("HOOK_ERROR=" + Marshal.GetLastWin32Error());
            return 2;
        }
        Console.WriteLine("READY");
        Console.Out.Flush();
        if (selfTest)
        {
            Thread injector = new Thread(SelfTestInput);
            injector.IsBackground = true;
            injector.Start();
        }
        MSG message;
        while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref message);
            DispatchMessage(ref message);
        }
        UnhookWindowsHookEx(hook);
        hook = IntPtr.Zero;
        return selfTest && selfTestActions == 3 ? 0 : (selfTest ? 3 : 0);
    }

    private static IntPtr HookCallback(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0)
        {
            KBDLLHOOKSTRUCT data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            bool marked = data.dwExtraInfo == SelfTestMarker;
            if ((selfTest && marked) || (!selfTest && !marked))
            {
                int message = wParam.ToInt32();
                bool down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
                bool up = message == WM_KEYUP || message == WM_SYSKEYUP;
                if (data.vkCode == VK_CONTROL || data.vkCode == VK_LCONTROL || data.vkCode == VK_RCONTROL) controlDown = down ? true : (up ? false : controlDown);
                if (data.vkCode == VK_MENU || data.vkCode == VK_LMENU || data.vkCode == VK_RMENU) altDown = down ? true : (up ? false : altDown);
                if (up) Held.Remove(data.vkCode);
                if (down && controlDown && altDown && !Held.Contains(data.vkCode))
                {
                    string action = null;
                    if (data.vkCode == VK_A || data.vkCode == VK_S) action = "start";
                    else if (data.vkCode == VK_D) action = "stop";
                    else if (data.vkCode == VK_R) action = "restart";
                    if (action != null)
                    {
                        Held.Add(data.vkCode);
                        Console.WriteLine(action);
                        Console.Out.Flush();
                        if (selfTest && ++selfTestActions == 3) PostThreadMessage(messageThread, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
                    }
                }
            }
        }
        return CallNextHookEx(hook, code, wParam, lParam);
    }

    private static void SelfTestInput()
    {
        Thread.Sleep(250);
        SendChord(VK_A);
        SendChord(VK_D);
        SendChord(VK_R);
        Thread.Sleep(1000);
        PostThreadMessage(messageThread, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
    }

    private static void SendChord(uint key)
    {
        INPUT[] inputs = new INPUT[] {
            Keyboard(VK_CONTROL, 0), Keyboard(VK_MENU, 0), Keyboard(key, 0),
            Keyboard(key, KEYEVENTF_KEYUP), Keyboard(VK_MENU, KEYEVENTF_KEYUP), Keyboard(VK_CONTROL, KEYEVENTF_KEYUP)
        };
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (selfTest && sent != inputs.Length) { Console.WriteLine("SEND_ERROR=" + sent + ":" + Marshal.GetLastWin32Error() + ":" + Marshal.SizeOf(typeof(INPUT))); Console.Out.Flush(); }
        Thread.Sleep(100);
    }

    private static INPUT Keyboard(uint key, uint flags)
    {
        INPUT value = new INPUT();
        value.type = INPUT_KEYBOARD;
        value.U.ki.wVk = (ushort)key;
        value.U.ki.dwFlags = flags;
        value.U.ki.dwExtraInfo = SelfTestMarker;
        return value;
    }

    private delegate IntPtr LowLevelKeyboardProc(int code, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] private struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)] private struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }
    [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit, Size = 32)] private struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }

    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc proc, IntPtr module, uint threadId);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool UnhookWindowsHookEx(IntPtr value);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr value, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern int GetMessage(out MSG message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG message);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref MSG message);
    [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint threadId, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("kernel32.dll")] private static extern IntPtr GetModuleHandle(string value);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
}