import { Walker, DepType, type Module } from "flora-colossus";
import * as fs from "node:fs";
import path from "path";
import dotenv from "dotenv";
import os from "os";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { PublisherGithub } from "@electron-forge/publisher-github";
// @ts-ignore
import MakerNSIS from "@felixrieseberg/electron-forge-maker-nsis";
// import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { NotaryToolPasswordCredentials } from "@electron/notarize/lib/types";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require("./package.json");
dotenv.config();

// 存储需要打包的原生模块依赖
let nativeModuleDependenciesToPackage: string[] = [];

// 调试日志文件路径
const LOG_FILE = path.join(__dirname, 'forge-build.log');

function logToFile(msg: string) {
  try {
    // 确保日志文件存在
    if (!fs.existsSync(LOG_FILE)) {
      fs.writeFileSync(LOG_FILE, `Build started at ${new Date().toISOString()}\n`);
    }
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {
    // ignore
  }
}

// 定义各种构建标志和环境变量
const FLAGS = {
  // 是否启用代码签名
  IS_CODESIGNING_ENABLED: false && process.env.IS_CODESIGNING_ENABLED !== "false",
  // Windows 签名工具路径
  SIGNTOOL_PATH:
    process.env.SIGNTOOL_PATH ||
    path.join(
      __dirname,
      "Microsoft.Windows.SDK.BuildTools/bin/10.0.26100.0/x64/signtool.exe",
    ),
  // Azure 代码签名库路径
  AZURE_CODE_SIGNING_DLIB:
    process.env.AZURE_CODE_SIGNING_DLIB ||
    path.join(
      __dirname,
      "Microsoft.Trusted.Signing.Client/bin/x64/Azure.CodeSigning.Dlib.dll",
    ),
  // Azure 元数据 JSON 文件路径
  AZURE_METADATA_JSON_PATH:
    process.env.AZURE_METADATA_JSON ||
    path.resolve(__dirname, "trusted-signing-metadata.json"),
  // Azure 租户 ID
  AZURE_TENANT_ID: process.env.AZURE_TENANT_ID,
  // Azure 客户端 ID
  AZURE_CLIENT_ID: process.env.AZURE_CLIENT_ID,
  // Azure 客户端密钥
  AZURE_CLIENT_SECRET: process.env.AZURE_CLIENT_SECRET,
  // Apple ID（用于 macOS 代码签名）
  APPLE_ID: process.env.APPLE_ID || "felix@yonuc.com",
  // Apple ID 密码
  APPLE_ID_PASSWORD: process.env.APPLE_ID_PASSWORD,
};

// 外部依赖列表 - 移除 @node-llama-cpp 相关依赖，使用官方发布包
const EXTERNAL_DEPENDENCIES = [
  "electron-log",
  "electron-conf",
  "better-sqlite3",
  "sharp",
  "@img/sharp-win32-x64",
  "@img/sharp-libvips-win32-x64",
  "@img/sharp-darwin-x64",
  "@img/sharp-libvips-darwin-x64",
  "@img/sharp-darwin-arm64",
  "@img/sharp-libvips-darwin-arm64",
  "@img/sharp-linux-x64",
  "@img/sharp-libvips-linux-x64",
  "@img/sharp-linux-arm64",
  "@img/sharp-libvips-linux-arm64",
  "@img/sharp-linux-arm",
  "@img/sharp-linuxmusl-x64",
  "@img/sharp-libvips-linuxmusl-x64",
  "@img/sharp-linuxmusl-arm64",
  "@img/sharp-libvips-linuxmusl-arm64",
  // sharp 的嵌套依赖
  "color",
  "color-string",
  "simple-swizzle",
  "color-name",
  "pdf-poppler",
  "bindings",
  "prebuild-install",
  "node-gyp-build", // better-sqlite3 的依赖
  "detect-libc", // 原生模块检测依赖
  "node-addon-api", // 原生模块 API
  "@img/colour",
  'chokidar',
  'canvas',
  'lodash-es',
  'llamaindex',
  '@llamaindex/openai',
  '@llamaindex/env',
  '@llamaindex/core',
  'ajv',
  'fast-deep-equal',
  'fast-uri',
  'json-schema-traverse',
  'require-from-string', // ajv 必需
  'js-tiktoken', // llamaindex 必需
  'base64-js', // 缓冲区处理必需
  '@anthropic-ai/sdk',
  'openai',
  'cohere-ai',
  'portkey-ai',
  'process',
  '@voerkai18n/runtime',
  '@voerkai18n/react',
  '@voerkai18n/formatters',
  '@toon-format/toon',
  'react',
  'react-dom',
  'react-router-dom',
  '@supabase/supabase-js',
  'lucide-react',
  'date-fns',
  'react-window',
  'exifr',
  'music-metadata',
  'textract',
  'libreoffice-convert',
  'fix-path',
  'shell-path',
  'shell-env',
  'execa',
  'strip-final-newline',
  'onetime',
  'mimic-fn',
  'human-signals',
  'merge-stream',
  'get-stream',
  'is-stream',
  'cross-spawn',
  'npm-run-path',
  'path-key',
  'shebang-command',
  'shebang-regex',
  'zod',
  'zustand',
  'node-machine-id',
  'buffer',
  'events',
  'util',
  'stream',
  'inherits',
];

// Windows 签名配置
const windowsSign: any = {
  signToolPath: FLAGS.SIGNTOOL_PATH,
  signWithParams: `/v /dlib ${FLAGS.AZURE_CODE_SIGNING_DLIB} /dmdf ${FLAGS.AZURE_METADATA_JSON_PATH}`,
  timestampServer: "http://timestamp.acs.microsoft.com",
  hashes: ["sha256"],
};

// 初始化设置
setup();

// 资源文件存在性检查，指向根目录的 assets
const absAssetsDir = path.resolve(__dirname, "../../assets");
const absSetupIcon = path.join(absAssetsDir, "icon.ico");
const absLoadingGif = path.join(absAssetsDir, "boot.png"); // 使用实际存在的 boot.png 文件

const config: ForgeConfig = {
  // 钩子函数配置
  hooks: {
    // 在 make 之前，确保依赖正确处理
    preMake: async () => {
      try {
        // 处理 workspace 依赖（特别是在 CI/Linux 环境下）
        const isCI = process.env.CI === 'true';
        const isLinux = process.platform === 'linux';

        if (isCI || isLinux) {
          console.log('[preMake] 检测到 CI/Linux 环境，预处理 workspace 依赖...');

          try {
            // 运行 workspace 依赖准备脚本
            const { execSync } = require('child_process');
            const prepareScript = path.join(__dirname, 'scripts', 'prepare-workspace-deps.js');

            if (fs.existsSync(prepareScript)) {
              console.log('[preMake] 运行 workspace 依赖准备脚本...');
              execSync(`node "${prepareScript}"`, {
                stdio: 'inherit',
                cwd: __dirname
              });
              console.log('[preMake] workspace 依赖准备完成');
            } else {
              console.warn('[preMake] workspace 依赖准备脚本不存在，跳过');
            }
          } catch (workspaceError) {
            console.error('[preMake] workspace 依赖准备失败:', workspaceError);
            // 不要因为这个失败而中断构建，继续尝试
          }
        }

        console.log('[preMake] 使用 NSIS 打包器，无需 7-Zip 配置');
      } catch (e) {
        console.warn('[preMake] 预处理失败：', e);
      }
    },
    // 打包前执行的钩子
    prePackage: async () => {
      nativeModuleDependenciesToPackage = Array.from(
        await getExternalNestedDependencies(EXTERNAL_DEPENDENCIES),
      );

      // 处理 workspace 依赖：将符号链接转换为实际目录
      // 这是为了解决 Linux/CI/macOS 环境下打包时，packager 无法正确处理指向项目外部的符号链接的问题
      const isCI = process.env.CI === 'true';
      const isLinux = process.platform === 'linux';
      const isDarwin = process.platform === 'darwin';
      
      if (isCI || isLinux || isDarwin) {
        console.log(`[prePackage] 检测到 ${process.platform} 环境，转换 workspace 依赖为实际目录 (Dereference)...`);
        const workspaceDir = path.join(__dirname, 'node_modules', '@yonuc');
        if (fs.existsSync(workspaceDir)) {
          const packages = fs.readdirSync(workspaceDir);
          const { execSync } = require('child_process');
          
          for (const pkg of packages) {
            const pkgPath = path.join(workspaceDir, pkg);
            try {
              const stats = fs.lstatSync(pkgPath);
              if (stats.isSymbolicLink()) {
                const realPath = fs.realpathSync(pkgPath);
                console.log(`[prePackage] 转换 ${pkg} -> ${realPath}`);
                
                // 删除符号链接并复制实际内容
                fs.unlinkSync(pkgPath);
                if (process.platform === 'win32') {
                  execSync(`xcopy /E /I /H /Y "${realPath}" "${pkgPath}"`, { stdio: 'ignore' });
                } else {
                  // macOS/Linux 使用 cp -RL
                  execSync(`cp -RL "${realPath}" "${pkgPath}"`, { stdio: 'ignore' });
                }
              }
            } catch (err) {
              console.error(`[prePackage] 转换 ${pkg} 失败:`, err);
            }
          }
        }
      }

      // 删除原生模块内部指向包外的符号链接（.bin 目录）
      // ASAR 打包器会拒绝这些指向包外的符号链接
      // 注意：依赖复制由 package 命令中的 fix-pnpm-modules.js 处理
      console.log('[prePackage] 清理原生模块内部指向包外的符号链接...');
      const nativeModulesWithBin = ['sharp', 'better-sqlite3', 'canvas', 'electron-log'];
      for (const moduleName of nativeModulesWithBin) {
        // 检查模块内部的 node_modules/.bin 目录
        const binPaths = [
          path.join(__dirname, 'node_modules', moduleName, 'node_modules', '.bin'),
          // pnpm 可能在不同位置
          path.join(__dirname, '..', '..', 'node_modules', moduleName, 'node_modules', '.bin'),
        ];
        
        for (const binPath of binPaths) {
          if (fs.existsSync(binPath)) {
            try {
              // 检查是否有指向包外的符号链接
              const entries = fs.readdirSync(binPath);
              let removed = 0;
              for (const entry of entries) {
                const entryPath = path.join(binPath, entry);
                try {
                  const stats = fs.lstatSync(entryPath);
                  if (stats.isSymbolicLink()) {
                    const linkTarget = fs.readlinkSync(entryPath);
                    // 如果链接目标包含向上超过2级的路径（../../..），说明指向包外
                    if (typeof linkTarget === 'string' && /\.\.[/\\]\.\.[/\\]\.\./.test(linkTarget)) {
                      fs.unlinkSync(entryPath);
                      removed++;
                    }
                  }
                } catch {
                  // 忽略无法处理的链接
                }
              }
              // 如果所有链接都已删除，删除整个 .bin 目录
              const remainingEntries = fs.readdirSync(binPath);
              if (remainingEntries.length === 0) {
                fs.rmdirSync(binPath);
                console.log(`[prePackage] 删除空目录: ${binPath}`);
              } else if (removed > 0) {
                console.log(`[prePackage] 从 ${moduleName} 删除了 ${removed} 个指向包外的符号链接`);
              }
            } catch (e: any) {
              console.warn(`[prePackage] 处理 ${binPath} 失败:`, e.message);
            }
          }
        }
      }
    },
    // 打包后清理阶段执行的钩子
    packageAfterPrune: async (
      _forgeConfig,
      buildPath,
      _electronVersion,
      _platform,
      _arch,
    ) => {
      logToFile(`[packageAfterPrune] Starting for buildPath: ${buildPath}`);
      try {
        logToFile('[packageAfterPrune] Cleaning empty directories...');
        const getItems = getItemsFromFolder(buildPath) ?? [];

        // 清理空目录
        for (const item of getItems) {
          const DELETE_EMPTY_DIRECTORIES = true;

          if (item.empty === true) {
            if (DELETE_EMPTY_DIRECTORIES) {
              const pathToDelete = path.normalize(item.path);
              try {
                // 使用 lstatSync 检查，避免损坏的符号链接导致崩溃
                const stats = fs.lstatSync(pathToDelete);

                // 如果是损坏的符号链接（lstat 成功但 stat 失败），直接删除
                if (stats.isSymbolicLink()) {
                  try {
                    fs.statSync(pathToDelete);
                  } catch (e) {
                    logToFile(`[packageAfterPrune] Removing broken symlink: ${pathToDelete}`);
                    fs.unlinkSync(pathToDelete);
                    continue; // 改为 continue，避免退出整个 hook
                  }
                }

                if (!stats.isDirectory()) return;

                const childItems = fs.readdirSync(pathToDelete);
                if (childItems.length === 0) {
                  fs.rmdirSync(pathToDelete);
                  logToFile(`[packageAfterPrune] Removed empty directory: ${pathToDelete}`);
                }
              } catch (e) {
                // 忽略已不存在或无法访问的文件
              }
            }
          }
        }

        // 删除原生模块内部的 .bin 目录，避免 ASAR 打包时符号链接指向包外路径的问题
        // 这些 .bin 目录中的符号链接在 ASAR 打包时会报错："links out of the package"
        const nativeModulesWithBin = ['sharp', 'better-sqlite3', 'canvas'];
        for (const moduleName of nativeModulesWithBin) {
          const binPath = path.join(buildPath, 'node_modules', moduleName, 'node_modules', '.bin');
          if (fs.existsSync(binPath)) {
            try {
              fs.rmSync(binPath, { recursive: true, force: true });
              logToFile(`[packageAfterPrune] Removed .bin directory from ${moduleName}: ${binPath}`);
            } catch (e) {
              logToFile(`[packageAfterPrune] Failed to remove .bin from ${moduleName}: ${e.message}`);
            }
          }
        }

        // 同时删除 node_modules/.bin 目录（如果存在）
        const globalBinPath = path.join(buildPath, 'node_modules', '.bin');
        if (fs.existsSync(globalBinPath)) {
          try {
            // 检查是否有指向包外的符号链接
            const binEntries = fs.readdirSync(globalBinPath);
            let hasExternalLinks = false;
            for (const entry of binEntries) {
              const entryPath = path.join(globalBinPath, entry);
              try {
                const stats = fs.lstatSync(entryPath);
                if (stats.isSymbolicLink()) {
                  const linkTarget = fs.readlinkSync(entryPath);
                  // 如果链接目标是相对路径且包含 ../..，说明可能指向包外
                  if (typeof linkTarget === 'string' && linkTarget.includes('../..')) {
                    hasExternalLinks = true;
                    break;
                  }
                }
              } catch {
                // 忽略无法读取的链接
              }
            }
            
            if (hasExternalLinks) {
              fs.rmSync(globalBinPath, { recursive: true, force: true });
              logToFile(`[packageAfterPrune] Removed node_modules/.bin with external links: ${globalBinPath}`);
            }
          } catch (e) {
            logToFile(`[packageAfterPrune] Failed to process node_modules/.bin: ${e.message}`);
          }
        }

        // 使用官方 llama.cpp 发布包，无需强制安装 node-llama-cpp 二进制文件
        logToFile('[packageAfterPrune] Using official llama.cpp release packages, skipping node-llama-cpp binary installation');
        logToFile('[packageAfterPrune] Done.');
      } catch (e: any) {
        logToFile(`[packageAfterPrune] CRITICAL ERROR: ${e.message}`);
        throw e;
      }
    },
  },
  // 打包器配置
  packagerConfig: {
    // 强制解析并复制符号链接的实际内容，避免 Windows 下创建符号链接的 EPERM 错误
    // 在 macOS 下禁用，因为 derefSymlinks=true 会导致 packager 遍历 broken symlinks (如 esbuild) 而崩溃
    // 配合 ignore 规则保留 .pnpm 目录，确保 macOS 下 pnpm 的符号链接能正确解析
    derefSymlinks: process.platform === 'win32',
    // 显式指定应用名称，确保 macOS 下生成的 .app 名称正确
    name: "yonuc-ai-folder",
    // 显式指定可执行文件名，防止 Linux 打包时找不到二进制文件
    executableName: "yonuc-ai-folder",
    // ASAR 打包配置
    asar: {
      unpackDir: "{node_modules/sharp,node_modules/@img,node_modules/better-sqlite3,node_modules/canvas}",
    },

    // extraResources 配置 - 包含llama-server二进制文件和配置文件
    extraResource: [
      ...(packageJson['ai-platform'] === 'ollama' ? [] : ["build/extraResources/llama"]),
      "build/extraResources/models",
      "build/extraResources/model",      // 模型配置文件目录
      "build/extraResources/configs",
      "build/extraResources/fileDimension",  // 文件维度配置目录
      absAssetsDir,
    ],
    ignore: (file: string) => {
      if (!file) return false;

      const rootPath = process.cwd();
      let absolutePath = path.resolve(file);

      // 统一处理 Windows 和 POSIX 路径
      if (process.platform === 'win32' && !/^[a-zA-Z]:/.test(file)) {
        const cleanFile = file.replace(/^[\\\/]/, '');
        absolutePath = path.join(rootPath, cleanFile);
      }

      let relativePath = path.relative(rootPath, absolutePath);
      relativePath = relativePath.replace(/\\/g, '/');

      // 调试：只记录关键文件的判定过程
      const isCriticalFile = relativePath === 'package.json' || relativePath === '' || relativePath.includes('@yonuc');
      if (isCriticalFile) {
        logToFile(`DEBUG: file=${file}, relativePath=${relativePath}, rootPath=${rootPath}`);
      }

      // 核心规则：绝对不能忽略根目录和 package.json
      if (relativePath === '' || relativePath === 'package.json' || relativePath === './package.json') {
        return false;
      }

      // 核心规则：保留构建产物和资源
      // 注意：
      // - 'out' 是打包器的输出目录，绝对不能包含（会导致递归循环）
      // - 'build' 目录中的 extraResources 已通过 extraResource 配置复制到 resources/，不需要再包含在 app 中
      const keepDirs = ['out_build', 'assets'];
      if (keepDirs.some(dir => relativePath === dir || relativePath.startsWith(`${dir}/`))) {
        return false;
      }

      // 明确忽略 build 目录（extraResources 已通过 extraResource 配置复制）
      if (relativePath === 'build' || relativePath.startsWith('build/')) {
        return true;
      }

      // 原生依赖白名单
      if (relativePath === 'node_modules' || relativePath.startsWith('node_modules/')) {
        // 1. 保留 node_modules 目录本身，否则之后的内容无法访问
        if (relativePath === 'node_modules') return false;

        // 3. 忽略 pnpm 内部目录和不必要的文件
        // 注意：在非 Windows 平台（derefSymlinks=false）下，必须保留 .pnpm 目录，
        // 否则 node_modules 中的软链接将指向不存在的路径，导致 ERR_MODULE_NOT_FOUND
        const shouldIgnorePnpm = process.platform === 'win32' && relativePath.includes('.pnpm');
        
        if (shouldIgnorePnpm ||
          relativePath.includes('.bin') ||
          relativePath.includes('.cache') ||
          relativePath.includes('.npm') ||
          relativePath.includes('.yarn')) {
          return true;
        }

        // 4. 忽略 node_modules 中的开发文件和文档
        if (relativePath.includes('/test/') ||
          relativePath.includes('/tests/') ||
          relativePath.includes('/spec/') ||
          relativePath.includes('/docs/') ||
          relativePath.includes('/doc/') ||
          relativePath.includes('/example/') ||
          relativePath.includes('/examples/') ||
          relativePath.includes('/demo/') ||
          relativePath.includes('/benchmark/') ||
          relativePath.includes('/.github/') ||
          relativePath.includes('/.vscode/') ||
          relativePath.includes('/.idea/') ||
          relativePath.endsWith('.md') ||
          relativePath.endsWith('.txt') ||
          relativePath.endsWith('.yml') ||
          relativePath.endsWith('.yaml') ||
          relativePath.endsWith('.json.map') ||
          relativePath.endsWith('.d.ts.map') ||
          relativePath.endsWith('.js.map') ||
          relativePath.endsWith('.mjs.map') ||
          relativePath.endsWith('.ts') ||
          relativePath.endsWith('.tsx') ||
          relativePath.endsWith('.jsx') ||
          relativePath.endsWith('.coffee') ||
          relativePath.endsWith('.scss') ||
          relativePath.endsWith('.sass') ||
          relativePath.endsWith('.less') ||
          relativePath.endsWith('.styl')) {
          return true;
        }

        // 忽略 workspace 包内部的 node_modules
        // 防止 electron-packager 遍历其中的 broken symlinks (如 .bin/esbuild)
        if (relativePath.includes('@yonuc') && relativePath.includes('/node_modules')) {
          return true;
        }

        // 2. 处理 @yonuc 作用域包 - workspace 依赖
        // 在 CI/Linux 环境下，这些可能是符号链接，需要特殊处理
        if (relativePath.includes('@yonuc')) {
          try {
            const fullPath = path.join(rootPath, relativePath);

            // 检查文件是否存在
            if (!fs.existsSync(fullPath)) {
              logToFile(`Workspace package not found: ${relativePath}`);
              return true; // 忽略不存在的文件
            }

            // 检查是否是符号链接
            const stats = fs.lstatSync(fullPath);
            if (stats.isSymbolicLink()) {
              try {
                // 尝试解析符号链接
                fs.statSync(fullPath);
                logToFile(`Found valid workspace symlink: ${relativePath}`);
                return false; // 保留有效的符号链接
              } catch (e) {
                logToFile(`Found broken workspace symlink: ${relativePath}, error: ${e.message}`);
                return true; // 忽略损坏的符号链接
              }
            }

            // 如果不是符号链接，保留实际内容
            logToFile(`Found workspace package (not symlink): ${relativePath}`);
            return false;
          } catch (e) {
            // 如果无法访问，在 CI 环境下忽略，本地环境保留
            const isCI = process.env.CI === 'true';
            logToFile(`Error accessing workspace package ${relativePath}: ${e.message}, CI: ${isCI}`);
            return isCI; // CI 环境下忽略，本地环境保留
          }
        }

        // 5. 保留作用域目录本身
        if (relativePath.split('/').length === 2 && relativePath.startsWith('node_modules/@')) {
          return false;
        }

        // 6. [优化方案] 对于 node_modules 中的其他模块，默认保留
        // 不再基于白名单逐个放行，而是“除非明确排除，否则保留”
        // 这样可以彻底解决不断出现的“Cannot find module”问题
        return false;
      }

      // 忽略源码、测试、文档、配置文件等
      const ignorePatterns = [
        /^src\//,
        /^tests\//,
        /^test\//,
        /^spec\//,
        /^docs\//,
        /^doc\//,
        /^scripts\//,
        /^out\//,
        /^design\//,
        /^admin\//,
        /^build\//,  // build 目录的内容已通过 extraResource 复制到 resources/，不需要包含在 app 中
        /^coverage\//,
        /^\.nyc_output\//,
        /^\.coverage\//,
        /^\.pytest_cache\//,
        /^__pycache__\//,
        /^\.git/,
        /^\.vscode/,
        /^\.idea/,
        /^\.vs/,
        /^\.venv/,
        /^venv/,
        /^env/,
        /^\.env\.local$/,
        /^\.env\.development$/,
        /^\.env\.test$/,
        /^\.env\.staging$/,
        /^node_modules\/\.cache/,
        /^\.cache/,
        /^\.tmp/,
        /^tmp/,
        /^temp/,
        /^\.temp/,
        /\.zip$/,  // 忽略所有 ZIP 文件，避免打包下载的发布包
        /^node_modules\/pdf-poppler\/lib\/osx/,  // 忽略 pdf-poppler 的 macOS 文件
        /^node_modules\/pdf-poppler\/lib\/linux/,  // 忽略 pdf-poppler 的 Linux 文件
        /^node_modules\/lodash-es\/_/,  // 忽略 lodash-es 内部文件
        /^build\/extraResources\/llama\/.*\.zip$/,  // 忽略 llama 目录中的 ZIP 文件
        /\.ts$/,
        /\.tsx$/,
        /\.jsx$/,
        /\.mts$/,
        /\.cts$/,
        /\.coffee$/,
        /\.scss$/,
        /\.sass$/,
        /\.less$/,
        /\.styl$/,
        /\.map$/,
        /\.d\.ts\.map$/,
        /\.spec\.js$/,
        /\.test\.js$/,
        /\.spec\.ts$/,
        /\.test\.ts$/,
        /^tsconfig/,
        /^\.eslintrc/,
        /^\.prettierrc/,
        /^\.prettierignore$/,
        /^\.gitignore$/,
        /^\.gitattributes$/,
        /^\.editorconfig$/,
        /^\.npmignore$/,
        /^\.yarnrc/,
        /^\.pnpmfile/,
        /^pnpm-lock\.yaml$/,
        /^yarn\.lock$/,
        /^package-lock\.json$/,
        /^Dockerfile/,
        /^docker-compose/,
        /^\.dockerignore$/,
        /^Makefile$/,
        /^Gruntfile/,
        /^gulpfile/,
        /^webpack\.config/,
        /^rollup\.config/,
        /^vite\.config/,
        /^jest\.config/,
        /^vitest\.config/,
        /^babel\.config/,
        /^\.babelrc/,
        /^\.browserslistrc$/,
        /^\.nvmrc$/,
        /^\.node-version$/,
        /^\.python-version$/,
        /^requirements\.txt$/,
        /^Pipfile/,
        /^poetry\.lock$/,
        /^pyproject\.toml$/,
        /^setup\.py$/,
        /^setup\.cfg$/,
        /^tox\.ini$/,
        /^\.travis\.yml$/,
        /^\.github\//,
        /^\.gitlab-ci\.yml$/,
        /^appveyor\.yml$/,
        /^circle\.yml$/,
        /^\.circleci\//,
        /^CHANGELOG/,
        /^HISTORY/,
        /^AUTHORS/,
        /^CONTRIBUTORS/,
        /^COPYING/,
        /^INSTALL/,
        /^NEWS/,
        /^UPGRADE/,
        /^TODO/,
        /^BUGS/,
        /^THANKS/,
        /\.md$/,
        /\.txt$/,
        /\.rst$/,
        /\.adoc$/,
        /\.org$/,
        // 在非 Windows 平台上排除 Windows 特定的二进制文件
        ...(process.platform !== 'win32' ? [
          /node_modules\/@img\/sharp-.*win32/,
          /node_modules\/@img\/sharp-libvips-win32/
        ] : []),
        // 在非 macOS 平台上排除 macOS 特定的二进制文件
        ...(process.platform !== 'darwin' ? [
          /node_modules\/@img\/sharp-.*darwin/,
          /node_modules\/@img\/sharp-libvips-darwin/
        ] : [])
      ];

      const shouldIgnore = ignorePatterns.some(pattern => pattern.test(relativePath));

      // 调试：记录被正则命中的文件
      if (shouldIgnore && relativePath.includes('@img/sharp')) {
         logToFile(`IGNORED by regex: ${relativePath}`);
      }
      
      // 调试：记录未被忽略的 sharp 文件
      if (!shouldIgnore && relativePath.includes('@img/sharp') && relativePath.includes('win32')) {
         logToFile(`WARNING: Windows binary NOT IGNORED: ${relativePath}`);
      }

      if (isCriticalFile && shouldIgnore) {
        logToFile(`WARNING: Critical file ${relativePath} is being ignored!`);
      }

      return shouldIgnore;
    },
    // 应用 Bundle ID（macOS）
    appBundleId: "com.yonuc.yonuc-ai-folder",
    // 应用分类类型（macOS）
    appCategoryType: "public.app-category.productivity",
    // Windows 元数据
    win32metadata: {
      CompanyName: "Yonuc",
      OriginalFilename: "yonuc-ai-folder",
    },
    // macOS 代码签名配置
    osxSign: FLAGS.IS_CODESIGNING_ENABLED
      ? {
        identity: "Developer ID Application: Yonuc (LT94ZKYDCJ)",
      }
      : undefined,
    // macOS 公证配置
    osxNotarize: FLAGS.IS_CODESIGNING_ENABLED && FLAGS.APPLE_ID_PASSWORD
      ? ({
        appleId: FLAGS.APPLE_ID,
        appleIdPassword: FLAGS.APPLE_ID_PASSWORD,
        teamId: "LT94ZKYDCJ",
      } as NotaryToolPasswordCredentials)
      : undefined,
    // Windows 代码签名配置
    windowsSign: FLAGS.IS_CODESIGNING_ENABLED ? windowsSign : undefined,
    // 应用图标路径，指向根目录 assets 下的无后缀路径（Electron Packager 会根据平台自动补全）
    icon: path.join(absAssetsDir, "icon"),
    // 是否保留垃圾文件
    junk: true,
    // 是否覆盖已存在的文件
    overwrite: true,
    // 是否修剪不需要的文件
    prune: false,
    // macOS 通用应用配置
    osxUniversal: {
      mergeASARs: true,
    },
  },
  // 我们已经在 fix-pnpm-modules.js 中手动运行了 pnpm run rebuild:all
  // 根据环境决定是否让 Forge 自动重建原生模块
  // 在 CI 环境下启用以确保干净安装后的兼容性
  // 在本地环境下禁用，因为我们已通过 scripts/fix-pnpm-modules.js (electron-rebuild) 手动处理
  rebuildConfig: {
    onlyModules: (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true')
      ? ['better-sqlite3', 'sharp']
      : [],
    // 在 CI 环境下不强制从源码构建，优先使用已编译好的二进制
    buildFromSource: false
  },
  // 打包器列表
  makers: [
    new MakerNSIS({
      name: "yonuc-ai-folder",
      authors: "Yonuc",
      exe: "yonuc-ai-folder.exe",
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      nsis: {
        oneClick: false,
        allowToChangeInstallationDirectory: true,
        perMachine: true,
        allowElevation: true,
        shortcutName: "Yonuc AI Folder",
        artifactName: `yonuc-ai-folder-${packageJson.version}-setup-${process.arch}.exe`,
        // 多语言支持配置
        language: "SimpChinese",
        displayLanguageSelector: true,
        // 安装程序标题
        installerTitle: "Yonuc AI Folder",
        installerSubtitle: "智能文件管理工具",
        // 允许的语言列表
        allowedLanguages: [
          "SimpChinese", "English", "Japanese", "Korean", 
          "French", "German", "Spanish", "Russian", "Portuguese", "Arabic"
        ],
      }
    }),

    // 备用方案：如果 NSIS 仍然失败，可以快速切换到 Squirrel
    /*
    new MakerSquirrel({
      name: "yonuc-ai-folder",
      authors: "Yonuc",
      exe: "yonuc-ai-folder.exe",
      setupExe: `yonuc-ai-folder-${packageJson.version}-setup.exe`,
      options: {
        name: "yonuc-ai-folder",
        authors: "Yonuc",
        exe: "yonuc-ai-folder.exe"
      }
    }, ["win32"]),
    */

    // macOS - DMG 安装包
    new MakerDMG({
      // 移除 name 属性以允许 Electron Forge 自动按照 version-arch 格式重命名输出文件
      // name: "yonuc-ai-folder", 
      title: "yonuc-ai-folder", // 设置挂载时的卷标名称
      icon: path.join(absAssetsDir, "icon.icns"),
    }, ["darwin"]),

    // Linux - DEB 安装包（Ubuntu/Debian）
    new MakerDeb({
      options: {
        name: "yonuc-ai-folder",
        productName: "yonuc-ai-folder",
        bin: "yonuc-ai-folder",
        maintainer: "Yonuc",
        homepage: "https://yonuc.com",
        description: packageJson.description,
        // 添加 dereference 选项，确保打包时解析符号链接
        // 这样可以彻底解决打包后 resources/app/node_modules/@yonuc 目录下的 broken symlinks 问题
        dereference: true
      }
    }, ["linux"]),

    // Linux - RPM 安装包（RedHat/CentOS/Fedora）
    new MakerRpm({
      options: {
        name: "yonuc-ai-folder",
        productName: "yonuc-ai-folder",
        bin: "yonuc-ai-folder",
        homepage: "https://yonuc.com",
        description: packageJson.description,
        // 添加 dereference 选项，确保打包时解析符号链接
        dereference: true
      }
    }, ["linux"]),
  ],
  // 插件配置
  plugins: [
    // Vite 插件配置
    /*
    new VitePlugin({
      // `build` 可以指定多个入口构建，可以是主进程、预加载脚本、工作进程等
      // 如果你熟悉 Vite 配置，这看起来会很熟悉
      build: [
        {
          // `entry` 只是对应配置文件中 `build.lib.entry` 的别名
          entry: "src/electron/main.ts",
          config: "vite.main.config.mts",
          target: "main",
        },
        {
          entry: "src/electron/preload.ts",
          config: "vite.preload.config.mts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.mts",
        },
      ],
    }),
    */
    // Fuses 插件用于在打包时启用/禁用各种 Electron 功能
    // 在代码签名应用程序之前
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: true,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: false,
    }),
  ],
  // 发布配置
  publishers: [
    new PublisherGithub({
      repository: {
        owner: 'Leonard-Li777',
        name: 'yonuc-ai-folder-desktop'
      },
      prerelease: true
    })
  ],
};

