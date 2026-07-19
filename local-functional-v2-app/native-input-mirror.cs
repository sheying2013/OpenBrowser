using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

internal static class NativeInputMirror
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WH_MOUSE_LL = 14;
    private const int HC_ACTION = 0;
    private const int WM_ACTIVATE = 0x0006;
    private const int WM_SETFOCUS = 0x0007;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;
    private const int WM_MOUSEMOVE = 0x0200;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_LBUTTONUP = 0x0202;
    private const int WM_RBUTTONDOWN = 0x0204;
    private const int WM_RBUTTONUP = 0x0205;
    private const int WM_MBUTTONDOWN = 0x0207;
    private const int WM_MBUTTONUP = 0x0208;
    private const int WM_MOUSEWHEEL = 0x020A;
    private const int VK_CONTROL = 0x11;
    private const int VK_LCONTROL = 0xA2;
    private const int VK_RCONTROL = 0xA3;
    private const int VK_L = 0x4C;
    private const int VK_C = 0x43;
    private const int VK_X = 0x58;
    private const int VK_F6 = 0x75;
    private const int VK_F12 = 0x7B;
    private const int VK_RETURN = 0x0D;
    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    private const int SM_CXSCREEN = 0;
    private const int SM_CYSCREEN = 1;
    private const int SW_RESTORE = 9;
    private const uint GA_ROOT = 2;
    private const long OwnInjectionMarker = 0x42524F575345524F;

    private static int masterPid;
    private static readonly List<int> slavePids = new List<int>();
    private static readonly BlockingCollection<MirrorEvent> queue = new BlockingCollection<MirrorEvent>(new ConcurrentQueue<MirrorEvent>(), 1024);
    private static readonly LowLevelProc keyboardProc = KeyboardHook;
    private static readonly LowLevelProc mouseProc = MouseHook;
    private static IntPtr keyboardHook;
    private static IntPtr mouseHook;
    private static volatile bool chromeUiMode;
    private static volatile bool devToolsMode;
    private static bool syncKeyboard = true, syncClick = true, syncScroll = true, syncTrack = true, delayClick, delayInput;
    private static int inputMinMs = 300, inputMaxMs = 300, clickMinMs = 100, clickMaxMs = 300;
    private static readonly Random delayRandom = new Random();
    private static volatile int pendingSelectionKey;
    private static int editorSnapshotQueued;
    private static volatile int lastEditorActionAt;
    private static volatile bool running = true;
    private static readonly Dictionary<IntPtr, AutomationElement> editorCache = new Dictionary<IntPtr, AutomationElement>();

    private sealed class MirrorEvent
    {
        public bool Keyboard;
        public int Message;
        public uint VirtualKey;
        public uint ScanCode;
        public uint KeyboardFlags;
        public POINT Point;
        public int MouseData;
        public bool SlavesOnly;
        public bool BootstrapControl;
        public bool Control;
        public bool Shift;
        public bool Alt;
        public int DelayMs;
        public bool RestoreMaster;
        public int PrepareSelectionKey;
        public bool ApplyEditorSnapshot;
        public bool PostMessageOnly;
        public bool SourcePopup;
        public RECT SourceRect;
    }

    private static bool ReadBoolSetting(string name, bool fallback)
    {
        string value = Environment.GetEnvironmentVariable(name);
        if (String.IsNullOrWhiteSpace(value)) return fallback;
        return value == "1" || value.Equals("true", StringComparison.OrdinalIgnoreCase);
    }

    private static int ReadIntSetting(string name, int fallback)
    {
        int value; return int.TryParse(Environment.GetEnvironmentVariable(name), out value) ? Math.Max(0, Math.Min(5000, value)) : fallback;
    }

    public static int Main(string[] args)
    {
        if (args.Length < 2 || !int.TryParse(args[0], out masterPid)) return 2;
        for (int i = 1; i < args.Length; i++) { int pid; if (int.TryParse(args[i], out pid) && pid > 0) slavePids.Add(pid); }
        if (slavePids.Count == 0) return 3;
        syncKeyboard = ReadBoolSetting("OPENBROWSER_SYNC_KEYBOARD", true); syncClick = ReadBoolSetting("OPENBROWSER_SYNC_CLICK", true);
        syncScroll = ReadBoolSetting("OPENBROWSER_SYNC_SCROLL", true); syncTrack = ReadBoolSetting("OPENBROWSER_SYNC_TRACK", true);
        delayClick = ReadBoolSetting("OPENBROWSER_DELAY_CLICK", false); delayInput = ReadBoolSetting("OPENBROWSER_DELAY_INPUT", false);
        inputMinMs = ReadIntSetting("OPENBROWSER_INPUT_MIN_MS", 300); inputMaxMs = Math.Max(inputMinMs, ReadIntSetting("OPENBROWSER_INPUT_MAX_MS", inputMinMs));
        clickMinMs = ReadIntSetting("OPENBROWSER_CLICK_MIN_MS", 100); clickMaxMs = Math.Max(clickMinMs, ReadIntSetting("OPENBROWSER_CLICK_MAX_MS", clickMinMs));

        try { SetProcessDPIAware(); } catch { }
        AppDomain.CurrentDomain.ProcessExit += delegate { running = false; queue.CompleteAdding(); Unhook(); };
        Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel = true; queue.CompleteAdding(); PostQuitMessage(0); };

        Thread worker = new Thread(WorkerLoop) { IsBackground = true, Name = "OpenBrowser input mirror" };
        worker.Start();
        keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, keyboardProc, GetModuleHandle(null), 0);
        mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, GetModuleHandle(null), 0);
        if (keyboardHook == IntPtr.Zero || mouseHook == IntPtr.Zero) return 4;
        Console.WriteLine("READY");

        MSG message;
        while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref message);
            DispatchMessage(ref message);
        }
        queue.CompleteAdding();
        Unhook();
        return 0;
    }

    private static void Unhook()
    {
        if (keyboardHook != IntPtr.Zero) { UnhookWindowsHookEx(keyboardHook); keyboardHook = IntPtr.Zero; }
        if (mouseHook != IntPtr.Zero) { UnhookWindowsHookEx(mouseHook); mouseHook = IntPtr.Zero; }
    }

    private static void Enqueue(MirrorEvent item)
    {
        if (!queue.IsAddingCompleted) queue.TryAdd(item);
    }

    private static IntPtr KeyboardHook(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code != HC_ACTION || !syncKeyboard) return CallNextHookEx(keyboardHook, code, wParam, lParam);
        KBDLLHOOKSTRUCT data = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
        if (data.dwExtraInfo.ToInt64() == OwnInjectionMarker) return CallNextHookEx(keyboardHook, code, wParam, lParam);
        IntPtr master = FindChromeWindow(masterPid);
        if (master == IntPtr.Zero || !IsProcessForeground(masterPid)) return CallNextHookEx(keyboardHook, code, wParam, lParam);
        IntPtr sourceWindow = GetForegroundWindow();
        RECT sourceRect = new RECT();
        bool sourcePopup = sourceWindow != IntPtr.Zero && sourceWindow != master && IsChromeWidgetForPid(sourceWindow, masterPid) && GetWindowRect(sourceWindow, out sourceRect);
        if (!sourcePopup && !GetWindowRect(master, out sourceRect)) return CallNextHookEx(keyboardHook, code, wParam, lParam);
        // Extension popup documents are mirrored through their own CDP target. Posting keyboard
        // messages to the popup's top-level widget misses its focused DOM editor and can also
        // duplicate input after the DOM bridge is attached.
        if (sourcePopup) return CallNextHookEx(keyboardHook, code, wParam, lParam);
        int message = wParam.ToInt32(); bool down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN; bool up = message == WM_KEYUP || message == WM_SYSKEYUP;
        bool control = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0 || (GetAsyncKeyState(VK_LCONTROL) & 0x8000) != 0 || (GetAsyncKeyState(VK_RCONTROL) & 0x8000) != 0;
        bool shift = (GetAsyncKeyState(0x10) & 0x8000) != 0; bool alt = (GetAsyncKeyState(0x12) & 0x8000) != 0;
        bool devToolsKey = data.vkCode == VK_F12;
        if (down && devToolsKey)
        {
            devToolsMode = !devToolsMode;
            chromeUiMode = devToolsMode;
            Console.WriteLine("DEVTOOLS_MODE=" + (devToolsMode ? "1" : "0"));
            Console.Out.Flush();
        }
        if (devToolsKey)
        {
            if (down) Enqueue(new MirrorEvent { Keyboard = true, Message = WM_KEYDOWN, VirtualKey = VK_F12, ScanCode = data.scanCode, KeyboardFlags = data.flags, SlavesOnly = true, DelayMs = 180, PostMessageOnly = false, SourceRect = sourceRect });
            return CallNextHookEx(keyboardHook, code, wParam, lParam);
        }
        if (down && ((control && data.vkCode == VK_L) || data.vkCode == VK_F6)) chromeUiMode = true;
        if (devToolsMode) chromeUiMode = true;
        if (!chromeUiMode) return CallNextHookEx(keyboardHook, code, wParam, lParam);
        bool modifier = data.vkCode == 0x10 || data.vkCode == VK_CONTROL || data.vkCode == VK_LCONTROL || data.vkCode == VK_RCONTROL || data.vkCode == 0x12 || data.vkCode == 0xA4 || data.vkCode == 0xA5;
        // Background WM_KEY messages are the primary path; UI Automation is a delayed no-activate correction.
        // Never write Chrome UI through UI Automation: Chromium activates the target top-level window.
        bool clipboardRead = control && (data.vkCode == VK_C || data.vkCode == VK_X);
        if (!clipboardRead)
        {
            Enqueue(new MirrorEvent
            {
                Keyboard = true,
                Message = message,
                VirtualKey = data.vkCode,
                ScanCode = data.scanCode,
                KeyboardFlags = data.flags,
                SlavesOnly = true,
                BootstrapControl = down && control && data.vkCode == VK_L,
                Control = control,
                Shift = shift,
                Alt = alt,
                PostMessageOnly = true,
                SourcePopup = sourcePopup,
                SourceRect = sourceRect
            });
        }
        if (!devToolsMode && data.vkCode == VK_RETURN && up) chromeUiMode = false;
        return CallNextHookEx(keyboardHook, code, wParam, lParam);
    }

    private static bool IsEditorMutation(uint key, bool control, bool alt)
    {
        if (alt) return false;
        if (control) return key == 0x56 || key == 0x58 || key == 0x08 || key == 0x2E;
        if (key == 0xE5 || key == 0xE7) return true;
        if (key == 0x08 || key == 0x2E || key == 0x20) return true;
        return (key >= 0x30 && key <= 0x5A) || (key >= 0x60 && key <= 0x6F) || (key >= 0xBA && key <= 0xE2);
    }

    private static void QueueEditorSnapshot()
    {
        lastEditorActionAt = Environment.TickCount;
        if (Interlocked.CompareExchange(ref editorSnapshotQueued, 1, 0) == 0) Enqueue(new MirrorEvent { ApplyEditorSnapshot = true });
    }

    private static void ApplyEditorSnapshotEffect()
    {
        while (unchecked(Environment.TickCount - lastEditorActionAt) < 220) Thread.Sleep(35);
        IntPtr master = FindChromeWindow(masterPid); AutomationElement masterEditor = CachedTopEditor(master);
        string value = masterEditor == null ? null : ReadEditorValue(masterEditor);
        bool focusedMainEditor = false;
        try { focusedMainEditor = GetForegroundWindow() == master && masterEditor != null && masterEditor.Current.HasKeyboardFocus; } catch { }
        if (masterEditor == null || !IsProcessForeground(masterPid) || value == null || (value.Length == 0 && !focusedMainEditor))
        {
            Interlocked.Exchange(ref editorSnapshotQueued, 0);
            return;
        }
        if (value != null)
        {
            foreach (int pid in slavePids)
            {
                IntPtr window = FindChromeWindow(pid);
                AutomationElement editor = CachedTopEditor(window);
                if (editor != null && ReadEditorValue(editor) != value) WriteEditorValueNoActivate(window, editor, value);
            }
            // WS_EX_NOACTIVATE keeps the master process foreground; do not force a handle switch.
        }
        Interlocked.Exchange(ref editorSnapshotQueued, 0);
    }

    private static void UiAutomationLoop()
    {
        string observed = null;
        string pending = null;
        int changedAt = 0;
        while (running)
        {
            try
            {
                IntPtr master = FindChromeWindow(masterPid);
                AutomationElement editor = CachedTopEditor(master);
                if (editor != null && editor.Current.HasKeyboardFocus)
                {
                    string value = ReadEditorValue(editor);
                    if (value != null && observed == null) observed = value;
                    else if (value != null && value != observed) { observed = value; pending = value; changedAt = Environment.TickCount; }
                    if (pending != null && unchecked(Environment.TickCount - changedAt) >= 220)
                    {
                        foreach (int pid in slavePids)
                        {
                            IntPtr slaveWindow = FindChromeWindow(pid);
                            AutomationElement slaveEditor = CachedTopEditor(slaveWindow);
                            if (slaveEditor != null && ReadEditorValue(slaveEditor) != pending) { WriteEditorValue(slaveEditor, pending); RestoreMasterNoDelay(); }
                        }
                        pending = null;
                        if (GetForegroundWindow() != master) FocusWindow(master);
                    }
                }
                else { observed = null; pending = null; }
            }
            catch { observed = null; pending = null; }
            Thread.Sleep(70);
        }
    }

    private static AutomationElement CachedTopEditor(IntPtr window)
    {
        if (window == IntPtr.Zero) return null;
        AutomationElement cached;
        if (editorCache.TryGetValue(window, out cached))
        {
            try { bool enabled = cached.Current.IsEnabled; return cached; } catch { editorCache.Remove(window); }
        }
        AutomationElement found = FindTopEditor(window); if (found != null) editorCache[window] = found; return found;
    }

    private static AutomationElement FindTopEditor(IntPtr window)
    {
        if (window == IntPtr.Zero) return null;
        RECT bounds; if (!GetWindowRect(window, out bounds)) return null;
        AutomationElement root = AutomationElement.FromHandle(window);
        AutomationElementCollection edits = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
        AutomationElement best = null; double bestWidth = 0;
        foreach (AutomationElement edit in edits)
        {
            try
            {
                System.Windows.Rect rectangle = edit.Current.BoundingRectangle;
                double top = rectangle.Top - bounds.Top;
                if (top < 0 || top > 170 || rectangle.Width < 180 || !edit.Current.IsEnabled) continue;
                if (rectangle.Width > bestWidth) { best = edit; bestWidth = rectangle.Width; }
            }
            catch { }
        }
        return best;
    }

    private static string ReadEditorValue(AutomationElement editor)
    {
        object pattern;
        if (editor.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return ((ValuePattern)pattern).Current.Value;
        return null;
    }

    private static void WriteEditorValueNoActivate(IntPtr window, AutomationElement editor, string value)
    {
        IntPtr original = GetWindowLongPtr(window, -20);
        const uint refreshFlags = 0x00000237;
        SetWindowLongPtr(window, -20, new IntPtr(original.ToInt64() | 0x08000000L));
        SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0, refreshFlags);
        try { WriteEditorValue(editor, value); RestoreMasterNoDelay(); }
        finally
        {
            SetWindowLongPtr(window, -20, original);
            SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0, refreshFlags);
        }
    }

    private static void WriteEditorValue(AutomationElement editor, string value)
    {
        object pattern;
        if (editor.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
        {
            ValuePattern writable = (ValuePattern)pattern;
            if (!writable.Current.IsReadOnly) writable.SetValue(value);
        }
    }

    private static void RestoreMasterNoDelay()
    {
        IntPtr master = FindChromeWindow(masterPid);
        if (master == IntPtr.Zero || IsProcessForeground(masterPid)) return;
        IntPtr foreground = GetForegroundWindow();
        uint ignoredForegroundPid;
        uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out ignoredForegroundPid);
        uint ignoredTargetPid;
        uint targetThread = GetWindowThreadProcessId(master, out ignoredTargetPid);
        uint currentThread = GetCurrentThreadId();
        if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, true);
        if (targetThread != 0) AttachThreadInput(currentThread, targetThread, true);
        BringWindowToTop(master);
        SetForegroundWindow(master);
        SetFocus(master);
        if (targetThread != 0) AttachThreadInput(currentThread, targetThread, false);
        if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, false);
    }

    private static IntPtr MouseHook(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code != HC_ACTION) return CallNextHookEx(mouseHook, code, wParam, lParam);
        MSLLHOOKSTRUCT data = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
        if (data.dwExtraInfo.ToInt64() == OwnInjectionMarker) return CallNextHookEx(mouseHook, code, wParam, lParam);
        IntPtr master = FindChromeWindow(masterPid);
        if (master == IntPtr.Zero || !IsProcessForeground(masterPid)) return CallNextHookEx(mouseHook, code, wParam, lParam);
        RECT rect;
        if (!GetWindowRect(master, out rect)) return CallNextHookEx(mouseHook, code, wParam, lParam);
        IntPtr sourceSurface = FindChromeSurfaceAtPoint(masterPid, data.pt);
        RECT sourceRect = rect;
        bool sourcePopup = sourceSurface != IntPtr.Zero && sourceSurface != master && GetWindowRect(sourceSurface, out sourceRect);

        int message = wParam.ToInt32();
        bool buttonDown = message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN || message == WM_MBUTTONDOWN;
        bool buttonUp = message == WM_LBUTTONUP || message == WM_RBUTTONUP || message == WM_MBUTTONUP;
        bool wheel = message == WM_MOUSEWHEEL;
        bool move = message == WM_MOUSEMOVE;
        bool dragMove = move && ((GetAsyncKeyState(0x01) & 0x8000) != 0 || (GetAsyncKeyState(0x02) & 0x8000) != 0 || (GetAsyncKeyState(0x04) & 0x8000) != 0);
        int relativeY = data.pt.y - rect.Top;
        int uiHeight = Math.Min(150, Math.Max(92, (rect.Bottom - rect.Top) / 7));

        bool inChromeUi = relativeY >= 0 && relativeY <= uiHeight;
        bool nativeSurface = devToolsMode || sourcePopup || inChromeUi;
        if (buttonDown) chromeUiMode = nativeSurface;
        if ((buttonDown || buttonUp) && !syncClick) return CallNextHookEx(mouseHook, code, wParam, lParam);
        if (wheel && !syncScroll) return CallNextHookEx(mouseHook, code, wParam, lParam);
        if (move && !syncTrack) return CallNextHookEx(mouseHook, code, wParam, lParam);
        if (!(nativeSurface || chromeUiMode) || (!buttonDown && !buttonUp && !wheel && !move && !dragMove)) return CallNextHookEx(mouseHook, code, wParam, lParam);

        Enqueue(new MirrorEvent
        {
            Keyboard = false,
            Message = message,
            Point = data.pt,
            MouseData = unchecked((int)data.mouseData),
            SlavesOnly = true,
            PostMessageOnly = true,
            SourcePopup = sourcePopup,
            SourceRect = sourceRect
        });
        return CallNextHookEx(mouseHook, code, wParam, lParam);
    }

    private static void WorkerLoop()
    {
        foreach (MirrorEvent item in queue.GetConsumingEnumerable())
        {
            try
            {
                if (item.ApplyEditorSnapshot) { ApplyEditorSnapshotEffect(); continue; }
                if (item.DelayMs > 0) Thread.Sleep(item.DelayMs);
                else if (item.Keyboard && delayInput && item.Message == WM_KEYDOWN) Thread.Sleep(delayRandom.Next(inputMinMs, inputMaxMs + 1));
                else if (!item.Keyboard && delayClick && (item.Message == WM_LBUTTONDOWN || item.Message == WM_RBUTTONDOWN || item.Message == WM_MBUTTONDOWN)) Thread.Sleep(delayRandom.Next(clickMinMs, clickMaxMs + 1));
                IntPtr master = FindChromeWindow(masterPid);
                if (master == IntPtr.Zero) continue;
                List<IntPtr> targets = new List<IntPtr>();
                foreach (int pid in slavePids)
                {
                    IntPtr window = FindChromeWindow(pid);
                    if (window != IntPtr.Zero && item.SourcePopup) window = FindMatchingChromePopup(pid, item.SourceRect, master, window);
                    if (window != IntPtr.Zero) targets.Add(window);
                }
                if (!item.SlavesOnly) targets.Add(master);
                if (item.PostMessageOnly)
                {
                    foreach (IntPtr target in targets)
                    {
                        if (item.Keyboard) PostKeyboard(item, target);
                        else PostMouse(item, item.SourceRect, target);
                    }
                    continue;
                }
                foreach (IntPtr target in targets)
                {
                    FocusWindow(target);
                    if (item.Keyboard) {
                        if (item.PrepareSelectionKey != 0) { SendKey(VK_CONTROL, 0, false, false); SendKey((uint)item.PrepareSelectionKey, 0, false, false); SendKey((uint)item.PrepareSelectionKey, 0, true, false); SendKey(VK_CONTROL, 0, true, false); Thread.Sleep(18); }
                        SendKeyboard(item, target != master);
                        if (item.VirtualKey == VK_F12) Thread.Sleep(320);
                    } else SendMouse(item, item.SourceRect, target);
                }
                FocusWindow(master);
            }
            catch { }
        }
    }

    private static void SendKeyboard(MirrorEvent item, bool slave)
    {
        if (item.BootstrapControl) SendKey(VK_CONTROL, 0, false, false);
        if (item.Shift) SendKey(0x10, 0, false, false);
        if (item.Alt) SendKey(0x12, 0, false, false);
        bool extended = (item.KeyboardFlags & 0x01) != 0;
        SendKey(item.VirtualKey, item.ScanCode, false, extended);
        SendKey(item.VirtualKey, item.ScanCode, true, extended);
        if (item.Alt) SendKey(0x12, 0, true, false);
        if (item.Shift) SendKey(0x10, 0, true, false);
        if (item.BootstrapControl) SendKey(VK_CONTROL, 0, true, false);
    }

    private static void PostKeyboard(MirrorEvent item, IntPtr target)
    {
        // Keep controlled Chrome windows in the background while preserving modifier chords.
        bool keyUp = item.Message == WM_KEYUP || item.Message == WM_SYSKEYUP;
        bool system = item.Message == WM_SYSKEYDOWN || item.Message == WM_SYSKEYUP;
        bool extended = (item.KeyboardFlags & 0x01) != 0;
        bool ownControl = item.VirtualKey == VK_CONTROL || item.VirtualKey == VK_LCONTROL || item.VirtualKey == VK_RCONTROL;
        bool ownShift = item.VirtualKey == 0x10 || item.VirtualKey == 0xA0 || item.VirtualKey == 0xA1;
        bool ownAlt = item.VirtualKey == 0x12 || item.VirtualKey == 0xA4 || item.VirtualKey == 0xA5;
        if (!keyUp) {
            if ((item.BootstrapControl || item.Control) && !ownControl) PostModifier(target, VK_CONTROL, false);
            if (item.Shift && !ownShift) PostModifier(target, 0x10, false);
            if (item.Alt && !ownAlt) PostModifier(target, 0x12, false);
        }
        SendMessage(target, item.Message, new IntPtr(unchecked((int)item.VirtualKey)), BuildKeyboardLParam(item.ScanCode, keyUp, extended, system));
        if (keyUp) {
            if (item.Alt && !ownAlt) PostModifier(target, 0x12, true);
            if (item.Shift && !ownShift) PostModifier(target, 0x10, true);
            if ((item.BootstrapControl || item.Control) && !ownControl) PostModifier(target, VK_CONTROL, true);
        }
    }

    private static void PostModifier(IntPtr target, uint key, bool up)
    {
        uint scan = MapVirtualKey(key, 0);
        SendMessage(target, up ? WM_KEYUP : WM_KEYDOWN, new IntPtr(unchecked((int)key)), BuildKeyboardLParam(scan, up, false, false));
    }

    private static IntPtr BuildKeyboardLParam(uint scanCode, bool keyUp, bool extended, bool system)
    {
        long value = 1 | ((long)(scanCode & 0xff) << 16);
        if (extended) value |= 1L << 24;
        if (system) value |= 1L << 29;
        if (keyUp) value |= (1L << 30) | (1L << 31);
        return new IntPtr(unchecked((int)value));
    }

    private static void SendKey(uint virtualKey, uint scanCode, bool keyUp, bool extended)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.U.ki.wVk = (ushort)virtualKey;
        input.U.ki.wScan = (ushort)scanCode;
        input.U.ki.dwFlags = (keyUp ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0);
        input.U.ki.dwExtraInfo = new UIntPtr(unchecked((ulong)OwnInjectionMarker));
        SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
    }

    private static void SendMouse(MirrorEvent item, RECT source, IntPtr target)
    {
        RECT destination;
        if (!GetWindowRect(target, out destination)) return;
        double xRatio = (item.Point.x - source.Left) / (double)Math.Max(1, source.Right - source.Left);
        double yRatio = (item.Point.y - source.Top) / (double)Math.Max(1, source.Bottom - source.Top);
        int x = destination.Left + (int)Math.Round(xRatio * (destination.Right - destination.Left));
        int y = destination.Top + (int)Math.Round(yRatio * (destination.Bottom - destination.Top));
        uint flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
        if (item.Message == WM_LBUTTONDOWN) flags |= MOUSEEVENTF_LEFTDOWN;
        else if (item.Message == WM_LBUTTONUP) flags |= MOUSEEVENTF_LEFTUP;
        else if (item.Message == WM_RBUTTONDOWN) flags |= MOUSEEVENTF_RIGHTDOWN;
        else if (item.Message == WM_RBUTTONUP) flags |= MOUSEEVENTF_RIGHTUP;
        else if (item.Message == WM_MBUTTONDOWN) flags |= MOUSEEVENTF_MIDDLEDOWN;
        else if (item.Message == WM_MBUTTONUP) flags |= MOUSEEVENTF_MIDDLEUP;
        else if (item.Message == WM_MOUSEWHEEL) flags |= MOUSEEVENTF_WHEEL;

        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.U.mi.dx = (int)Math.Round(x * 65535.0 / Math.Max(1, GetSystemMetrics(SM_CXSCREEN) - 1));
        input.U.mi.dy = (int)Math.Round(y * 65535.0 / Math.Max(1, GetSystemMetrics(SM_CYSCREEN) - 1));
        input.U.mi.mouseData = item.Message == WM_MOUSEWHEEL ? (uint)((item.MouseData >> 16) & 0xffff) : 0;
        input.U.mi.dwFlags = flags;
        input.U.mi.dwExtraInfo = new UIntPtr(unchecked((ulong)OwnInjectionMarker));
        SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
    }

    private static void PostMouse(MirrorEvent item, RECT source, IntPtr target)
    {
        RECT destination;
        if (!GetWindowRect(target, out destination)) return;
        double xRatio = (item.Point.x - source.Left) / (double)Math.Max(1, source.Right - source.Left);
        double yRatio = (item.Point.y - source.Top) / (double)Math.Max(1, source.Bottom - source.Top);
        POINT targetScreen = new POINT
        {
            x = destination.Left + (int)Math.Round(xRatio * (destination.Right - destination.Left)),
            y = destination.Top + (int)Math.Round(yRatio * (destination.Bottom - destination.Top))
        };
        if (item.Message == WM_MOUSEWHEEL)
        {
            int delta = (short)((item.MouseData >> 16) & 0xffff);
            IntPtr wheelParam = new IntPtr(unchecked((int)((uint)(ushort)delta << 16)));
            SendMessage(target, WM_MOUSEWHEEL, wheelParam, PackPoint(targetScreen.x, targetScreen.y));
            return;
        }
        POINT client = targetScreen;
        if (!ScreenToClient(target, ref client)) return;
        IntPtr pointParam = PackPoint(client.x, client.y);
        PostMessage(target, WM_MOUSEMOVE, IntPtr.Zero, pointParam);
        IntPtr keyState = IntPtr.Zero;
        if (item.Message == WM_LBUTTONDOWN) keyState = new IntPtr(0x0001);
        else if (item.Message == WM_RBUTTONDOWN) keyState = new IntPtr(0x0002);
        else if (item.Message == WM_MBUTTONDOWN) keyState = new IntPtr(0x0010);
        PostMessage(target, item.Message, keyState, pointParam);
    }

    private static IntPtr PackPoint(int x, int y)
    {
        return new IntPtr(unchecked((int)(((uint)(ushort)y << 16) | (ushort)x)));
    }

    private static void PrepareBackgroundWindow(IntPtr window)
    {
        uint ignored;
        uint targetThread = GetWindowThreadProcessId(window, out ignored);
        uint currentThread = GetCurrentThreadId();
        if (targetThread != 0) AttachThreadInput(currentThread, targetThread, true);
        SetActiveWindow(window);
        SetFocus(window);
        if (targetThread != 0) AttachThreadInput(currentThread, targetThread, false);
    }

    private static void FocusWindow(IntPtr window)
    {
        IntPtr foreground = GetForegroundWindow();
        uint ignoredForegroundPid;
        uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out ignoredForegroundPid);
        uint ignoredTargetPid;
        uint targetThread = GetWindowThreadProcessId(window, out ignoredTargetPid);
        uint currentThread = GetCurrentThreadId();
        if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, true);
        if (targetThread != 0) AttachThreadInput(currentThread, targetThread, true);
        if (IsIconic(window)) ShowWindow(window, SW_RESTORE);
        BringWindowToTop(window);
        SetForegroundWindow(window);
        SetFocus(window);
        if (targetThread != 0) AttachThreadInput(currentThread, targetThread, false);
        if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, false);
        Thread.Sleep(12);
    }

    private static bool IsProcessForeground(int pid)

    {

        IntPtr foreground = GetForegroundWindow();

        if (foreground == IntPtr.Zero) return false;

        uint owner;

        GetWindowThreadProcessId(foreground, out owner);

        return owner == (uint)pid;

    }

    private static bool IsChromeWidgetForPid(IntPtr window, int pid)
    {
        if (window == IntPtr.Zero || !IsWindowVisible(window)) return false;
        uint owner;
        GetWindowThreadProcessId(window, out owner);
        if (owner != (uint)pid) return false;
        StringBuilder className = new StringBuilder(128);
        GetClassName(window, className, className.Capacity);
        return className.ToString().StartsWith("Chrome_WidgetWin_");
    }

    private static IntPtr FindChromeSurfaceAtPoint(int pid, POINT point)
    {
        IntPtr hit = WindowFromPoint(point);
        if (hit == IntPtr.Zero) return IntPtr.Zero;
        IntPtr root = GetAncestor(hit, GA_ROOT);
        if (IsChromeWidgetForPid(root, pid)) return root;
        return IsChromeWidgetForPid(hit, pid) ? hit : IntPtr.Zero;
    }

    private static IntPtr FindMatchingChromePopup(int pid, RECT sourcePopup, IntPtr sourceMain, IntPtr targetMain)
    {
        RECT sourceMainRect;
        RECT targetMainRect;
        if (!GetWindowRect(sourceMain, out sourceMainRect) || !GetWindowRect(targetMain, out targetMainRect)) return IntPtr.Zero;
        for (int attempt = 0; attempt < 12; attempt++)
        {
            IntPtr result = IntPtr.Zero;
            double bestScore = double.MaxValue;
            EnumWindows(delegate(IntPtr window, IntPtr parameter)
            {
                if (window == targetMain || !IsChromeWidgetForPid(window, pid)) return true;
                RECT candidate;
                if (!GetWindowRect(window, out candidate)) return true;
                int sourceWidth = Math.Max(1, sourcePopup.Right - sourcePopup.Left);
                int sourceHeight = Math.Max(1, sourcePopup.Bottom - sourcePopup.Top);
                int candidateWidth = Math.Max(1, candidate.Right - candidate.Left);
                int candidateHeight = Math.Max(1, candidate.Bottom - candidate.Top);
                double sourceRight = (sourceMainRect.Right - sourcePopup.Right) / (double)Math.Max(1, sourceMainRect.Right - sourceMainRect.Left);
                double sourceTop = (sourcePopup.Top - sourceMainRect.Top) / (double)Math.Max(1, sourceMainRect.Bottom - sourceMainRect.Top);
                double candidateRight = (targetMainRect.Right - candidate.Right) / (double)Math.Max(1, targetMainRect.Right - targetMainRect.Left);
                double candidateTop = (candidate.Top - targetMainRect.Top) / (double)Math.Max(1, targetMainRect.Bottom - targetMainRect.Top);
                double score = Math.Abs(candidateWidth - sourceWidth) * 4.0
                    + Math.Abs(candidateHeight - sourceHeight) * 4.0
                    + Math.Abs(candidateRight - sourceRight) * 1200.0
                    + Math.Abs(candidateTop - sourceTop) * 1200.0;
                if (score < bestScore) { bestScore = score; result = window; }
                return true;
            }, IntPtr.Zero);
            if (result != IntPtr.Zero) return result;
            Thread.Sleep(25);
        }
        return IntPtr.Zero;
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

    private delegate IntPtr LowLevelProc(int code, IntPtr wParam, IntPtr lParam);
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }
    [StructLayout(LayoutKind.Sequential)] private struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)] private struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }

    [DllImport("oleacc.dll")] private static extern int AccessibleObjectFromPoint(POINT point, [MarshalAs(UnmanagedType.Interface)] out object accessible, [MarshalAs(UnmanagedType.Struct)] out object child);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelProc callback, IntPtr module, uint threadId);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto)] private static extern IntPtr GetModuleHandle(string moduleName);
    [DllImport("user32.dll")] private static extern int GetMessage(out MSG message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG message);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref MSG message);
    [DllImport("user32.dll")] private static extern void PostQuitMessage(int exitCode);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr SetFocus(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr SetActiveWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder value, int length);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool PostMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool ScreenToClient(IntPtr window, ref POINT point);
    [DllImport("user32.dll")] private static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] private static extern IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
}
