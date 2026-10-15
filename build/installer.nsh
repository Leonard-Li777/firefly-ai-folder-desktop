; 卸载时清理数据目录
!macro customRemoveFiles
    ; 优先根据 .region_cn 哨兵或 PRODUCT_NAME 判断区域清理
    IfFileExists "$INSTDIR\.region_cn" cleanCNUserData checkLegacyUserData
    cleanCNUserData:
        RMDir /r "$APPDATA\firefly-ai-folder_v4_cn"
        RMDir /r "$APPDATA\firefly-ai-folder-cn"
        Goto doneUserData
    checkLegacyUserData:
        StrCmp "${PRODUCT_NAME}" "firefly-ai-folder-cn" 0 checkIntlUninstall
            RMDir /r "$APPDATA\firefly-ai-folder_v4_cn"
            RMDir /r "$APPDATA\firefly-ai-folder-cn"
            Goto doneUserData
        checkIntlUninstall:
            RMDir /r "$APPDATA\firefly-ai-folder_v4_intl"
            RMDir /r "$APPDATA\firefly-ai-folder-intl"
    doneUserData:
    Delete "$INSTDIR\.region_cn"
    Delete "$INSTDIR\app_env.json"
    ; 清理用户根目录下的 llamafile GPU 驱动
    Delete "$PROFILE\ggml-cuda.dll"
    Delete "$PROFILE\ggml-rocm.dll"
    Delete "$PROFILE\ggml-vulkan.dll"

    ; 清理 resources 目录下的所有子目录
    RMDir /r "$INSTDIR\resources\bin"
    RMDir /r "$INSTDIR\resources\models"
    RMDir /r "$INSTDIR\resources\configs"
    RMDir /r "$INSTDIR\resources\fileDimension"
    RMDir /r "$INSTDIR\resources\.VirtualDirectory"
    RMDir /r "$INSTDIR\resources\stubs"
    RMDir /r "$INSTDIR\resources\model"
    RMDir /r "$INSTDIR\resources\app.asar.unpacked"

    ; 删除 resources 下的文件
    Delete "$INSTDIR\resources\app.asar"

    ; 清理根目录下的 DLL 文件（Electron 运行时依赖）
    Delete "$INSTDIR\d3dcompiler_47.dll"
    Delete "$INSTDIR\dxcompiler.dll"
    Delete "$INSTDIR\dxil.dll"
    Delete "$INSTDIR\ffmpeg.dll"
    Delete "$INSTDIR\libEGL.dll"
    Delete "$INSTDIR\libGLESv2.dll"
    Delete "$INSTDIR\vk_swiftshader.dll"
    Delete "$INSTDIR\vulkan-1.dll"

    ; 删除可能创建的快捷方式
    Delete "$SMPROGRAMS\萤核智能文件夹.lnk"
    Delete "$DESKTOP\萤核智能文件夹.lnk"
    Delete "$SMPROGRAMS\Firefly AI folder.lnk"
    Delete "$DESKTOP\Firefly AI folder.lnk"

    ; 删除主程序可执行文件（兼容多种命名格式）
    Delete "$INSTDIR\firefly-ai-folder-cn.exe"
    Delete "$INSTDIR\firefly-ai-folder-intl.exe"
    Delete "$INSTDIR\firefly-ai-folder.exe"
    Delete "$INSTDIR\Firefly-AI-Folder-CN.exe"
    Delete "$INSTDIR\Firefly-AI-Folder-INTL.exe"
    Delete "$INSTDIR\Uninstall firefly-ai-folder.exe"
    Delete "$INSTDIR\uninstall.exe"
    Delete "$INSTDIR\Uninstall.exe"

    ; 删除其他可能的 Electron 文件
    Delete "$INSTDIR\LICENSE"
    Delete "$INSTDIR\LICENSES.chromium.html"
    Delete "$INSTDIR\version"

    ; 尝试删除整个安装目录（递归删除所有剩余内容）
    RMDir /r "$INSTDIR"
!macroend