export default config;

/**
 * 辅助函数
 */

// 注释掉 node-llama-cpp 相关函数，因为我们现在使用官方发布包

/*
 * 获取 node-llama-cpp 包的可选依赖项，这些是需要打包的二进制文件
 * 
 * @returns {Array<string>} node-llama-cpp 包的可选依赖项
 */
/*
function getNodeLlamaBinaryDependenciesToKeep(
  arch: string = getArch(),
): Array<string> {
  // 使用官方发布包，不再需要这些依赖
  return [];
}
*/

/*
 * 获取我们不想保留的 node-llama-cpp 二进制文件
 */
/*
function getNodeLlamaBinaryDependenciesToIgnore(): Array<string> {
  // 使用官方发布包，不再需要这个函数
  return [];
}
*/

// 从文件夹获取项目列表的函数
function getItemsFromFolder(
  filePath: string,
  totalCollection: {
    path: string;
    type: "directory" | "file" | "link";
    empty: boolean;
  }[] = [],
) {
  try {
    const normalizedPath = path.normalize(filePath);
    const childItems = fs.readdirSync(normalizedPath);
    const getItemStats = fs.statSync(normalizedPath);

    if (getItemStats.isDirectory()) {
      totalCollection.push({
        path: normalizedPath,
        type: "directory",
        empty: childItems.length === 0,
      });
    }

    childItems.forEach((childItem) => {
      const childItemNormalizedPath = path.join(normalizedPath, childItem);
      // 使用 lstatSync 而不是 statSync，避免在处理损坏的符号链接时抛出 ENOENT
      const childItemStats = fs.lstatSync(childItemNormalizedPath);

      if (childItemStats.isDirectory()) {
        getItemsFromFolder(childItemNormalizedPath, totalCollection);
      } else {
        totalCollection.push({
          path: childItemNormalizedPath,
          type: childItemStats.isSymbolicLink() ? "link" : "file",
          empty: false,
        });
      }
    });
  } catch {
    return;
  }

  return totalCollection;
}

