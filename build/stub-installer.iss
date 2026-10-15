; stub-installer.iss - 在线引导安装器模板
#ifndef APP_REGION
#define APP_REGION "GLOBAL"
#endif

#ifndef SHORTCUT_NAME
#define SHORTCUT_NAME "Firefly AI folder"
#endif

; 构建时回退版本配置（当在线拉取最新版本清单失败时兜底使用）
#ifndef FALLBACK_DOWNLOAD_URL
#define FALLBACK_DOWNLOAD_URL "https://download.iocn.cn/firefly-ai-folder/releases/latest/firefly-ai-folder-setup-full-x64.exe"
#endif

#ifndef FALLBACK_SHA256
#define FALLBACK_SHA256 ""
#endif

; 在线最新版本清单地址 (由 CI 同步发布，用于感知最新版本防 404)
#ifndef MANIFEST_URL
#define MANIFEST_URL "https://download.iocn.cn/firefly-ai-folder/latest-global.ini"
#endif

#define AppName "Firefly AI Folder"
#define AppVersion "4.0.0"

[Setup]
AppId={{eb9b7d8c-2f8a-4d9f-9c8b-3e5f1a2b3c4d}}
AppName={#SHORTCUT_NAME}
AppVersion={#AppVersion}
DefaultDirName={autopf}\{#AppName}
DisableDirPage=no
DisableProgramGroupPage=yes
; 必须要求管理员权限，以契合母包 perMachine 的安装要求
PrivilegesRequired=admin
OutputDir=dist-installers
OutputBaseFilename=Firefly-AI-Folder-Setup-{#APP_REGION}
Compression=lzma2
SolidCompression=yes

#include "idp.iss"

[Files]
; 纯在线引导器，不打包主程序实体文件

[Code]
var
  ActualDownloadUrl: String;
  ExpectedSha256: String;

procedure InitializeWizard();
begin
  // ⭐ 核心时序对齐：挂载到就绪页 (wpReady) 之后，让用户选完盘点击安装时才展示下载页
  idpDownloadAfter(wpReady);
end;

procedure CurPageChanged(CurPageID: Integer);
var
  ManifestFile: String;
  ManifestUrlWithTimestamp: String;
  OnlineUrl, OnlineHash: String;
begin
  if CurPageID = wpReady then
  begin
    idpClearFiles;
    ManifestFile := ExpandConstant('{tmp}\latest.ini');
    ActualDownloadUrl := '{#FALLBACK_DOWNLOAD_URL}';
    ExpectedSha256 := LowerCase('{#FALLBACK_SHA256}');

    // 1. 在用户完成选盘、即将安装时，添加时间戳参数破除 CDN/EdgeOne 缓存，轻量拉取最新发布清单
    if Pos('?', '{#MANIFEST_URL}') > 0 then
      ManifestUrlWithTimestamp := '{#MANIFEST_URL}' + '&_t=' + IntToStr(GetTickCount())
    else
      ManifestUrlWithTimestamp := '{#MANIFEST_URL}' + '?_t=' + IntToStr(GetTickCount());

    Log('正在探测最新发布清单: ' + ManifestUrlWithTimestamp);
    if idpDownloadFile(ManifestUrlWithTimestamp, ManifestFile) then
    begin
      if FileExists(ManifestFile) then
      begin
        OnlineUrl := GetIniString('Release', 'url', '', ManifestFile);
        OnlineHash := LowerCase(GetIniString('Release', 'sha256', '', ManifestFile));
        if (OnlineUrl <> '') and (OnlineHash <> '') then
        begin
          ActualDownloadUrl := OnlineUrl;
          ExpectedSha256 := OnlineHash;
          Log('✅ 命中在线最新发布母包: ' + OnlineUrl + ' (Hash: ' + OnlineHash + ')');
        end;
        DeleteFile(ManifestFile);
      end;
    end
    else
    begin
      Log('⚠️ 在线清单不可达，回退使用构建期固化配置');
    end;

    // 2. 将母包正式注册进 IDP 队列，点击“安装”时原生进度条启动拉取
    idpAddFile(ActualDownloadUrl, ExpandConstant('{tmp}\mother-setup.exe'));
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  TargetDir, EnvFile, DownloadedFile, ActualHash: String;
begin
  if CurStep = ssInstall then
  begin
    DownloadedFile := ExpandConstant('{tmp}\mother-setup.exe');
    if not FileExists(DownloadedFile) then
    begin
      MsgBox('安装母包下载未完成或文件丢失。', mbCriticalError, MB_OK);
      Abort();
    end;

    // 3. 密码学校验并防护未捕获异常
    if ExpectedSha256 <> '' then
    begin
      try
        ActualHash := LowerCase(GetSHA256OfFile(DownloadedFile));
      except
        MsgBox('计算安装包哈希失败，可能被占用或损坏。', mbCriticalError, MB_OK);
        DeleteFile(DownloadedFile);
        Abort();
      end;

      if CompareText(ActualHash, ExpectedSha256) <> 0 then
      begin
        MsgBox('安装包 SHA-256 完整性校验失败，文件已损坏或被劫持。' #13#10 +
               '预期: ' + ExpectedSha256 #13#10 +
               '实际: ' + ActualHash, mbCriticalError, MB_OK);
        DeleteFile(DownloadedFile);
        Abort();
      end;
      Log('✅ 母包 SHA-256 校验通过: ' + ActualHash);
    end;

    TargetDir := ExpandConstant('{app}');
    ForceDirectories(TargetDir);

    // ⭐ 核心死锁破除：必须在调起母包 Exec 之前写入环境标记与哨兵文件！
    EnvFile := TargetDir + '\app_env.json';
    SaveStringToFile(EnvFile, '{"region": "' + LowerCase('{#APP_REGION}') + '"}', False);
    if LowerCase('{#APP_REGION}') = 'cn' then
      SaveStringToFile(TargetDir + '\.region_cn', '1', False);

    // 4. 调用母包静默执行 (/S /D= 必须位于最后且无引号)
    if not Exec(DownloadedFile, '/S /D=' + TargetDir, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    begin
      MsgBox('底层安装引擎启动失败 (错误码: ' + IntToStr(ResultCode) + ')。', mbError, MB_OK);
      Abort();
    end;

    // 5. 清理临时安装母包，防止占用 300MB+ 临时磁盘
    DeleteFile(DownloadedFile);
  end;
end;

procedure DeinitializeSetup();
begin
  // 用户中途取消时，确保清理临时下载残片
  if FileExists(ExpandConstant('{tmp}\mother-setup.exe')) then
    DeleteFile(ExpandConstant('{tmp}\mother-setup.exe'));
  if FileExists(ExpandConstant('{tmp}\latest.ini')) then
    DeleteFile(ExpandConstant('{tmp}\latest.ini'));
end;