; 安装前检测 VC++ Redistributable 并关闭正在运行的应用
!macro customInit
    ${nsProcess::KillProcess} "firefly-ai-engine.exe" $R0
    ${nsProcess::KillProcess} "firefly-ai-folder_v4_cn.exe" $R0
    ${nsProcess::KillProcess} "firefly-ai-folder_v4_intl.exe" $R0
    ${nsProcess::KillProcess} "firefly-ai-folder-cn.exe" $R0
    ${nsProcess::KillProcess} "firefly-ai-folder-intl.exe" $R0
    ${nsProcess::KillProcess} "firefly-ai-folder.exe" $R0
    ${nsProcess::KillProcess} "Firefly-AI-Folder-CN.exe" $R0
    ${nsProcess::KillProcess} "Firefly-AI-Folder-INTL.exe" $R0
    ${nsProcess::KillProcess} "firefly-omni.exe" $R1
    ${nsProcess::KillProcess} "llama-server.exe" $R2
    ${nsProcess::KillProcess} "llamafile.exe" $R3
    ${nsProcess::KillProcess} "fastfetch.exe" $R4
    ${nsProcess::KillProcess} "ffmpeg.exe" $R5
    ${nsProcess::KillProcess} "llama-model-download.exe" $R6
    Sleep 500

    ; 如果是静默更新安装模式 (/S)，直接跳过交互式 VC++ 弹窗，防止安装挂死
    IfSilent done 0

    ; 检测 VC++ 运行库 (MSVCP140.dll) 是否已安装
    ; 先检查 System32 (64位系统上64位DLL实际在 SysWOW64 中，但 System32 的 Sysnative 重定向也指向原生64位)
    IfFileExists "$WINDIR\System32\MSVCP140.dll" done
    IfFileExists "$WINDIR\SysWOW64\MSVCP140.dll" done
    ; 如果在 Program Files 下运行（x64 安装程序），System32 实际指向 Sysnative
    IfFileExists "$WINDIR\Sysnative\MSVCP140.dll" done

    ; VC++ 2015-2022 未找到，提示用户安装
    MessageBox MB_YESNO|MB_ICONINFORMATION \
        "检测到缺少 Microsoft Visual C++ Redistributable for Visual Studio 2015-2022。$\r$\n$\r$\nAI 引擎 (llama-server) 需要此运行库才能启动。$\r$\n$\r$\n是否立即下载并安装？" \
        IDYES downloadVC IDNO abortInstall

    downloadVC:
        NSISdl::download /TIMEOUT=30000 \
            "https://aka.ms/vs/17/release/vc_redist.x64.exe" \
            "$TEMP\vc_redist.x64.exe"
        Pop $R0
        StrCmp $R0 "success" installVC downloadFailed

    downloadFailed:
        MessageBox MB_ICONSTOP "下载失败 (错误: $R0)。$\r$\n请手动安装后重新运行安装程序。$\r$\nhttps://aka.ms/vs/17/release/vc_redist.x64.exe"
        Abort

    installVC:
        ExecWait '"$TEMP\vc_redist.x64.exe" /install /quiet /norestart' $R1
        ; 重新检查 DLL 是否安装成功
        IfFileExists "$WINDIR\System32\MSVCP140.dll" done
        IfFileExists "$WINDIR\SysWOW64\MSVCP140.dll" done
        ; 安装后仍有问题，提示用户重启
        MessageBox MB_ICONSTOP "VC++ Redistributable 安装完成，但系统未能检测到运行库。$\r$\n请重启计算机后重新运行安装程序。"
        Abort

    abortInstall:
        Abort

    done:
!macroend

; 安装后写入语言选择记录
!macro customInstall
    ; 优先根据 .region_cn 哨兵或 PRODUCT_NAME 判断区域，写入对应的数据目录
    IfFileExists "$INSTDIR\.region_cn" writeCNLang checkLegacyLang
    writeCNLang:
        CreateDirectory "$APPDATA\firefly-ai-folder_v4_cn"
        CreateDirectory "$APPDATA\firefly-ai-folder-cn"
        FileOpen $0 "$APPDATA\firefly-ai-folder_v4_cn\installer_language.txt" w
        FileWrite $0 "$LANGUAGE"
        FileClose $0
        FileOpen $0 "$APPDATA\firefly-ai-folder-cn\installer_language.txt" w
        FileWrite $0 "$LANGUAGE"
        FileClose $0
        Goto doneLang
    checkLegacyLang:
        StrCmp "${PRODUCT_NAME}" "firefly-ai-folder-cn" writeCNLang 0
        CreateDirectory "$APPDATA\firefly-ai-folder_v4_intl"
        CreateDirectory "$APPDATA\firefly-ai-folder-intl"
        FileOpen $0 "$APPDATA\firefly-ai-folder_v4_intl\installer_language.txt" w
        FileWrite $0 "$LANGUAGE"
        FileClose $0
        FileOpen $0 "$APPDATA\firefly-ai-folder-intl\installer_language.txt" w
        FileWrite $0 "$LANGUAGE"
        FileClose $0
    doneLang:

    SetOutPath "$INSTDIR"

    ; 判定快捷方式显示名称
    IfFileExists "$INSTDIR\.region_cn" createCNTitle checkLegacyTitle
    createCNTitle:
        StrCpy $R0 "萤核智能文件夹"
        Goto doCreateShortcut
    checkLegacyTitle:
        StrCmp "${PRODUCT_NAME}" "firefly-ai-folder-cn" createCNTitle 0
        StrCpy $R0 "Firefly AI folder"

    doCreateShortcut:
        ; 优先创建指向统一母包 firefly-ai-folder.exe 的快捷方式，若不存在则回退兼容旧版可执行文件名
        IfFileExists "$INSTDIR\firefly-ai-folder.exe" 0 checkLegacyExe
        CreateShortCut "$SMPROGRAMS\$R0.lnk" "$INSTDIR\firefly-ai-folder.exe"
        CreateShortCut "$DESKTOP\$R0.lnk" "$INSTDIR\firefly-ai-folder.exe"
        Goto doneCreate

    checkLegacyExe:
        IfFileExists "$INSTDIR\firefly-ai-folder-cn.exe" legacyCN
        IfFileExists "$INSTDIR\firefly-ai-folder-intl.exe" legacyINTL
        Goto doneCreate
    legacyCN:
        CreateShortCut "$SMPROGRAMS\萤核智能文件夹.lnk" "$INSTDIR\firefly-ai-folder-cn.exe"
        CreateShortCut "$DESKTOP\萤核智能文件夹.lnk" "$INSTDIR\firefly-ai-folder-cn.exe"
        Goto doneCreate
    legacyINTL:
        CreateShortCut "$SMPROGRAMS\Firefly AI folder.lnk" "$INSTDIR\firefly-ai-folder-intl.exe"
        CreateShortCut "$DESKTOP\Firefly AI folder.lnk" "$INSTDIR\firefly-ai-folder-intl.exe"
        Goto doneCreate

    doneCreate:
!macroend
