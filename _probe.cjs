const ts = require('D:/workspace/firefly-ai-folder/apps/desktop/node_modules/typescript')
const fs = require('fs')
const Module = require('module')
const srcPath =
  'D:/workspace/firefly-ai-folder/apps/desktop/src/electron/config/local-workflow-source.ts'
let code = fs.readFileSync(srcPath, 'utf-8')
// 与脚本一致的 @app/languages 剥离
code = code.replace(
  /import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*(['"])@app\/languages\1/g,
  'const { t } = { t: (s) => s };'
)
// 沙箱内不需要 @firefly 类型，做无害替换
const proTypesIndex =
  'D:/workspace/firefly-ai-folder/apps/desktop/pro/packages/types/src/index.ts'.replace(/\\/g, '/')
const proSharedIndex =
  'D:/workspace/firefly-ai-folder/apps/desktop/pro/packages/shared/src/index.ts'.replace(/\\/g, '/')
code = code.replace(/from\s*(['"])@firefly\/types\1/g, `from '${proTypesIndex}'`)
code = code.replace(/from\s*(['"])@firefly\/shared\1/g, `from '${proSharedIndex}'`)
const js = ts.transpileModule(code, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true
  }
}).outputText
const tmp = 'D:/workspace/firefly-ai-folder/apps/desktop/_wf_probe.cjs'
fs.writeFileSync(tmp, js + '\nmodule.exports = { workflows: LOCAL_WORKFLOW_SOURCE() };\n')
try {
  const data = require(tmp)
  const wf = data.workflows.find(w => w.id === 'builtin.workflow.embedded-iot-firmware')
  const w = wf.workspace_config.extensionWeights
  const sum = Object.values(w).reduce((a, b) => a + b, 0)
  console.log('固件套条目数:', Object.keys(w).length)
  console.log('总和:', sum)
  console.log('.pdf:', w['.pdf'])
  console.log('总数:', data.workflows.length)
} finally {
  fs.unlinkSync(tmp)
}
