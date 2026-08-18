# Release 多平台安装与启动验证流水线说明文档

本文档详细说明本项目（`firefly-ai-folder-desktop`）中建立的 GitHub Actions 跨平台 Release 自动化安装与启动冒烟验证流水线（`verify-releases.yml`）及相关运维机制。

---

## 目录
- [一、背景与目标](#一背景与目标)
- [二、流水线触发机制](#二流水线触发机制)
- [三、全平台与架构覆盖矩阵](#三全平台与架构覆盖矩阵)
- [四、各平台测试流程与技术细节](#四各平台测试流程与技术细节)
  - [1. Windows 测试 (x64)](#1-windows-测试-x64)
  - [2. macOS 测试 (Native ARM64 + Rosetta 2 x86_64)](#2-macos-测试-native-arm64--rosetta-2-x86_64)
  - [3. Linux DEB 发行版测试](#3-linux-deb-发行版测试)
  - [4. Linux RPM 发行版测试](#4-linux-rpm-发行版测试)
- [五、智能架构匹配与跳过机制 (Guard)](#五智能架构匹配与跳过机制-guard)
- [六、同步脚本白名单保护机制](#六同步脚本白名单保护机制)
- [七、常见问题排查 (FAQ)](#七常见问题排查-faq)

---

## 一、背景与目标

为保证每次发布的 Release 安装包在主流桌面操作系统（Windows、macOS、Linux 各主流发行版）上均能正常安装并稳定拉起，本项目设计了全自动化的端到端冒烟验证流水线。

**核心校验项：**
1. **安装包完整性**：验证 NSIS (`.exe`)、DMG (`.dmg`)、DEB (`.deb`)、RPM (`.rpm`) 安装包均能正常解析与解包。
2. **底层运行时兼容**：验证 glibc（最低支持 glibc 2.28）、动态链接库、X11/Wayland 图形栈依赖是否完备。
3. **原生模块加载**：拉起 Electron 进程，确保 `better-sqlite3`、`sharp`、`bindings` 等 C++ 原生 Addon 模块无缺少符号或 ABI 版本冲突。
4. **架构兼容性**：覆盖 x86_64 (x64) 与 aarch64 (arm64)，其中 macOS 在 Apple Silicon 运行器上分别验证 ARM64 原生与 Rosetta 2 仿真模式。

---

## 二、流水线触发机制

流水线配置文件位置：[`.github/workflows/verify-releases.yml`](./verify-releases.yml)

### 1. 自动触发
- **事件**：`release: [published]`
- **说明**：当在 GitHub 仓库发布新的 Release（无论是正式版或预发布版）时，流水线将全自动触发并拉取当前发布的资产进行全面验证。

### 2. 手动触发 (`workflow_dispatch`)
- **入口**：GitHub 仓库页面 -> **Actions** -> **Verify Release Artifacts (Multi-Platform Smoke Test)** -> **Run workflow**
- **可配置参数**：
  | 参数名 | 类型 | 默认值 | 描述 |
  | :--- | :--- | :--- | :--- |
  | `tag_name` | string | `""` (空) | 目标 Release 的 Tag 名称（如 `v3.3.2`）。留空则自动拉取最新的 Release。 |
  | `region` | choice | `cn` | 目标区域版本（`cn` 为萤核智能文件夹国内版，`intl` 为国际版）。 |

---

## 三、全平台与架构覆盖矩阵

| 平台分类 | 目标架构 | 运行环境 / 容器镜像 | 安装方式 | 校验重点 |
| :--- | :--- | :--- | :--- | :--- |
| **Windows** | x64 | `windows-latest` | NSIS 静默安装 `/S` | 进程存活 15s、无快速崩溃、内存正常 |
| **macOS** | **ARM64 (Native)** | `macos-latest` (Apple Silicon) | `hdiutil` 挂载，`arch -arm64` 启动 | 原生架构执行、`lipo` 架构校验、进程存活 15s |
| **macOS** | **x86_64 (Rosetta 2)** | `macos-latest` (Apple Silicon) | `hdiutil` 挂载，`arch -x86_64` 仿真启动 | Rosetta 2 兼容、通用二进制仿真执行、进程存活 15s |
| **Linux (DEB)** | x64 / arm64 | Ubuntu 20.04 (glibc 2.31)<br>Ubuntu 22.04 (glibc 2.35)<br>Ubuntu 24.04 (glibc 2.39)<br>Debian 10 (glibc 2.28 / Deepin 20.x)<br>Debian 11 (glibc 2.31)<br>Debian 12 (glibc 2.36 / Deepin 23) | `dpkg -i` / `apt-get install`<br>`Xvfb` 虚拟显示启动 | glibc 版本兼容、原生模块动态库完整性、15s 存活 |
| **Linux (RPM)** | x64 / arm64 | Fedora 39, Fedora 40, Rocky Linux 9 | `dnf install` / `rpm -ivh`<br>`Xvfb` 虚拟显示启动 | RPM 包依赖关系、X11 显示环境正常拉起、15s 存活 |

---

## 四、各平台测试流程与技术细节

### 1. Windows 测试 (x64)
1. 自动从 Release 下载 `.exe` 安装包。
2. 执行静默安装：`Start-Process -FilePath ".\$installer" -ArgumentList "/S", "/D=C:\TestApp" -Wait`。
3. 查找生成的主可执行文件路径，拉起后台进程并带上 `--no-sandbox --disable-gpu`。
4. 轮询监控 15 秒进程状态（WorkingSet 内存占用、退出代码），验证无早期崩溃后优雅停止进程。

### 2. macOS 测试 (Native ARM64 + Rosetta 2 x86_64)
因 GitHub 官方已彻底下线 x86_64 (Intel) 托管机器，流水线统一采用 Apple Silicon (`macos-latest`) 机器，并结合 macOS 的通用二进制机制：
1. 挂载 DMG 镜像：`hdiutil attach "$DMG_NAME" -mountpoint /Volumes/FireflyInstaller -nobrowse`。
2. 提取 `.app` 目录并移除 Gatekeeper 隔离属性：`xattr -dr com.apple.quarantine "$LOCAL_APP"`。
3. 使用 `lipo -info "$APP_BIN_PATH"` 校验二进制包含的架构（ARM64 与 x86_64）。
4. 分别进行两组 Matrix 验证：
   - **ARM64**：`arch -arm64 "$APP_BIN_PATH"`
   - **x86_64**：`arch -x86_64 "$APP_BIN_PATH"`（由系统内置 Rosetta 2 转译执行）
5. 使用 `pgrep` + `ps -o pid,arch,command` 严格断言当前进程实际运行架构，并完成 15 秒冒烟存活监控。

### 3. Linux DEB 发行版测试
1. 根据 Job 目标架构（`amd64` / `arm64`）下载对应 DEB 包。
2. 启动对应发行版的 Docker 容器（arm64 通过 GitHub Actions 的 QEMU Action 跨架构仿真执行）。
3. 安装基础 GUI 依赖与虚拟显示服务：`xvfb`, `libgtk-3-0`, `libnss3`, `libasound2`, `libgbm1`, `libsecret-1-0` 等。
4. 执行安装：`dpkg -i /tmp/app.deb || apt-get install -f -y`。
5. 启动虚拟显示并拉起主程序：
   ```bash
   xvfb-run -a "$APP_EXEC" --no-sandbox --disable-gpu --disable-dev-shm-usage
   ```
6. 轮询 15 秒确认进程存活且未抛出 Segmentation Fault / glibc 符号丢失等致命异常。

### 4. Linux RPM 发行版测试
1. 在 Fedora / Rocky Linux 容器中安装 `xorg-x11-server-Xvfb`、`gtk3`、`nss`、`alsa-lib`、`mesa-libgbm` 等依赖。
2. 通过 `dnf install -y /tmp/app.rpm` 进行安装。
3. 使用 `xvfb-run -a "$APP_EXEC"` 启动并监控 15 秒。

---

## 五、智能架构匹配与跳过机制 (Guard)

在实际发布场景中，有时一次 Release 只包含了特定架构（例如仅上传了 ARM64 的 deb 包，或仅上传了 x64 的 rpm 包）。

为避免因架构不匹配导致整个流水线报红，流水线内置了**智能架构防御检查**：
- **DEB 检查**：安装前调用 `dpkg-deb -f /tmp/app.deb Architecture`，若包为 `arm64` 而当前容器为 `amd64`，脚本将输出：
  ```
  ⚠️ [SKIPPED] Package architecture (arm64) does not match system (amd64). Skipping test on this container.
  ```
  并以退出码 0 优雅跳过该特定架构组合。
- **RPM 检查**：安装前调用 `rpm -qp --queryformat '%{ARCH}' /tmp/app.rpm`，若架构不匹配同样自动跳过。

---

## 六、同步脚本白名单保护机制

本项目代码由根目录下的 `sync-from-remote.ps1` 脚本从主 monorepo (`firefly-ai-folder`) 的 `apps/desktop` 子目录单向同步而来。

为了防止执行同步重置时丢失桌面特有的流水线配置与脚本，`sync-from-remote.ps1` 实现了**白名单备份与还原机制**：

```powershell
$ProtectedItems = @(".github", "sync-from-remote.ps1", "sync.bat")
```

**保护工作流：**
1. **[0/5] 备份**：在同步开始前，将当前工作区内的 `.github/`、`sync-from-remote.ps1`、`sync.bat` 复制到系统临时安全目录。
2. **[1/5 ~ 4/5] 同步与清理**：执行 Git Sparse-checkout、拉取远程代码、Robocopy 复制并清理排除目录。
3. **[恢复] 还原**：将安全目录中的受保护文件完整还原至项目根目录。
4. **[5/5] Git 提交与推送**：重新初始化本地 Git 仓库，自动将受保护资产一并纳入版本控制并强制推送到目标仓库。

---

## 七、常见问题排查 (FAQ)

### Q1: 为什么 Linux 测试需要使用 `xvfb-run` 和 `--no-sandbox`？
- **答**：GitHub Actions Runner 与 Docker 容器均为无显示器（Headless）环境，Electron 依赖 X11/Wayland 窗口系统，`xvfb-run` 能在内存中创建虚拟显示屏；此外，在 Docker 容器内以 root 身份运行时，Chromium 内核要求必须附带 `--no-sandbox` 参数。

### Q2: 为什么 Debian 10 容器更新软件源会报 404？
- **答**：Debian 10 (Buster) 已进入归档生命周期，官方镜像源已迁移至 `archive.debian.org`。流水线已内置自动识别并替换源地址的修复逻辑。

### Q3: 如何在 Actions 运行结束后查看汇总？
- **答**：流水线末尾包含 `verification-summary` 作业，会在每次运行的 **Job Summary** 页面自动渲染 Markdown 表格，清晰展示 Windows、macOS 及 Linux 各发行版的最终通过状态。

---

## 八、Release 安装包 E2E 全流程功能测试流水线 (`e2e-release-test.yml`)

为了从根本上保障发布的 Release 安装包具备真正的业务可用性，本项目建立了基于真实安装二进制的 **E2E 黄金主链路自动化功能测试流水线**。

### 1. 流水线架构与技术栈
- **测试框架**：Playwright Electron 原生驱动（直接使用 `executablePath` 指向已安装的真实生产二进制）
- **用例编排模式**：串行业务旅程 (`test.describe.serial`)，单次启动应用，全流程各步骤状态连贯，避免频繁冷启动
- **隔离与快照机制**：通过 `--user-data-dir` 隔离系统数据，使用静态预制快照样本库 (`golden-workspace-snapshot`) 支撑测试，并在结束时无缝重置
- **报告生成与在线托管**：测试生成的 Playwright HTML 报告自动部署至仓库的 `gh-pages` 分支，按 `reports/${{ github.run_id }}/` 归档，在 Actions Job Summary 中直接生成一键点击直达的交互式在线测试报告。

### 2. 阶段一：黄金主链路测试用例覆盖
1. **01. 生产包启动与主窗口加载**：验证窗口正常渲染、无白屏，`window.electronAPI` 正常注入
2. **02. 欢迎向导与系统初始化**：检测并完成向导交互，成功进入主界面
3. **03. 挂载测试快照工作区**：挂载标准样本目录，验证工作区列表更新
4. **04. 文件探测与详情展示**：验证文件列表展示与详情面板交互
5. **05. 虚拟目录与维度标签**：验证维度标签筛选与多维过滤联动
6. **06. 工作区重置与环境清理**：验证工作区移除与空状态恢复，物理清理临时文件

### 3. 本地运行与调试命令
```powershell
# 指定已打包或已安装的应用路径执行 E2E 测试
$env:TEST_APP_EXECUTABLE="C:\TestApp\firefly-ai-folder.exe"
pnpm playwright test --config=tests/e2e/release-pkg/config/playwright.release.config.ts

# 查看本地生成的 HTML 报告
pnpm playwright show-report tests/e2e/release-pkg/reports/html
```

