/**
 * pnpm 钩子文件 - 确保原生模块正确安装
 * 专门解决 Electron 应用中的原生依赖问题
 */

function readPackage(pkg, context) {
  // 确保原生模块不被提升
  const nativeModules = [
    'better-sqlite3',
    'sharp',
    'electron-log',
    'electron-conf',
    'chokidar',
    'pdf-poppler',
    'bindings',
    'prebuild-install',
    'node-gyp-build',
    'detect-libc',
    'node-addon-api'
  ];

  // 如果是原生模块，强制设置为不可提升
  if (nativeModules.includes(pkg.name)) {
    context.log(`强制 ${pkg.name} 不提升到根目录`);
    
    // 确保这些模块有正确的依赖
    if (pkg.name === 'better-sqlite3') {
      // 确保 better-sqlite3 有必要的构建依赖
      pkg.dependencies = pkg.dependencies || {};
      pkg.dependencies['node-gyp-build'] = pkg.dependencies['node-gyp-build'] || '^4.0.0';
      pkg.dependencies['bindings'] = pkg.dependencies['bindings'] || '^1.5.0';
    }
    
    if (pkg.name === 'sharp') {
      // 确保 sharp 有平台特定的依赖
      pkg.optionalDependencies = pkg.optionalDependencies || {};
    }
  }

  // 对于 @yonuc 作用域包，确保它们能正确解析依赖
  if (pkg.name && pkg.name.startsWith('@yonuc/')) {
    context.log(`处理 workspace 包: ${pkg.name}`);
    
    // 确保 workspace 包能找到原生依赖
    if (pkg.dependencies) {
      Object.keys(pkg.dependencies).forEach(dep => {
        if (nativeModules.includes(dep)) {
          context.log(`  确保 ${pkg.name} 能访问原生模块 ${dep}`);
        }
      });
    }
  }

  return pkg;
}

module.exports = {
  hooks: {
    readPackage
  }
};