using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Web.Script.Serialization;
using System.Windows.Forms;

class EufyViewTray : Form
{
    private NotifyIcon trayIcon;
    private Process serverProcess;
    private string installDir;
    private string nodeExe;
    private int port = 3001;
    private StatusForm statusForm;
    private DevicesForm devicesForm;

    [STAThread]
    static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new EufyViewTray());
    }

    public EufyViewTray()
    {
        installDir = AppDomain.CurrentDomain.BaseDirectory;
        nodeExe = Path.Combine(installDir, "node", "node.exe");

        // Read port from config.json
        string configPath = Path.Combine(installDir, "config.json");
        if (File.Exists(configPath))
        {
            try
            {
                string json = File.ReadAllText(configPath);
                int idx = json.IndexOf("\"port\"");
                if (idx >= 0)
                {
                    int colon = json.IndexOf(":", idx);
                    int start = colon + 1;
                    while (start < json.Length && !char.IsDigit(json[start])) start++;
                    int end = start;
                    while (end < json.Length && char.IsDigit(json[end])) end++;
                    if (end > start)
                    {
                        int parsed;
                        if (int.TryParse(json.Substring(start, end - start), out parsed))
                            port = parsed;
                    }
                }
            }
            catch { }
        }

        // Hide the form window
        this.WindowState = FormWindowState.Minimized;
        this.ShowInTaskbar = false;
        this.Visible = false;

        // Context menu
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open in Browser", null, OnOpenBrowser);
        menu.Items.Add("Status...", null, OnStatus);
        menu.Items.Add("Pair a TV...", null, OnPairTv);
        menu.Items.Add("Install to Smart Devices...", null, OnInstallDevices);
        menu.Items.Add("Set Access Password...", null, OnSetPassword);
        menu.Items.Add("-");
        menu.Items.Add("Check for Updates...", null, OnCheckUpdates);
        menu.Items.Add("Restart Server", null, OnRestart);
        menu.Items.Add("-");
        menu.Items.Add("Exit", null, OnExit);

        // Tray icon
        string iconPath = Path.Combine(installDir, "tray-icon.ico");
        Icon appIcon;
        if (File.Exists(iconPath))
            appIcon = new Icon(iconPath);
        else
            appIcon = SystemIcons.Application;

        trayIcon = new NotifyIcon()
        {
            Icon = appIcon,
            ContextMenuStrip = menu,
            Text = "EufyView",
            Visible = true
        };

        trayIcon.DoubleClick += OnOpenBrowser;

        StartServer();
    }

    private void StartServer()
    {
        StopServer();

        var startInfo = new ProcessStartInfo()
        {
            FileName = nodeExe,
            Arguments = "main.js",
            WorkingDirectory = installDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };

        // Ensure bundled node and ffmpeg are on PATH
        string nodePath = Path.Combine(installDir, "node");
        string ffmpegPath = Path.Combine(installDir, "ffmpeg");
        string currentPath = Environment.GetEnvironmentVariable("PATH") ?? "";
        startInfo.EnvironmentVariables["PATH"] = nodePath + ";" + ffmpegPath + ";" + currentPath;

        // Set PORT for the server
        startInfo.EnvironmentVariables["PORT"] = port.ToString();

        // Set FFMPEG_PATH so the server can find ffmpeg.exe
        startInfo.EnvironmentVariables["FFMPEG_PATH"] = Path.Combine(ffmpegPath, "ffmpeg.exe");

        try
        {
            serverProcess = Process.Start(startInfo);
            trayIcon.Text = "EufyView - Running";
        }
        catch (Exception ex)
        {
            trayIcon.Text = "EufyView - Error";
            MessageBox.Show("Failed to start server: " + ex.Message, "EufyView",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void StopServer()
    {
        if (serverProcess != null && !serverProcess.HasExited)
        {
            try
            {
                // Kill the process tree (node spawns child processes)
                var kill = new ProcessStartInfo("taskkill.exe", "/pid " + serverProcess.Id + " /t /f")
                {
                    CreateNoWindow = true,
                    UseShellExecute = false
                };
                var killProc = Process.Start(kill);
                if (killProc != null) killProc.WaitForExit(5000);
            }
            catch { }
            serverProcess = null;
        }
    }

    private void OnOpenBrowser(object sender, EventArgs e)
    {
        try
        {
            Process.Start(new ProcessStartInfo("http://localhost:" + port) { UseShellExecute = true });
        }
        catch { }
    }

    private void OnStatus(object sender, EventArgs e)
    {
        if (statusForm == null || statusForm.IsDisposed)
        {
            statusForm = new StatusForm(port);
            statusForm.Show();
        }
        else
        {
            statusForm.WindowState = FormWindowState.Normal;
            statusForm.Activate();
        }
    }

    private void OnPairTv(object sender, EventArgs e)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://localhost:" + port + "/auth/pair-code/local");
            req.Timeout = 4000;
            string code = null;
            string expires = "5 minutes";
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var sr = new StreamReader(resp.GetResponseStream()))
            {
                var m = (Dictionary<string, object>)new JavaScriptSerializer().DeserializeObject(sr.ReadToEnd());
                if (m.ContainsKey("code") && m["code"] != null) code = m["code"].ToString();
                if (m.ContainsKey("expiresInSec"))
                {
                    try { expires = (Convert.ToInt32(m["expiresInSec"]) / 60) + " minutes"; } catch { }
                }
            }
            if (string.IsNullOrEmpty(code))
                MessageBox.Show("Could not create a pairing code.", "EufyView", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            else
                MessageBox.Show(
                    "On your TV, open the EufyView TV app and enter this pairing code:\n\n          " + code +
                    "\n\nIt expires in about " + expires + ".",
                    "Pair a TV", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show("Could not reach the server to create a code.\n" + ex.Message,
                "EufyView", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void OnCheckUpdates(object sender, EventArgs e)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://localhost:" + port + "/updates/check?force=1");
            req.Timeout = 15000;
            Dictionary<string, object> m;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var sr = new StreamReader(resp.GetResponseStream()))
                m = (Dictionary<string, object>)new JavaScriptSerializer().DeserializeObject(sr.ReadToEnd());

            string current = (m.ContainsKey("current") && m["current"] != null) ? m["current"].ToString() : "?";
            bool updateAvailable = m.ContainsKey("updateAvailable") && Convert.ToBoolean(m["updateAvailable"]);
            bool canSelf = m.ContainsKey("canSelfUpdate") && Convert.ToBoolean(m["canSelfUpdate"]);
            string latestVer = "?";
            if (m.ContainsKey("latest") && m["latest"] is Dictionary<string, object>)
            {
                var lt = (Dictionary<string, object>)m["latest"];
                if (lt.ContainsKey("version") && lt["version"] != null) latestVer = lt["version"].ToString();
            }

            if (!updateAvailable)
            {
                MessageBox.Show("You're on the latest version (v" + current + ").",
                    "EufyView", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (!canSelf)
            {
                MessageBox.Show("Update v" + latestVer + " is available, but this install can't " +
                    "update itself automatically. Update it manually.",
                    "EufyView", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            var ans = MessageBox.Show(
                "EufyView v" + latestVer + " is available.\r\n\r\n" +
                "Install it now? The server and this tray will restart automatically.",
                "Update available", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (ans != DialogResult.Yes) return;

            var areq = (HttpWebRequest)WebRequest.Create("http://localhost:" + port + "/updates/apply");
            areq.Method = "POST";
            areq.ContentLength = 0;
            areq.Timeout = 60000;
            using (var aresp = (HttpWebResponse)areq.GetResponse())
            using (var sr = new StreamReader(aresp.GetResponseStream())) { sr.ReadToEnd(); }
            MessageBox.Show("Update started. The server will download and install it, then restart automatically.",
                "EufyView", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show("Could not check for updates.\r\n" + ex.Message,
                "EufyView", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void OnInstallDevices(object sender, EventArgs e)
    {
        if (devicesForm == null || devicesForm.IsDisposed)
        {
            devicesForm = new DevicesForm(port);
            devicesForm.Show();
        }
        else
        {
            devicesForm.WindowState = FormWindowState.Normal;
            devicesForm.Activate();
        }
    }

    private void OnSetPassword(object sender, EventArgs e)
    {
        using (var f = new PasswordForm(port))
        {
            if (f.ShowDialog() == DialogResult.OK)
            {
                var r = MessageBox.Show(
                    "Password saved. It takes effect after the server restarts.\r\n\r\nRestart the server now?",
                    "EufyView", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
                if (r == DialogResult.Yes)
                {
                    trayIcon.Text = "EufyView - Restarting...";
                    StartServer();
                }
            }
        }
    }

    private void OnRestart(object sender, EventArgs e)
    {
        trayIcon.Text = "EufyView - Restarting...";
        StartServer();
    }

    private void OnExit(object sender, EventArgs e)
    {
        StopServer();
        trayIcon.Visible = false;
        trayIcon.Dispose();
        Application.Exit();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        StopServer();
        trayIcon.Visible = false;
        trayIcon.Dispose();
        base.OnFormClosing(e);
    }
}

// A small window that polls the server's localhost-only /status endpoint and
// shows Eufy connection, sync counts, remote URL, version/uptime and the last
// detection. Refreshes every few seconds; Copy/Open helpers for URL + logs.
class StatusForm : Form
{
    private int port;
    private Label body;
    private System.Windows.Forms.Timer timer;
    private string remoteUrl = "";
    private string logFile = "";

    public StatusForm(int port)
    {
        this.port = port;
        Text = "EufyView Status";
        Width = 470;
        Height = 360;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;

        body = new Label() { Left = 16, Top = 12, Width = 430, Height = 240, Font = new Font("Consolas", 10) };
        Controls.Add(body);

        var copyBtn = new Button() { Text = "Copy remote URL", Left = 16, Top = 268, Width = 150 };
        copyBtn.Click += (s, e) => { try { if (!string.IsNullOrEmpty(remoteUrl)) Clipboard.SetText(remoteUrl); } catch { } };
        Controls.Add(copyBtn);

        var logsBtn = new Button() { Text = "Open logs", Left = 176, Top = 268, Width = 110 };
        logsBtn.Click += (s, e) => { try { if (!string.IsNullOrEmpty(logFile)) Process.Start(new ProcessStartInfo(logFile) { UseShellExecute = true }); } catch { } };
        Controls.Add(logsBtn);

        var refreshBtn = new Button() { Text = "Refresh", Left = 356, Top = 268, Width = 90 };
        refreshBtn.Click += (s, e) => Reload();
        Controls.Add(refreshBtn);

        timer = new System.Windows.Forms.Timer() { Interval = 3000 };
        timer.Tick += (s, e) => Reload();
        timer.Start();
        Reload();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        timer.Stop();
        base.OnFormClosing(e);
    }

    private void Reload()
    {
        var t = new System.Threading.Thread(() =>
        {
            string text;
            string ru = "";
            string lf = "";
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://localhost:" + port + "/status");
                req.Timeout = 2500;
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(resp.GetResponseStream()))
                {
                    var ser = new JavaScriptSerializer();
                    var m = (Dictionary<string, object>)ser.DeserializeObject(sr.ReadToEnd());
                    ru = Str(m, "remoteUrl");
                    lf = Str(m, "logFile");
                    text = Format(m);
                }
            }
            catch (Exception ex)
            {
                text = "Server not responding on port " + port + ".\r\n\r\n" + ex.Message;
            }
            try { this.Invoke((MethodInvoker)(() => { body.Text = text; remoteUrl = ru; logFile = lf; })); }
            catch { }
        });
        t.IsBackground = true;
        t.Start();
    }

    private static string Str(Dictionary<string, object> m, string k)
    {
        return (m.ContainsKey(k) && m[k] != null) ? m[k].ToString() : "";
    }

    private static string Format(Dictionary<string, object> m)
    {
        bool connected = m.ContainsKey("connected") && Convert.ToBoolean(m["connected"]);
        string eufy = connected ? "Connected" : "DISCONNECTED";
        long up = 0;
        try { up = Convert.ToInt64(m["uptimeSec"]); } catch { }
        string uptime = (up / 3600) + "h " + ((up % 3600) / 60) + "m";
        string remote = Str(m, "remoteUrl");
        if (remote == "") remote = "(local only)";
        string last = "none yet";
        if (m.ContainsKey("lastDetection") && m["lastDetection"] is Dictionary<string, object>)
        {
            var d = (Dictionary<string, object>)m["lastDetection"];
            last = Str(d, "label") + " - " + Str(d, "camera");
        }
        string login = "open (no login)";
        if (m.ContainsKey("auth") && m["auth"] is Dictionary<string, object>)
        {
            var a = (Dictionary<string, object>)m["auth"];
            string mode = Str(a, "mode");
            if (mode == "password") login = "password (user: " + Str(a, "username") + ")";
            else login = "none set";
        }
        return
            "Eufy:        " + eufy + "\r\n" +
            "Cameras:     " + Str(m, "cameras") + "\r\n" +
            "Stations:    " + Str(m, "stations") + "\r\n" +
            "Houses:      " + Str(m, "houses") + "\r\n\r\n" +
            "Remote URL:  " + remote + "\r\n" +
            "Network:     " + (Str(m, "networkMode") == "" ? "direct/local" : Str(m, "networkMode")) + "\r\n" +
            "Login:       " + login + "\r\n\r\n" +
            "Version:     " + Str(m, "version") + "\r\n" +
            "Uptime:      " + uptime + "\r\n" +
            "Last event:  " + last;
    }
}

// "Install to Smart Devices" window: scans the LAN for Android/Fire TVs and
// installs + auto-pairs the TV app over ADB via the server's /devices endpoints.
class DevicesForm : Form
{
    private int port;
    private ListView list;
    private Button scanBtn;
    private Button installBtn;
    private System.Windows.Forms.Timer timer;

    public DevicesForm(int port)
    {
        this.port = port;
        Text = "EufyView - Install to Smart Devices";
        Width = 580;
        Height = 420;
        StartPosition = FormStartPosition.CenterScreen;

        var info = new Label()
        {
            Left = 12, Top = 10, Width = 548, Height = 34,
            Text = "Turn on ADB debugging in each TV's Developer options, then Scan. Installing pairs the TV automatically (no code) - accept the prompt on the TV the first time."
        };
        Controls.Add(info);

        list = new ListView() { Left = 12, Top = 50, Width = 548, Height = 288, View = View.Details, FullRowSelect = true, MultiSelect = false };
        list.Columns.Add("IP", 120);
        list.Columns.Add("Device", 260);
        list.Columns.Add("Status", 160);
        Controls.Add(list);

        scanBtn = new Button() { Left = 12, Top = 346, Width = 100, Text = "Scan" };
        scanBtn.Click += (s, e) => Scan();
        Controls.Add(scanBtn);

        installBtn = new Button() { Left = 122, Top = 346, Width = 150, Text = "Install selected" };
        installBtn.Click += (s, e) => InstallSelected();
        Controls.Add(installBtn);

        timer = new System.Windows.Forms.Timer() { Interval = 1500 };
        timer.Tick += (s, e) => PollStatus();

        Scan();
    }

    protected override void OnFormClosing(FormClosingEventArgs e) { timer.Stop(); base.OnFormClosing(e); }

    private string httpGet(string path)
    {
        var req = (HttpWebRequest)WebRequest.Create("http://localhost:" + port + path);
        req.Timeout = 20000;
        using (var resp = (HttpWebResponse)req.GetResponse())
        using (var sr = new StreamReader(resp.GetResponseStream())) return sr.ReadToEnd();
    }

    private void httpPost(string path, string json)
    {
        var req = (HttpWebRequest)WebRequest.Create("http://localhost:" + port + path);
        req.Method = "POST"; req.ContentType = "application/json"; req.Timeout = 10000;
        var bytes = System.Text.Encoding.UTF8.GetBytes(json);
        using (var s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);
        using (var resp = (HttpWebResponse)req.GetResponse()) { }
    }

    private static string Str(Dictionary<string, object> m, string k) { return (m.ContainsKey(k) && m[k] != null) ? m[k].ToString() : ""; }

    private void Scan()
    {
        scanBtn.Enabled = false;
        var t = new System.Threading.Thread(() =>
        {
            string err = null;
            object[] devices = null;
            try
            {
                var m = (Dictionary<string, object>)new JavaScriptSerializer().DeserializeObject(httpGet("/devices/scan"));
                if (m.ContainsKey("devices") && m["devices"] is object[]) devices = (object[])m["devices"];
            }
            catch (Exception ex) { err = ex.Message; }
            try
            {
                this.Invoke((MethodInvoker)(() =>
                {
                    scanBtn.Enabled = true;
                    list.Items.Clear();
                    if (err != null) { list.Items.Add(new ListViewItem(new[] { "", "Scan failed", err })); return; }
                    if (devices == null || devices.Length == 0) { list.Items.Add(new ListViewItem(new[] { "", "No TVs found - enable ADB debugging", "" })); return; }
                    foreach (var d in devices)
                    {
                        var dd = (Dictionary<string, object>)d;
                        string ip = Str(dd, "ip");
                        string label = Str(dd, "label");
                        if (label == "") label = "Android / Fire TV";
                        string phase = Str(dd, "phase");
                        list.Items.Add(new ListViewItem(new[] { ip, label, phase == "ready" ? "" : phase }));
                    }
                }));
            }
            catch { }
        });
        t.IsBackground = true; t.Start();
    }

    private void InstallSelected()
    {
        if (list.SelectedItems.Count == 0) return;
        string ip = list.SelectedItems[0].SubItems[0].Text;
        if (string.IsNullOrEmpty(ip)) return;
        list.SelectedItems[0].SubItems[2].Text = "Starting...";
        var t = new System.Threading.Thread(() => { try { httpPost("/devices/install", "{\"ip\":\"" + ip + "\"}"); } catch { } });
        t.IsBackground = true; t.Start();
        timer.Start();
    }

    private void PollStatus()
    {
        var t = new System.Threading.Thread(() =>
        {
            Dictionary<string, object> s = null;
            try { s = (Dictionary<string, object>)new JavaScriptSerializer().DeserializeObject(httpGet("/devices/status")); }
            catch { }
            if (s == null) return;
            try
            {
                this.Invoke((MethodInvoker)(() =>
                {
                    bool anyActive = false;
                    foreach (ListViewItem it in list.Items)
                    {
                        string ip = it.SubItems[0].Text;
                        if (ip != "" && s.ContainsKey(ip))
                        {
                            var j = (Dictionary<string, object>)s[ip];
                            string phase = Str(j, "phase");
                            string msg = Str(j, "message");
                            it.SubItems[2].Text = msg != "" ? msg : phase;
                            if (phase == "connecting" || phase == "waiting-auth" || phase == "installing" || phase == "pairing") anyActive = true;
                        }
                    }
                    if (!anyActive) timer.Stop();
                }));
            }
            catch { }
        });
        t.IsBackground = true; t.Start();
    }
}

// A small dialog to set / change the built-in access password. Reads the
// current state from the localhost-only /status endpoint and writes via
// /setup/set-password (loopback is allowed). Stores only a scrypt hash server
// side; the plaintext is never persisted.
class PasswordForm : Form
{
    private int port;
    private TextBox userBox;
    private TextBox passBox;
    private TextBox pass2Box;
    private Label statusLabel;
    private Label msg;

    public PasswordForm(int port)
    {
        this.port = port;
        Text = "EufyView - Set Access Password";
        Width = 440;
        Height = 300;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;

        statusLabel = new Label() { Left = 16, Top = 12, Width = 400, Height = 34, Text = "" };
        Controls.Add(statusLabel);

        Controls.Add(new Label() { Left = 16, Top = 54, Width = 90, Text = "Username" });
        userBox = new TextBox() { Left = 110, Top = 51, Width = 300 };
        Controls.Add(userBox);

        Controls.Add(new Label() { Left = 16, Top = 88, Width = 90, Text = "Password" });
        passBox = new TextBox() { Left = 110, Top = 85, Width = 300, UseSystemPasswordChar = true };
        Controls.Add(passBox);

        Controls.Add(new Label() { Left = 16, Top = 122, Width = 90, Text = "Confirm" });
        pass2Box = new TextBox() { Left = 110, Top = 119, Width = 300, UseSystemPasswordChar = true };
        Controls.Add(pass2Box);

        msg = new Label() { Left = 16, Top = 152, Width = 400, Height = 34, ForeColor = Color.Firebrick };
        Controls.Add(msg);

        var saveBtn = new Button() { Text = "Save", Left = 234, Top = 196, Width = 80, DialogResult = DialogResult.None };
        saveBtn.Click += (s, e) => Save();
        Controls.Add(saveBtn);

        var cancelBtn = new Button() { Text = "Cancel", Left = 324, Top = 196, Width = 86, DialogResult = DialogResult.Cancel };
        Controls.Add(cancelBtn);

        var note = new Label()
        {
            Left = 16, Top = 232, Width = 400, Height = 30,
            ForeColor = Color.Gray,
            Text = "Only a one-way salted hash is stored - the password is never saved to disk."
        };
        Controls.Add(note);

        AcceptButton = saveBtn;
        CancelButton = cancelBtn;
        LoadStatus();
    }

    private static string Str(Dictionary<string, object> m, string k) { return (m.ContainsKey(k) && m[k] != null) ? m[k].ToString() : ""; }

    private void LoadStatus()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://localhost:" + port + "/status");
            req.Timeout = 3000;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var sr = new StreamReader(resp.GetResponseStream()))
            {
                var m = (Dictionary<string, object>)new JavaScriptSerializer().DeserializeObject(sr.ReadToEnd());
                if (m.ContainsKey("auth") && m["auth"] is Dictionary<string, object>)
                {
                    var a = (Dictionary<string, object>)m["auth"];
                    if (Str(a, "passwordSet") == "True" || Str(a, "passwordSet") == "true")
                        statusLabel.Text = "A password is set. Enter a new one to change it.";
                    else
                        statusLabel.Text = "No password set yet. Set one to require a login.";
                    if (Str(a, "username") != "") userBox.Text = Str(a, "username");
                }
            }
        }
        catch { statusLabel.Text = "(could not read current login state)"; }
    }

    private void Save()
    {
        string u = userBox.Text.Trim();
        string p = passBox.Text;
        string p2 = pass2Box.Text;
        if (u == "") { msg.Text = "Enter a username."; return; }
        if (p.Length < 8) { msg.Text = "Password must be at least 8 characters."; return; }
        if (p != p2) { msg.Text = "Passwords don't match."; return; }
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://localhost:" + port + "/setup/set-password");
            req.Method = "POST"; req.ContentType = "application/json"; req.Timeout = 8000;
            var json = new JavaScriptSerializer().Serialize(new Dictionary<string, string> { { "username", u }, { "password", p } });
            var bytes = System.Text.Encoding.UTF8.GetBytes(json);
            using (var s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);
            using (var resp = (HttpWebResponse)req.GetResponse()) { }
            DialogResult = DialogResult.OK;
            Close();
        }
        catch (WebException ex)
        {
            string detail = "";
            try { if (ex.Response != null) using (var sr = new StreamReader(ex.Response.GetResponseStream())) detail = sr.ReadToEnd(); } catch { }
            msg.Text = "Could not save." + (detail != "" ? " " + detail : " " + ex.Message);
        }
        catch (Exception ex) { msg.Text = "Could not save. " + ex.Message; }
    }
}
