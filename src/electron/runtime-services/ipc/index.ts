export { registerSettingsIPCHandlers } from './settings-ipc-handler'
export { registerCloudModelConfigIPCHandlers } from './cloud-model-config-ipc-handler'
// PRD-0044（S5）：registerLocalModelConfigIPCHandlers（llama/migrate-* 模型迁移 IPC）
// 随模型目录引擎独占管理清退，导出已删除
export { registerFfmpegIpcHandlers } from './ffmpeg-ipc-handler'
