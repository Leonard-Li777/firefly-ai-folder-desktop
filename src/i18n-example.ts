/**
 * VoerkaI18n 命名空间使用示例
 * 演示如何在项目中使用配置的命名空间
 */

import { 
  t, 
  $t, 
  useNamespace, 
  welcomeNS, 
  commonNS, 
  downloadNS,
  settingsNS,
  errorNS,
  analysisNS,
  organizeNS,
  headerNS 
} from './languages';

// 1. 使用基本的翻译函数
console.log('基本翻译示例:');
console.log(t('语言选择')); // 使用默认命名空间

// 2. 使用动态命名空间
console.log('\n动态命名空间示例:');
const welcomeT = useNamespace('welcome');
console.log(welcomeT.t('欢迎使用 - 初始设置'));

const downloadT = useNamespace('download');
console.log(downloadT.t('下载AI模型'));

// 3. 使用预定义的命名空间快捷方式
console.log('\n预定义命名空间快捷方式示例:');
console.log(welcomeNS.t('欢迎使用 - 初始设置'));
console.log(downloadNS.t('下载AI模型'));
console.log(commonNS.t('返回'));
console.log(headerNS.t('最小化窗口'));

// 4. 带参数的翻译
console.log('\n带参数的翻译示例:');
console.log(downloadNS.t('模型将保存至：{path}', { path: '/path/to/models' }));

// 5. 使用 $t 函数（用于模板或插值）
console.log('\n使用 $t 函数示例:');
const template = `当前语言: ${$t('语言选择')}`;
console.log(template);

// 6. React 组件中的使用示例（伪代码）
export const ExampleComponent = () => {
  // 在 React 组件中
  const welcomeTitle = welcomeNS.t('欢迎使用 - 初始设置');
  const downloadTitle = downloadNS.t('下载AI模型');
  const commonButton = commonNS.t('继续');
  
  return {
    welcomeTitle,
    downloadTitle,
    commonButton
  };
};

// 7. 错误处理命名空间示例
export const showError = (errorCode: string) => {
  const errorMessage = errorNS.t('网络连接失败');
  const retryButton = commonNS.t('重试');
  
  return {
    message: errorMessage,
    buttonText: retryButton
  };
};

// 8. 文件分析命名空间示例
export const showAnalysisProgress = () => {
  const progressText = analysisNS.t('正在分析文件...');
  const completedText = analysisNS.t('分析完成');
  
  return {
    progress: progressText,
    completed: completedText
  };
};

// 9. 文件整理命名空间示例
export const showOrganizeOptions = () => {
  const organizeTitle = organizeNS.t('一键整理');
  const customTitle = organizeNS.t('自定义整理');
  
  return {
    organize: organizeTitle,
    custom: customTitle
  };
};

// 10. 头部控制命名空间示例
export const getWindowControls = () => {
  const minimize = headerNS.t('最小化窗口');
  const maximize = headerNS.t('最大化窗口');
  const close = headerNS.t('关闭窗口');
  
  return {
    minimize,
    maximize,
    close
  };
};

export default {
  ExampleComponent,
  showError,
  showAnalysisProgress,
  showOrganizeOptions,
  getWindowControls
};