/**
 * 获取指定节点模块名称的所有生产依赖项
 *
 * @param nodeModuleNames 节点模块名称数组
 * @param includeNestedDeps 是否包含嵌套依赖项
 * @returns Promise<Set<string>> 依赖项集合
 */
async function getExternalNestedDependencies(
  nodeModuleNames: string[],
): Promise<Set<string>> {
  const projectRoot = path.normalize(__dirname);
  const foundModules = new Set(nodeModuleNames);

  for (const external of nodeModuleNames) {
    type MyPublicClass<T> = {
      [P in keyof T]: T[P];
    };

    type MyPublicWalker = MyPublicClass<Walker> & {
      modules: Module[];
      walkDependenciesForModule: (
        moduleRoot: string,
        depType: DepType,
      ) => Promise<void>;
    };

    const possibleModuleRoots = [
      path.join(projectRoot, "node_modules", external),
      path.join(projectRoot, "../../node_modules", external)
    ];

    let moduleRoot = '';
    for (const root of possibleModuleRoots) {
      if (fs.existsSync(path.join(root, 'package.json'))) {
        moduleRoot = root;
        break;
      }
    }

    if (!moduleRoot) {
      logToFile(`[ERROR] flora-colossus: Could not find module ${external} in any node_modules`);
      continue;
    }

    const walker = new Walker(moduleRoot) as unknown as MyPublicWalker;

    walker.modules = [];
    try {
      await walker.walkDependenciesForModule(moduleRoot, DepType.PROD);

      walker.modules
        .filter((dep) => (dep.depType as number) === DepType.PROD)
        .map((dep) => dep.name.split("/")[0])
        .forEach((name) => foundModules.add(name));
    } catch (e) {
      logToFile(`[WARNING] flora-colossus: Failed to walk dependencies for ${external}: ${e.message}`);
    }
  }

  return foundModules;
}

