using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

class EufyViewTray : Form
{
    private NotifyIcon trayIcon;
    private Process serverProcess;
    private string installDir;
    private string nodeExe;
    private int port = 3001;

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
        menu.Items.Add("-");
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
