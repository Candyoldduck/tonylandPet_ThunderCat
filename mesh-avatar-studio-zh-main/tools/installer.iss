; 雷霆喵 desktop pet installer.
;
;   "C:\Users\l\AppData\Local\Programs\Inno Setup 6\ISCC.exe" tools\installer.iss
;
; Needs dist\雷霆喵\ from tools\build-exe.ps1.  Inno Setup ships no Simplified Chinese language
; pack, so the wizard chrome stays English and every string the user actually has to read or act
; on is overridden in Chinese below.

#define MyAppName "雷霆喵"
#define MyAppVersion "1.1"
#define MyExeName "雷霆喵.exe"
#define MySourceDir "..\dist\雷霆喵"

[Setup]
AppId={{8F3C1D27-6B4E-4A9C-9E15-2D7A4C0B5E61}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppName}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
UninstallDisplayIcon={app}\{#MyExeName}
UninstallDisplayName={#MyAppName}
SetupIconFile=..\projects\leitingmiao\leitingmiao.ico
OutputDir=..\output
OutputBaseFilename={#MyAppName}-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; let a plain user install without hunting for an admin account
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DisableProgramGroupPage=yes
DisableWelcomePage=no
CloseApplications=yes
RestartApplications=no

[Languages]
Name: default; MessagesFile: compiler:Default.isl

[Tasks]
Name: desktopicon; Description: "创建桌面快捷方式 (&D)"; Flags: unchecked
Name: autostart; Description: "开机自动启动雷霆喵"; Flags: unchecked

[Files]
Source: {#MySourceDir}\*; DestDir: {app}; Flags: recursesubdirs createallsubdirs ignoreversion

[Dirs]
Name: {app}; Permissions: users-modify

[Icons]
Name: {autodesktop}\{#MyAppName}; Filename: {app}\{#MyExeName}; Tasks: desktopicon
Name: {group}\{#MyAppName}; Filename: {app}\{#MyExeName}
Name: {group}\卸载 {#MyAppName}; Filename: {uninstallexe}

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: LeitingMiaoDesktopPet; ValueData: """{app}\{#MyExeName}"""; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: {app}\{#MyExeName}; Description: 现在就启动雷霆喵; WorkingDir: {app}; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: {userappdata}\LeitingMiao

[Messages]
default.WelcomeLabel1=准备安装 雷霆喵 桌宠
default.WelcomeLabel2=接下来将在您的电脑上安装 雷霆喵。
default.SelectTasksLabel2=勾选安装时要顺便做的事，然后点「下一步」。
default.InstallingLabel=正在安装…
default.FinishedLabel=雷霆喵 已安装完成，双击桌面上的图标就能放出来。
default.FinishedRestartLabel=要让新的设置完全生效，请重新启动电脑。
default.ClickFinish=点击「完成」退出安装向导。
default.ReadyLabel1=一切准备就绪，可以开始安装了。
default.ReadyLabel2a=点「安装」继续；想改设置可以点「上一步」。
default.ReadyLabel2b=点「安装」继续。
default.ButtonBack=上一步 (&B)
default.ButtonNext=下一步 (&N)
default.ButtonInstall=安装 (&I)
default.ButtonFinish=完成 (&F)
default.ButtonCancel=取消
default.UninstallAppTitle=卸载
default.UninstallAppFullTitle=%1 卸载
default.ConfirmUninstall=您确定要卸载 雷霆喵 吗？
default.SetupAborted=安装已中止。
default.StatusCreateDirs=正在创建目录…
default.StatusExtractFiles=正在复制文件…
default.StatusCreateIcons=正在创建快捷方式…
default.StatusCreateRegistryEntries=正在写入设置…
default.StatusSavingUninstall=正在保存卸载信息…
default.StatusRunProgram=正在完成安装…
default.SetupAppRunningError=检测到 雷霆喵 正在运行。%n%n请先把它退出（右键猫咪 → 退出桌宠），再点「确定」继续。
default.UninstallAppRunningError=检测到 雷霆喵 正在运行。%n%n请先把它退出（右键猫咪 → 退出桌宠），再点「确定」继续卸载。

[Code]
const
  // WebView2 is the browser engine the pet draws with.  Every Windows 11 box and most updated
  // Windows 10 boxes already have it; say so plainly instead of letting the window fail later.
  EdgeClientKey = 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  EdgeClientKey64 = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function WebView2Present(): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(HKLM, EdgeClientKey, 'pv', Version) or
            RegQueryStringValue(HKLM, EdgeClientKey64, 'pv', Version) or
            RegQueryStringValue(HKCU, EdgeClientKey, 'pv', Version) or
            RegQueryStringValue(HKCU, EdgeClientKey64, 'pv', Version);
  if Result then
    Result := (Version <> '') and (Version <> '0.0.0.0');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if not WebView2Present() then
      MsgBox('雷霆喵 需要 Microsoft Edge WebView2 运行时才能显示画面。' + #13#10#13#10 +
             '大多数 Windows 10/11 已经自带。如果启动后猫咪的位置只有一块纯色或空白，' +
             '请安装 WebView2 运行时（搜索「下载 Microsoft Edge WebView2 运行时」，' +
             '或运行 Edge 浏览器一次即可），然后重新打开雷霆喵。',
             mbInformation, MB_OK);
  end;
end;

// offer to take the saved position / size / switches with the app, but never silently
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Dir: String;
  Choice: Integer;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    Dir := ExpandConstant('{userappdata}\LeitingMiao');
    if DirExists(Dir) then
    begin
      Choice := MsgBox('是否同时删除雷霆喵的存档设置（位置、大小、开关）？' + #13#10#13#10 +
                       '选「是」以后重装会回到默认位置；选「否」下次安装还是原样。',
                       mbConfirmation, MB_YESNO or MB_DEFBUTTON2);
      if Choice = IDYES then
        DelTree(Dir, True, True, True);
    end;
  end;
end;
