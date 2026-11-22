using System;
using System.Diagnostics;
using System.Text;
using System.Runtime.InteropServices;
using System.Windows.Automation;
using System.Threading;

public class AntigravityVoiceTrigger {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenWindowStation(string a, bool b, uint c);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessWindowStation(IntPtr hWinSta);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenDesktop(string a, uint b, bool c, uint d);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetThreadDesktop(IntPtr hDesktop);

    [DllImport("user32.dll")]
    public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc lpfn, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
    [DllImport("user32.dll")]
    public static extern bool OpenClipboard(IntPtr hWndNewOwner);
    [DllImport("user32.dll")]
    public static extern bool EmptyClipboard();
    [DllImport("user32.dll")]
    public static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);
    [DllImport("user32.dll")]
    public static extern bool CloseClipboard();
    [DllImport("kernel32.dll")]
    public static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GlobalLock(IntPtr hMem);
    [DllImport("kernel32.dll")]
    public static extern bool GlobalUnlock(IntPtr hMem);

    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint KEYEVENTF_KEYUP = 0x0002;

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int SetDefaultEndpointDelegate(IntPtr thisPtr, [MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, int role);

    [ComImport]
    [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumerator { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IMMDeviceCollection ppDevices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
    }

    [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection {
        [PreserveSig] int GetCount(out uint pcDevices);
        [PreserveSig] int Item(uint nDevice, out IMMDevice ppDevice);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice {
        [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        [PreserveSig] int OpenPropertyStore(int stgmAccess, out IPropertyStore ppProperties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
        [PreserveSig] int GetState(out uint pdwState);
    }

    [Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore {
        [PreserveSig] int GetCount(out uint cProps);
        [PreserveSig] int GetAt(uint iProp, out PROPERTYKEY pkey);
        [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROPERTYKEY {
        public Guid fmtid;
        public uint pid;
    }

    [StructLayout(LayoutKind.Explicit)]
    struct PROPVARIANT {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr pwszVal;
    }

    public static bool EnsureCableOutputDefault() {
        try {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            IMMDeviceCollection collection;
            enumerator.EnumAudioEndpoints(1 /* eCapture */, 1 /* DEVICE_STATE_ACTIVE */, out collection);
            uint count;
            collection.GetCount(out count);
            string cableEndpointId = null;
            var pkeyName = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };

            for (uint i = 0; i < count; i++) {
                IMMDevice dev;
                collection.Item(i, out dev);
                string id;
                dev.GetId(out id);
                IPropertyStore store;
                dev.OpenPropertyStore(0, out store);
                PROPVARIANT pv;
                store.GetValue(ref pkeyName, out pv);
                string friendlyName = Marshal.PtrToStringUni(pv.pwszVal);
                if (friendlyName != null && (friendlyName.IndexOf("CABLE Output", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                             friendlyName.IndexOf("VB-Audio Virtual Cable", StringComparison.OrdinalIgnoreCase) >= 0)) {
                    cableEndpointId = id;
                    break;
                }
            }

            if (cableEndpointId == null) {
                Console.WriteLine("CABLE Output capture device not found in active endpoints.");
                return false;
            }

            Type t = Type.GetTypeFromCLSID(new Guid("294935CE-F637-4E7C-A41B-AB255460B862"));
            if (t == null) return false;
            object obj = Activator.CreateInstance(t);
            IntPtr pUnk = Marshal.GetIUnknownForObject(obj);
            Guid g = new Guid("568b9108-44bf-40b4-9006-86afe5b5a620");
            IntPtr pIface;
            Marshal.QueryInterface(pUnk, ref g, out pIface);

            IntPtr vtable = Marshal.ReadIntPtr(pIface);
            IntPtr fn = Marshal.ReadIntPtr(vtable, 12 * IntPtr.Size);
            var setDefaultEndpoint = (SetDefaultEndpointDelegate)Marshal.GetDelegateForFunctionPointer(fn, typeof(SetDefaultEndpointDelegate));

            setDefaultEndpoint(pIface, cableEndpointId, 0 /* eConsole */);
            setDefaultEndpoint(pIface, cableEndpointId, 1 /* eMultimedia */);
            setDefaultEndpoint(pIface, cableEndpointId, 2 /* eCommunications */);

            Marshal.Release(pIface);
            Marshal.Release(pUnk);
            Console.WriteLine("AUTO_SWITCH_MIC: Default recording endpoint set to CABLE Output (" + cableEndpointId + ")");
            return true;
        } catch (Exception ex) {
            Console.WriteLine("EnsureCableOutputDefault failed: " + ex.Message);
            return false;
        }
    }

    public static bool ClickElement(AutomationElement el) {
        if (el == null) return false;
        try {
            object patternObj;
            if (el.TryGetCurrentPattern(InvokePattern.Pattern, out patternObj)) {
                ((InvokePattern)patternObj).Invoke();
                return true;
            }
        } catch { }

        try {
            var rect = el.Current.BoundingRectangle;
            if (rect.Width > 0 && rect.Height > 0) {
                int cx = (int)(rect.X + rect.Width / 2);
                int cy = (int)(rect.Y + rect.Height / 2);
                SetCursorPos(cx, cy);
                mouse_event(MOUSEEVENTF_LEFTDOWN, (uint)cx, (uint)cy, 0, 0);
                Thread.Sleep(40);
                mouse_event(MOUSEEVENTF_LEFTUP, (uint)cx, (uint)cy, 0, 0);
                return true;
            }
        } catch { }
        return false;
    }

    private static bool SetClipboardUnicode(string text) {
        if (string.IsNullOrEmpty(text)) return false;
        IntPtr hGlobal = IntPtr.Zero;
        try {
            if (!OpenClipboard(IntPtr.Zero)) return false;
            try {
                EmptyClipboard();
                byte[] bytes = Encoding.Unicode.GetBytes(text + "\0");
                hGlobal = GlobalAlloc(0x0042 /* GHND */, (UIntPtr)bytes.Length);
                if (hGlobal == IntPtr.Zero) return false;
                IntPtr locked = GlobalLock(hGlobal);
                if (locked == IntPtr.Zero) return false;
                try {
                    Marshal.Copy(bytes, 0, locked, bytes.Length);
                } finally {
                    GlobalUnlock(hGlobal);
                }
                if (SetClipboardData(13 /* CF_UNICODETEXT */, hGlobal) != IntPtr.Zero) {
                    hGlobal = IntPtr.Zero; // clipboard now owns hGlobal
                    return true;
                }
                return false;
            } finally {
                CloseClipboard();
            }
        } catch {
            return false;
        }
    }

    private static void SendCtrlKey(byte vk, byte scan) {
        keybd_event(0x11 /* VK_CONTROL */, 0x1D, 0, 0);
        Thread.Sleep(35);
        keybd_event(vk, scan, 0, 0);
        Thread.Sleep(35);
        keybd_event(vk, scan, KEYEVENTF_KEYUP, 0);
        Thread.Sleep(35);
        keybd_event(0x11 /* VK_CONTROL */, 0x1D, KEYEVENTF_KEYUP, 0);
        Thread.Sleep(40);
    }

    private static AutomationElement FindVisibleMatch(AutomationElement root, string convTitle, params ControlType[] types) {
        if (types == null || types.Length == 0) {
            types = new[] { ControlType.Hyperlink, ControlType.ListItem, ControlType.TreeItem };
        }
        foreach (var ct in types) {
            AutomationElementCollection items;
            try {
                items = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ct));
            } catch {
                continue;
            }
            for (int i = 0; i < items.Count; i++) {
                var el = items[i];
                try {
                    string name = el.Current.Name ?? "";
                    if (name.Length > 0 && name.IndexOf(convTitle, StringComparison.OrdinalIgnoreCase) >= 0) {
                        var rect = el.Current.BoundingRectangle;
                        if (rect.Width > 0 && rect.Height > 0) return el;
                    }
                } catch { }
            }
        }
        return null;
    }

    private static bool TryExpandProjectAndSeeAll(AutomationElement root, string projectName) {
        bool acted = false;
        try {
            if (!string.IsNullOrEmpty(projectName) && !projectName.Equals("General", StringComparison.OrdinalIgnoreCase)) {
                var projCond = new OrCondition(
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TreeItem),
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Group)
                );
                var nodes = root.FindAll(TreeScope.Descendants, projCond);
                for (int i = 0; i < nodes.Count; i++) {
                    var el = nodes[i];
                    try {
                        string name = el.Current.Name ?? "";
                        if (name.IndexOf(projectName, StringComparison.OrdinalIgnoreCase) < 0) continue;
                        object expObj;
                        if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out expObj)) {
                            var exp = (ExpandCollapsePattern)expObj;
                            if (exp.Current.ExpandCollapseState == ExpandCollapseState.Collapsed) {
                                Console.WriteLine("EXPANDING_PROJECT: " + name);
                                exp.Expand();
                                acted = true;
                                break;
                            }
                        } else if (ClickElement(el)) {
                            Console.WriteLine("CLICKED_PROJECT_NODE: " + name);
                            acted = true;
                            break;
                        }
                    } catch { }
                }
            }

            if (acted) Thread.Sleep(250);

            var moreCond = new OrCondition(
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Hyperlink)
            );
            var btns = root.FindAll(TreeScope.Descendants, moreCond);
            for (int i = 0; i < btns.Count; i++) {
                var b = btns[i];
                try {
                    string name = (b.Current.Name ?? "").Trim();
                    if (name.Equals("See all", StringComparison.OrdinalIgnoreCase) ||
                        name.StartsWith("See all", StringComparison.OrdinalIgnoreCase) ||
                        name.Equals("Show more", StringComparison.OrdinalIgnoreCase)) {
                        var rect = b.Current.BoundingRectangle;
                        if (rect.Width > 0 && rect.Height > 0 && ClickElement(b)) {
                            Console.WriteLine("CLICKED_SEE_ALL: " + name);
                            acted = true;
                        }
                    }
                } catch { }
            }
        } catch { }
        return acted;
    }

    private static bool TrySearchConversations(AutomationElement root, string convTitle) {
        try {
            AutomationElement searchBox = null;
            var edits = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
            for (int i = 0; i < edits.Count; i++) {
                var ed = edits[i];
                try {
                    string name = (ed.Current.Name ?? "") + " " + (ed.Current.AutomationId ?? "");
                    if (name.IndexOf("Search conversations", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        name.IndexOf("Search all conversations", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        name.IndexOf("Search", StringComparison.OrdinalIgnoreCase) >= 0) {
                        var rect = ed.Current.BoundingRectangle;
                        if (rect.Width > 0 && rect.Height > 0) {
                            searchBox = ed;
                            break;
                        }
                    }
                } catch { }
            }

            if (searchBox == null) {
                var btns = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button));
                AutomationElement searchBtn = null;
                for (int i = 0; i < btns.Count; i++) {
                    var b = btns[i];
                    try {
                        string name = b.Current.Name ?? "";
                        if (name.IndexOf("Search conversations", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            name.IndexOf("Search all conversations", StringComparison.OrdinalIgnoreCase) >= 0) {
                            searchBtn = b;
                            break;
                        }
                    } catch { }
                }
                if (searchBtn != null) {
                    Console.WriteLine("OPENING_SEARCH_CONVERSATIONS: " + searchBtn.Current.Name);
                    ClickElement(searchBtn);
                    Thread.Sleep(280);
                    edits = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
                    for (int i = 0; i < edits.Count; i++) {
                        var ed = edits[i];
                        try {
                            var rect = ed.Current.BoundingRectangle;
                            string name = (ed.Current.Name ?? "") + " " + (ed.Current.AutomationId ?? "");
                            if (rect.Width > 0 && rect.Height > 0 &&
                                name.IndexOf("Search", StringComparison.OrdinalIgnoreCase) >= 0) {
                                searchBox = ed;
                                break;
                            }
                        } catch { }
                    }
                }
            }

            if (searchBox == null) return false;

            try { searchBox.SetFocus(); } catch { }
            ClickElement(searchBox);
            Thread.Sleep(120);

            bool textSet = false;
            try {
                object valObj;
                if (searchBox.TryGetCurrentPattern(ValuePattern.Pattern, out valObj)) {
                    var vp = (ValuePattern)valObj;
                    if (!vp.Current.IsReadOnly) {
                        vp.SetValue(convTitle);
                        textSet = true;
                    }
                }
            } catch { }

            if (!textSet && SetClipboardUnicode(convTitle)) {
                SendCtrlKey(0x41 /* 'A' */, 0x1E);
                SendCtrlKey(0x56 /* 'V' */, 0x2F);
                textSet = true;
            }

            if (!textSet) return false;

            Thread.Sleep(380);
            var hit = FindVisibleMatch(root, convTitle, ControlType.Hyperlink, ControlType.ListItem, ControlType.TreeItem, ControlType.Button);
            if (hit != null) {
                bool ok = ClickElement(hit);
                Console.WriteLine(string.Format("CLICKED_VIA_SEARCH: '{0}' (success: {1})", hit.Current.Name, ok));
                Thread.Sleep(350);
                return ok;
            }
        } catch (Exception ex) {
            Console.WriteLine("TrySearchConversations err: " + ex.Message);
        }
        return false;
    }

    public static bool SwitchToConversation(AutomationElement root, string convTitle, string projectName) {
        if (string.IsNullOrEmpty(convTitle)) return false;
        Console.WriteLine(string.Format("SWITCHING_CONVERSATION_TO: {0} (project={1})", convTitle, projectName ?? ""));

        // Tier 1: Direct visible conversation link/item
        var targetLink = FindVisibleMatch(root, convTitle, ControlType.Hyperlink, ControlType.ListItem, ControlType.TreeItem);
        if (targetLink != null) {
            bool ok = ClickElement(targetLink);
            Console.WriteLine(string.Format("CLICKED_CONVERSATION_LINK: '{0}' (success: {1})", targetLink.Current.Name, ok));
            Thread.Sleep(350);
            return ok;
        }

        // Tier 2: Expand collapsed project or click "See all", then retry Tier 1
        if (TryExpandProjectAndSeeAll(root, projectName)) {
            Thread.Sleep(300);
            targetLink = FindVisibleMatch(root, convTitle, ControlType.Hyperlink, ControlType.ListItem, ControlType.TreeItem);
            if (targetLink != null) {
                bool ok = ClickElement(targetLink);
                Console.WriteLine(string.Format("CLICKED_AFTER_EXPAND: '{0}' (success: {1})", targetLink.Current.Name, ok));
                Thread.Sleep(350);
                return ok;
            }
        }

        // Tier 3: Use Antigravity's Search Conversations box
        if (TrySearchConversations(root, convTitle)) {
            return true;
        }

        Console.WriteLine("CONVERSATION_LINK_NOT_FOUND: " + convTitle);
        return false;
    }

    public static void CheckAndFixMicWarning(AutomationElement root) {
        try {
            Thread.Sleep(300);
            // Search for "Switch mic" button
            Condition btnCond = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button);
            var buttons = root.FindAll(TreeScope.Descendants, btnCond);
            AutomationElement switchMicBtn = null;

            for (int i = 0; i < buttons.Count; i++) {
                var b = buttons[i];
                string name = b.Current.Name ?? "";
                if (name.IndexOf("Switch mic", StringComparison.OrdinalIgnoreCase) >= 0) {
                    switchMicBtn = b;
                    break;
                }
            }

            if (switchMicBtn != null) {
                Console.WriteLine("DETECTED_MIC_WARNING: Clicking 'Switch mic'...");
                ClickElement(switchMicBtn);
                Thread.Sleep(250);

                // Now look for CABLE Output menu item
                var menuItems = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem));
                AutomationElement cableItem = null;
                for (int m = 0; m < menuItems.Count; m++) {
                    var item = menuItems[m];
                    string mName = item.Current.Name ?? "";
                    if (mName.IndexOf("CABLE Output", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        mName.IndexOf("VB-Audio", StringComparison.OrdinalIgnoreCase) >= 0) {
                        cableItem = item;
                        break;
                    }
                }

                if (cableItem != null) {
                    ClickElement(cableItem);
                    Console.WriteLine("CLICKED_CABLE_OUTPUT_MIC_IN_MENU!");
                } else {
                    // Try looking in any control type for CABLE Output
                    var anyCable = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.NameProperty, "CABLE Output (VB-Audio Virtual Cable)"));
                    if (anyCable != null) {
                        ClickElement(anyCable);
                        Console.WriteLine("CLICKED_ANY_CABLE_OUTPUT_ELEMENT!");
                    }
                }
            }
        } catch (ElementNotAvailableException) {
            // Popup dismissed smoothly after clicking mic; ignore cleanly
        } catch (Exception ex) {
            if (!string.IsNullOrWhiteSpace(ex.Message))
                Console.WriteLine("CheckAndFixMicWarning err: " + ex.Message);
        }
    }

    [STAThread]
    public static int Main(string[] args) {
        string action = (args.Length > 0 ? args[0].ToLowerInvariant() : "toggle");
        string convTitle = (args.Length > 1 ? args[1] : "");
        string projectName = (args.Length > 2 ? args[2] : "");

        if (action != "stop") {
            EnsureCableOutputDefault();
        }

        IntPtr hWinsta = OpenWindowStation("WinSta0", false, 0x00020000 | 0x037F);
        if (hWinsta != IntPtr.Zero) SetProcessWindowStation(hWinsta);
        IntPtr hDesktop = OpenDesktop("Default", 0, false, 0x01FF);
        if (hDesktop != IntPtr.Zero) SetThreadDesktop(hDesktop);

        // Find Antigravity window
        IntPtr targetHwnd = IntPtr.Zero;
        EnumDesktopWindows(hDesktop, (hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder sbClass = new StringBuilder(256);
            GetClassName(hWnd, sbClass, 256);
            if (sbClass.ToString() != "Chrome_WidgetWin_1") return true;

            StringBuilder sbTitle = new StringBuilder(512);
            GetWindowText(hWnd, sbTitle, 512);
            string title = sbTitle.ToString();

            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            try {
                Process p = Process.GetProcessById((int)pid);
                if (p.ProcessName.IndexOf("Antigravity", StringComparison.OrdinalIgnoreCase) >= 0 && title.Length > 0) {
                    targetHwnd = hWnd;
                    return false;
                }
            } catch { }
            return true;
        }, IntPtr.Zero);

        if (targetHwnd == IntPtr.Zero) {
            Console.WriteLine("ANTIGRAVITY_WINDOW_NOT_FOUND");
            return 2;
        }

        Console.WriteLine(string.Format("FOUND_WINDOW: 0x{0:X}", targetHwnd.ToInt64()));

        // Restore and focus
        ShowWindow(targetHwnd, 9 /* SW_RESTORE */);
        BringWindowToTop(targetHwnd);
        SetForegroundWindow(targetHwnd);

        AutomationElement root = AutomationElement.FromHandle(targetHwnd);
        if (root == null) {
            Console.WriteLine("UIA_ROOT_NULL");
            return 3;
        }

        // If action is "select", just switch to that conversation
        if (action == "select") {
            bool switched = SwitchToConversation(root, convTitle, projectName);
            return switched ? 0 : 1;
        }

        // If conversation title is provided and action is start/toggle, switch to it first
        if (!string.IsNullOrEmpty(convTitle)) {
            SwitchToConversation(root, convTitle, projectName);
        }

        Condition cond = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button);
        AutomationElementCollection buttons = root.FindAll(TreeScope.Descendants, cond);

        AutomationElement startBtn = null;
        AutomationElement endBtn = null;

        for (int i = 0; i < buttons.Count; i++) {
            try {
                var b = buttons[i];
                string name = b.Current.Name ?? "";
                if (name == "Start Voice mode" || name == "Start Live Chat") {
                    startBtn = b;
                } else if (name == "End Voice mode" || name == "End Live chat") {
                    endBtn = b;
                }
            } catch { }
        }

        AutomationElement btnToClick = null;
        if (action == "start") {
            btnToClick = startBtn;
        } else if (action == "stop") {
            btnToClick = endBtn;
        } else {
            // toggle
            btnToClick = (endBtn != null ? endBtn : startBtn);
        }

        if (btnToClick == null) {
            Console.WriteLine(string.Format("BUTTON_NOT_FOUND: action={0}, startBtn={1}, endBtn={2}",
                action, (startBtn != null), (endBtn != null)));
            return 4;
        }

        string btnName = "";
        try { btnName = btnToClick.Current.Name ?? ""; } catch { }
        Console.WriteLine(string.Format("CLICKING: {0}", btnName));

        bool clicked = ClickElement(btnToClick);
        if (clicked) {
            Console.WriteLine("CLICKED_BUTTON: " + btnName);
            if (btnToClick == startBtn) {
                CheckAndFixMicWarning(root);
            }
            return 0;
        }
        return 5;
    }
}
