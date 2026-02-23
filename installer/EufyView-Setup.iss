; EufyView Inno Setup Script
; Builds a standalone installer bundling Node.js portable + FFmpeg + Tailscale MSI + Cloudflare Tunnel

#define MyAppName "EufyView"
#define MyAppVersion "0.1.1"
#define MyAppPublisher "EufyView"
#define MyAppURL "https://github.com/your-repo/eufyview"

[Setup]
AppId={{A7E2B1C3-8D5F-4E6A-9B0C-2F4D7E8A1B53}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
DefaultDirName={localappdata}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
PrivilegesRequired=admin
OutputDir=dist
OutputBaseFilename=EufyView-Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
SetupLogging=yes
UninstallDisplayName={#MyAppName}
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Types]
Name: "full"; Description: "Full installation (with Tailscale)"
Name: "cloudflare"; Description: "Cloudflare Tunnel installation"
Name: "compact"; Description: "Compact installation (direct access)"

[Components]
Name: "main"; Description: "EufyView Server"; Types: full cloudflare compact; Flags: fixed
Name: "tailscale"; Description: "Tailscale (for secure remote access)"; Types: full
Name: "cloudflare"; Description: "Cloudflare Tunnel (for secure remote access)"; Types: cloudflare

; ============================================================
; Files section — bundles everything into the installer
; ============================================================
[Files]
; --- Bundled Node.js portable ---
Source: "build-cache\node-v22-win-x64\*"; DestDir: "{app}\node"; Flags: ignoreversion recursesubdirs createallsubdirs

; --- Bundled FFmpeg ---
Source: "build-cache\ffmpeg\ffmpeg.exe"; DestDir: "{app}\ffmpeg"; Flags: ignoreversion

; --- App source files ---
Source: "..\server\*"; DestDir: "{app}\server"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\main.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\package-lock.json"; DestDir: "{app}"; Flags: ignoreversion; Check: PackageLockExists

; --- Post-install script ---
Source: "post-install.ps1"; DestDir: "{app}"; Flags: ignoreversion

; --- Tray app ---
Source: "EufyViewTray.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "tray-icon.ico"; DestDir: "{app}"; Flags: ignoreversion

; --- Tailscale MSI (optional component) ---
Source: "build-cache\tailscale-setup.msi"; DestDir: "{app}"; Components: tailscale; Flags: ignoreversion deleteafterinstall

; --- Cloudflared (optional component) ---
Source: "build-cache\cloudflared-windows-amd64.exe"; DestDir: "{app}"; DestName: "cloudflared.exe"; Components: cloudflare; Flags: ignoreversion

; ============================================================
; Registry — launch tray app at Windows startup
; ============================================================
[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "EufyView"; ValueData: """{app}\EufyViewTray.exe"""; Flags: uninsdeletevalue; Check: StartWithWindows
Root: HKCU; Subkey: "Software\EufyView"; ValueType: string; ValueName: "Port"; ValueData: "{code:GetPort}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\EufyView"; ValueType: string; ValueName: "NetworkMode"; ValueData: "{code:GetNetworkMode}"; Flags: uninsdeletekey

; ============================================================
; Run section — post-install
; ============================================================
[Run]
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\post-install.ps1"" -InstallDir ""{app}"" -NetworkMode ""{code:GetNetworkMode}"" -Port ""{code:GetPort}"" -CloudflareToken ""{code:GetCloudflareToken}"" -EufyUsername ""{code:GetEufyUsername}"" -EufyPassword ""{code:GetEufyPassword}"" -EufyCountry ""{code:GetEufyCountry}"" -EufyLanguage ""{code:GetEufyLanguage}"""; \
    StatusMsg: "Configuring EufyView (this may take a minute)..."; \
    Flags: runhidden waituntilterminated

; ============================================================
; Uninstall — clean up processes, services, firewall
; ============================================================
[UninstallRun]
; Kill tray app (use /t to also kill its child node.exe process tree)
; NOTE: We do NOT blanket-kill node.exe — other apps (ClaudeRelay) may be running node too.
Filename: "taskkill.exe"; Parameters: "/f /t /im EufyViewTray.exe"; Flags: runhidden; RunOnceId: "KillTray"

; NOTE: We do NOT run 'cloudflared service uninstall' here.
; The cloudflared tunnel is shared infrastructure — other apps (ClaudeRelay) may use the same tunnel.
; If you need to remove the tunnel, do it manually via 'cloudflared service uninstall' or
; the Cloudflare Zero Trust dashboard.

; Remove firewall rule (EufyView-specific, safe to remove)
Filename: "netsh.exe"; Parameters: "advfirewall firewall delete rule name=""EufyView"""; Flags: runhidden; RunOnceId: "DelFirewall"

; Remove tailscale serve for this port only (does not uninstall Tailscale itself)
Filename: "C:\Program Files\Tailscale\tailscale.exe"; Parameters: "serve --remove {reg:HKCU\Software\EufyView,Port|3001}"; Flags: runhidden skipifdoesntexist; RunOnceId: "DelTailscale"

[Icons]
Name: "{autodesktop}\EufyView"; Filename: "{app}\EufyViewTray.exe"; IconFilename: "{app}\tray-icon.ico"; Check: CreateDesktopIcon

[UninstallDelete]
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\node"
Type: filesandordirs; Name: "{app}\ffmpeg"
Type: filesandordirs; Name: "{app}\server"
Type: filesandordirs; Name: "{app}\public"
Type: filesandordirs; Name: "{app}\data"
Type: files; Name: "{app}\main.js"
Type: files; Name: "{app}\config.json"
Type: files; Name: "{app}\persistent.json"
Type: files; Name: "{app}\install.log"
Type: files; Name: "{app}\install-results.txt"
Type: files; Name: "{app}\error.log"
Type: files; Name: "{app}\package.json"
Type: files; Name: "{app}\package-lock.json"
Type: files; Name: "{app}\post-install.ps1"
Type: files; Name: "{app}\cloudflared.exe"
Type: files; Name: "{app}\EufyViewTray.exe"
Type: files; Name: "{app}\tray-icon.ico"

; ============================================================
; Pascal Script — custom wizard pages + dynamic finish page
; ============================================================
[Code]
var
    EufyCredentialsPage: TInputQueryWizardPage;
    PortPage: TInputQueryWizardPage;
    NetworkPage: TWizardPage;
    NetworkTailscaleRadio: TNewRadioButton;
    NetworkCloudflareRadio: TNewRadioButton;
    NetworkDirectRadio: TNewRadioButton;
    NetworkTailscaleDesc: TNewStaticText;
    NetworkCloudflareDesc: TNewStaticText;
    NetworkDirectDesc: TNewStaticText;
    CloudflareTokenPage: TInputQueryWizardPage;
    OptionsPage: TWizardPage;
    StartupCheckbox: TNewCheckBox;
    DesktopIconCheckbox: TNewCheckBox;
    FinishedMemo: TNewMemo;

function PackageLockExists(): Boolean;
begin
    Result := FileExists(ExpandConstant('{src}\..\package-lock.json'));
end;

function GetEufyUsername(Param: String): String;
begin
    Result := EufyCredentialsPage.Values[0];
end;

function GetEufyPassword(Param: String): String;
begin
    Result := EufyCredentialsPage.Values[1];
end;

function GetEufyCountry(Param: String): String;
begin
    Result := EufyCredentialsPage.Values[2];
    if Result = '' then
        Result := 'US';
end;

function GetEufyLanguage(Param: String): String;
begin
    Result := EufyCredentialsPage.Values[3];
    if Result = '' then
        Result := 'en';
end;

function GetPort(Param: String): String;
begin
    Result := PortPage.Values[0];
end;

function GetNetworkMode(Param: String): String;
begin
    if NetworkTailscaleRadio.Checked then
        Result := 'tailscale'
    else if NetworkCloudflareRadio.Checked then
        Result := 'cloudflare'
    else
        Result := 'direct';
end;

function GetCloudflareToken(Param: String): String;
begin
    if CloudflareTokenPage <> nil then
        Result := CloudflareTokenPage.Values[0]
    else
        Result := '';
end;

function StartWithWindows(): Boolean;
begin
    Result := StartupCheckbox.Checked;
end;

function CreateDesktopIcon(): Boolean;
begin
    Result := DesktopIconCheckbox.Checked;
end;

procedure InitializeWizard();
var
    StartupDesc: TNewStaticText;
begin
    // --- Eufy Credentials Page ---
    EufyCredentialsPage := CreateInputQueryPage(wpSelectDir,
        'Eufy Account Credentials',
        'Enter your Eufy Security account details.',
        'These credentials are stored locally and used to connect to your Eufy cameras.' + #13#10 +
        'They are never sent anywhere except to Eufy servers for authentication.');
    EufyCredentialsPage.Add('Email:', False);
    EufyCredentialsPage.Add('Password:', True);
    EufyCredentialsPage.Add('Country (e.g. US):', False);
    EufyCredentialsPage.Add('Language (e.g. en):', False);
    EufyCredentialsPage.Values[2] := 'US';
    EufyCredentialsPage.Values[3] := 'en';

    // --- Port Page ---
    PortPage := CreateInputQueryPage(EufyCredentialsPage.ID,
        'Server Port',
        'Which port should EufyView listen on?',
        'Enter the TCP port number for the EufyView server. ' +
        'The default is 3001. Change this if another application is already using that port.');
    PortPage.Add('Port:', False);
    PortPage.Values[0] := '3001';

    // --- Network Access Page ---
    NetworkPage := CreateCustomPage(PortPage.ID,
        'Network Access',
        'How will you access EufyView remotely?');

    // Tailscale radio
    NetworkTailscaleRadio := TNewRadioButton.Create(NetworkPage);
    NetworkTailscaleRadio.Parent := NetworkPage.Surface;
    NetworkTailscaleRadio.Caption := 'Tailscale (Recommended)';
    NetworkTailscaleRadio.Font.Style := [fsBold];
    NetworkTailscaleRadio.Top := 10;
    NetworkTailscaleRadio.Left := 0;
    NetworkTailscaleRadio.Width := NetworkPage.SurfaceWidth;
    NetworkTailscaleRadio.Checked := True;

    NetworkTailscaleDesc := TNewStaticText.Create(NetworkPage);
    NetworkTailscaleDesc.Parent := NetworkPage.Surface;
    NetworkTailscaleDesc.Caption :=
        'Installs Tailscale for secure, zero-config remote access over HTTPS.' + #13#10 +
        'Supports PWA install on Android/iOS. Requires a free Tailscale account.';
    NetworkTailscaleDesc.Top := 32;
    NetworkTailscaleDesc.Left := 20;
    NetworkTailscaleDesc.Width := NetworkPage.SurfaceWidth - 20;
    NetworkTailscaleDesc.AutoSize := True;
    NetworkTailscaleDesc.WordWrap := True;

    // Cloudflare Tunnel radio
    NetworkCloudflareRadio := TNewRadioButton.Create(NetworkPage);
    NetworkCloudflareRadio.Parent := NetworkPage.Surface;
    NetworkCloudflareRadio.Caption := 'Cloudflare Tunnel';
    NetworkCloudflareRadio.Font.Style := [fsBold];
    NetworkCloudflareRadio.Top := 85;
    NetworkCloudflareRadio.Left := 0;
    NetworkCloudflareRadio.Width := NetworkPage.SurfaceWidth;

    NetworkCloudflareDesc := TNewStaticText.Create(NetworkPage);
    NetworkCloudflareDesc.Parent := NetworkPage.Surface;
    NetworkCloudflareDesc.Caption :=
        'Secure remote access via Cloudflare with HTTPS. Supports Cloudflare Access' + #13#10 +
        'for authentication. Requires a Cloudflare account with a domain.';
    NetworkCloudflareDesc.Top := 107;
    NetworkCloudflareDesc.Left := 20;
    NetworkCloudflareDesc.Width := NetworkPage.SurfaceWidth - 20;
    NetworkCloudflareDesc.AutoSize := True;
    NetworkCloudflareDesc.WordWrap := True;

    // Direct radio
    NetworkDirectRadio := TNewRadioButton.Create(NetworkPage);
    NetworkDirectRadio.Parent := NetworkPage.Surface;
    NetworkDirectRadio.Caption := 'Direct / Port Forwarding';
    NetworkDirectRadio.Font.Style := [fsBold];
    NetworkDirectRadio.Top := 160;
    NetworkDirectRadio.Left := 0;
    NetworkDirectRadio.Width := NetworkPage.SurfaceWidth;

    NetworkDirectDesc := TNewStaticText.Create(NetworkPage);
    NetworkDirectDesc.Parent := NetworkPage.Surface;
    NetworkDirectDesc.Caption :=
        'Opens port 3001 via Windows Firewall only. You handle port forwarding yourself.' + #13#10 +
        'WARNING: No HTTPS means PWA install will not work on Android/iOS.';
    NetworkDirectDesc.Top := 182;
    NetworkDirectDesc.Left := 20;
    NetworkDirectDesc.Width := NetworkPage.SurfaceWidth - 20;
    NetworkDirectDesc.AutoSize := True;
    NetworkDirectDesc.WordWrap := True;

    // --- Cloudflare Token Page ---
    CloudflareTokenPage := CreateInputQueryPage(NetworkPage.ID,
        'Cloudflare Tunnel Token',
        'Enter the connector token for your Cloudflare Tunnel.',
        'Create a tunnel in the Cloudflare Zero Trust dashboard (one.dash.cloudflare.com),' + #13#10 +
        'add a public hostname pointing to http://localhost:3001, then copy the connector token.');
    CloudflareTokenPage.Add('Token:', False);

    // --- Options Page ---
    OptionsPage := CreateCustomPage(CloudflareTokenPage.ID,
        'Options',
        'Choose additional options.');

    // Startup checkbox
    StartupCheckbox := TNewCheckBox.Create(OptionsPage);
    StartupCheckbox.Parent := OptionsPage.Surface;
    StartupCheckbox.Caption := 'Launch EufyView when Windows starts';
    StartupCheckbox.Font.Style := [fsBold];
    StartupCheckbox.Top := 10;
    StartupCheckbox.Left := 0;
    StartupCheckbox.Width := OptionsPage.SurfaceWidth;
    StartupCheckbox.Checked := True;

    StartupDesc := TNewStaticText.Create(OptionsPage);
    StartupDesc.Parent := OptionsPage.Surface;
    StartupDesc.Caption :=
        'Adds EufyView to your Windows startup so it launches automatically when you log in.';
    StartupDesc.Top := 34;
    StartupDesc.Left := 24;
    StartupDesc.Width := OptionsPage.SurfaceWidth - 24;
    StartupDesc.AutoSize := True;
    StartupDesc.WordWrap := True;

    // Desktop icon checkbox
    DesktopIconCheckbox := TNewCheckBox.Create(OptionsPage);
    DesktopIconCheckbox.Parent := OptionsPage.Surface;
    DesktopIconCheckbox.Caption := 'Create desktop shortcut';
    DesktopIconCheckbox.Font.Style := [fsBold];
    DesktopIconCheckbox.Top := 80;
    DesktopIconCheckbox.Left := 0;
    DesktopIconCheckbox.Width := OptionsPage.SurfaceWidth;
    DesktopIconCheckbox.Checked := True;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
    Result := False;
    // Skip the standard components page — our network page drives selection
    if PageID = wpSelectComponents then
        Result := True;
    // Skip the standard tasks page — we have our own
    if PageID = wpSelectTasks then
        Result := True;
    // Skip the Cloudflare token page unless Cloudflare mode is selected
    if (CloudflareTokenPage <> nil) and (PageID = CloudflareTokenPage.ID) then
        if not NetworkCloudflareRadio.Checked then
            Result := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
    PortNum: Integer;
begin
    Result := True;

    // Validate Eufy credentials
    if CurPageID = EufyCredentialsPage.ID then
    begin
        if Trim(EufyCredentialsPage.Values[0]) = '' then
        begin
            MsgBox('Please enter your Eufy account email.', mbError, MB_OK);
            Result := False;
            Exit;
        end;
        if Trim(EufyCredentialsPage.Values[1]) = '' then
        begin
            MsgBox('Please enter your Eufy account password.', mbError, MB_OK);
            Result := False;
            Exit;
        end;
    end;

    // Validate port and update network page descriptions
    if CurPageID = PortPage.ID then
    begin
        PortNum := StrToIntDef(PortPage.Values[0], -1);
        if (PortNum < 1) or (PortNum > 65535) then
        begin
            MsgBox('Please enter a valid port number (1-65535).', mbError, MB_OK);
            Result := False;
            Exit;
        end;
        NetworkCloudflareDesc.Caption :=
            'Secure remote access via Cloudflare with HTTPS on port ' + PortPage.Values[0] + '.' + #13#10 +
            'Supports Cloudflare Access for authentication. Requires a Cloudflare account with a domain.';
        NetworkDirectDesc.Caption :=
            'Opens port ' + PortPage.Values[0] + ' via Windows Firewall only. You handle port forwarding yourself.' + #13#10 +
            'WARNING: No HTTPS means PWA install will not work on Android/iOS.';
    end;

    // Sync network radio selection with Inno components
    if CurPageID = NetworkPage.ID then
    begin
        if NetworkTailscaleRadio.Checked then
            WizardSelectComponents('main,tailscale')
        else if NetworkCloudflareRadio.Checked then
            WizardSelectComponents('main,cloudflare')
        else
            WizardSelectComponents('main');
    end;

    // Validate Cloudflare token is not empty
    if (CloudflareTokenPage <> nil) and (CurPageID = CloudflareTokenPage.ID) then
    begin
        if Trim(CloudflareTokenPage.Values[0]) = '' then
        begin
            MsgBox('Please enter your Cloudflare Tunnel connector token.', mbError, MB_OK);
            Result := False;
            Exit;
        end;
    end;
end;

// Show summary of choices on the Ready page
function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo, MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
begin
    Result := '';

    // Install directory
    Result := Result + 'Install directory:' + NewLine;
    Result := Result + Space + ExpandConstant('{app}') + NewLine + NewLine;

    // Eufy account
    Result := Result + 'Eufy account:' + NewLine;
    Result := Result + Space + GetEufyUsername('') + NewLine + NewLine;

    // Server port
    Result := Result + 'Server port:' + NewLine;
    Result := Result + Space + GetPort('') + NewLine + NewLine;

    // Network mode
    Result := Result + 'Network access:' + NewLine;
    if NetworkTailscaleRadio.Checked then
        Result := Result + Space + 'Tailscale (secure remote access with HTTPS)' + NewLine
    else if NetworkCloudflareRadio.Checked then
        Result := Result + Space + 'Cloudflare Tunnel (secure remote access with HTTPS)' + NewLine
    else
        Result := Result + Space + 'Direct / Port Forwarding (firewall only)' + NewLine;
    Result := Result + NewLine;

    // Options
    Result := Result + 'Options:' + NewLine;
    if StartupCheckbox.Checked then
        Result := Result + Space + 'Launch on Windows startup' + NewLine
    else
        Result := Result + Space + '(manual launch only)' + NewLine;
    if DesktopIconCheckbox.Checked then
        Result := Result + Space + 'Create desktop shortcut' + NewLine;
end;

// Replace the finish page with a scrollable results summary
procedure CurPageChanged(CurPageID: Integer);
var
    ResultsFile: String;
    ResultLines: TArrayOfString;
    ResultsText: String;
    i: Integer;
begin
    if CurPageID = wpFinished then
    begin
        // Hide the default finish label
        WizardForm.FinishedLabel.Visible := False;
        WizardForm.FinishedHeadingLabel.Caption := 'EufyView is ready!';

        // Create a scrollable memo to show results
        if FinishedMemo = nil then
        begin
            FinishedMemo := TNewMemo.Create(WizardForm);
            FinishedMemo.Parent := WizardForm.FinishedPage;
            FinishedMemo.Left := WizardForm.FinishedLabel.Left;
            FinishedMemo.Top := WizardForm.FinishedLabel.Top;
            FinishedMemo.Width := WizardForm.FinishedLabel.Width;
            FinishedMemo.Height := WizardForm.FinishedPage.Height - WizardForm.FinishedLabel.Top - 10;
            FinishedMemo.ReadOnly := True;
            FinishedMemo.ScrollBars := ssVertical;
            FinishedMemo.Font.Name := 'Consolas';
            FinishedMemo.Font.Size := 9;
        end;

        // Read install-results.txt
        ResultsFile := ExpandConstant('{app}\install-results.txt');
        ResultsText := '';
        if LoadStringsFromFile(ResultsFile, ResultLines) then
        begin
            for i := 0 to GetArrayLength(ResultLines) - 1 do
            begin
                if i > 0 then
                    ResultsText := ResultsText + #13#10;
                ResultsText := ResultsText + ResultLines[i];
            end;
        end
        else
            ResultsText := 'Installation complete.' + #13#10 + #13#10 +
                'Access EufyView at: http://localhost:' + GetPort('') + #13#10 + #13#10 +
                'Check install.log for details.';

        FinishedMemo.Text := ResultsText;
    end;
end;
