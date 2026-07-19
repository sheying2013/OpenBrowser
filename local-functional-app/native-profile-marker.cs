using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

internal sealed class ProfileMarker : Form
{
    private const int GWL_HWNDPARENT = -8;
    private const int WS_EX_TOOLWINDOW = 0x00000080;
    private const int WS_EX_TRANSPARENT = 0x00000020;
    private const int WS_EX_NOACTIVATE = 0x08000000;
    private const int WM_NCHITTEST = 0x0084;
    private const int HTTRANSPARENT = -1;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_SHOWWINDOW = 0x0040;
    private const uint SWP_NOSENDCHANGING = 0x0400;
    private static readonly IntPtr HWND_TOP = IntPtr.Zero;

    private readonly int browserPid;
    private readonly string profileId;
    private readonly Timer timer;
    private IntPtr browserWindow;

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }

    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hwnd, StringBuilder className, int maxCount);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    public ProfileMarker(int pid, string id)
    {
        browserPid = pid;
        profileId = id;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.FromArgb(18, 58, 140);
        ClientSize = new Size(86, 24);
        Font = new Font("Microsoft YaHei UI", 8.25f, FontStyle.Bold, GraphicsUnit.Point);
        timer = new Timer { Interval = 120 };
        timer.Tick += delegate { FollowBrowser(); };
        Shown += delegate { FollowBrowser(); timer.Start(); };
        FormClosed += delegate { timer.Stop(); timer.Dispose(); };
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams value = base.CreateParams;
            value.ExStyle |= WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE;
            return value;
        }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.Clear(BackColor);
        TextRenderer.DrawText(e.Graphics, profileId, Font, ClientRectangle, Color.White,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == WM_NCHITTEST) { message.Result = new IntPtr(HTTRANSPARENT); return; }
        base.WndProc(ref message);
    }

    private IntPtr FindBrowserWindow()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hwnd, IntPtr unused)
        {
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            if (pid != (uint)browserPid || !IsWindowVisible(hwnd)) return true;
            StringBuilder className = new StringBuilder(128);
            GetClassName(hwnd, className, className.Capacity);
            if (!className.ToString().StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal)) return true;
            found = hwnd;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    private void FollowBrowser()
    {
        try
        {
            Process browser = Process.GetProcessById(browserPid);
            if (browser.HasExited) { Close(); return; }
        }
        catch { Close(); return; }

        if (browserWindow == IntPtr.Zero || !IsWindow(browserWindow))
        {
            browserWindow = FindBrowserWindow();
            if (browserWindow != IntPtr.Zero) SetWindowLongPtr(Handle, GWL_HWNDPARENT, browserWindow);
        }
        Rect rect;
        if (browserWindow == IntPtr.Zero || IsIconic(browserWindow) || !GetWindowRect(browserWindow, out rect))
        {
            Hide();
            return;
        }

        int x = rect.Left + 91;
        int y = rect.Top + 38;
        SetWindowPos(Handle, HWND_TOP, x, y, 86, 24, SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOSENDCHANGING);
    }

    [STAThread]
    private static void Main(string[] args)
    {
        int pid;
        if (args.Length < 2 || !int.TryParse(args[0], out pid) || pid <= 0) return;
        SetProcessDPIAware();
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new ProfileMarker(pid, args[1]));
    }
}