/**
 * 打包前运行的设置函数
 */
function setup() {
  if (process.platform === "win32") {
    // 确保 Windows 代码签名文件存在
    if (!fs.existsSync(FLAGS.SIGNTOOL_PATH)) {
      console.warn("SignTool path does not exist, disabling codesigning");
      FLAGS.IS_CODESIGNING_ENABLED = false;
    }
    if (!fs.existsSync(FLAGS.AZURE_CODE_SIGNING_DLIB)) {
      console.warn("Azure codesigning DLib path does not exist, disabling codesigning");
      FLAGS.IS_CODESIGNING_ENABLED = false;
    }

    // 设置 TEMP 环境变量
    process.env.TEMP = process.env.TMP = path.join(
      os.homedir(),
      "AppData",
      "Local",
      "Temp",
    );

    // 写入 Azure 代码签名元数据
    fs.writeFileSync(
      FLAGS.AZURE_METADATA_JSON_PATH,
      JSON.stringify(
        {
          Endpoint:
            process.env.AZURE_CODE_SIGNING_ENDPOINT ||
            "https://wcus.codesigning.azure.net",
          CodeSigningAccountName: process.env.AZURE_CODE_SIGNING_ACCOUNT_NAME,
          CertificateProfileName:
            process.env.AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME,
        },
        null,
        2,
      ),
    );
  }
}

// 获取架构类型
function getArch() {
  // 如果在 CI 环境中运行，使用传入的架构
  // 如果有人传递了标志，我们也使用该标志
  if (process.env.CI || process.argv.some((s) => s.includes("arch"))) {
    return process.argv.some((s) => s.includes("--arch=arm64")) ? "arm64" : "x64";
  }

  return process.arch;
}

/*
 * node-llama-cpp 二进制文件在其 package.json 中有一个 cpu 标志，这意味着
 * 它们需要一点强制才能安装
 * 
 * 注释掉此函数，因为我们现在使用官方 llama.cpp 发布包
 *
 * @param buildPath 构建路径
 */
/*
async function forceInstallNodeLlamaBinaries(buildPath: string, arch: string) {
  // 使用官方发布包，不再需要这个函数
  logToFile('Using official llama.cpp release packages, skipping node-llama-cpp binary installation');
}
*/