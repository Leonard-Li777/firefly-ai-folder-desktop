import React, { useState, useCallback, useMemo } from 'react';
import { FileItem as FileItemComponent } from './FileItem';
import { useFileExplorerStore } from '../../stores/app-store';
import { FileItem as FileType, DirectoryItem } from '@yonuc/types'
import { cn } from '../../lib/utils';
import { t } from '@app/languages';

interface DirectoryTreeProps {
  directories: DirectoryItem[];
  files: FileType[];
  selectedFiles: FileType[];
  onFileSelect: (files: FileType[]) => void;
  onDirectoryChange: (path: string) => void;
  currentPath: string;
}

interface TreeNodeProps {
  item: DirectoryItem | FileType;
  level: number;
  selectedFiles: FileType[];
  onFileSelect: (files: FileType[]) => void;
  onDirectoryChange: (path: string) => void;
  expandedDirectories: Set<string>;
  onToggleDirectory: (path: string) => void;
}

const TreeNode: React.FC<TreeNodeProps> = ({
  item,
  level,
  selectedFiles,
  onFileSelect,
  onDirectoryChange,
  expandedDirectories,
  onToggleDirectory,
}) => {
  const [isExpanded, setIsExpanded] = useState(() => 
    expandedDirectories.has('isDirectory' in item ? item.path : '')
  );

  const isDirectory = 'isDirectory' in item && item.isDirectory;
  const isSelected = !isDirectory && selectedFiles.some(f => f.path === item.path);

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (isDirectory) {
      const newPath = isExpanded ? '' : (item as DirectoryItem).path;
      onToggleDirectory(newPath);
      setIsExpanded(!isExpanded);
    }
  }, [isDirectory, isExpanded, item, onToggleDirectory]);

  const handleSelect = useCallback((pathOrEvent?: string | React.MouseEvent, checked?: boolean) => {
    // 如果是事件对象，忽略参数
    if (typeof pathOrEvent === 'object') {
      pathOrEvent = undefined;
    }
    
    if (!isDirectory) {
      const fileItem = item as FileType;
      const shouldSelect = checked !== undefined ? checked : !isSelected;
      const newSelected = shouldSelect 
        ? [...selectedFiles, fileItem]
        : selectedFiles.filter(f => f.path !== fileItem.path);
      onFileSelect(newSelected);
    }
  }, [isDirectory, isSelected, item, selectedFiles, onFileSelect]);

  const handleDoubleClick = useCallback(() => {
    if (isDirectory) {
      onDirectoryChange((item as DirectoryItem).path);
    }
  }, [isDirectory, item, onDirectoryChange]);

  if (isDirectory) {
    const dirItem = item as DirectoryItem;
    return (
      <div className="tree-node">
        <div
          className={cn(
            'tree-node-content',
            'flex items-center px-2 py-1 hover:bg-gray-100 cursor-pointer transition-colors',
            level > 0 && 'pl-' + (level * 4 + 2)
          )}
          onClick={handleToggle}
          onDoubleClick={handleDoubleClick}
          style={{ paddingLeft: `${level * 20 + 8}px` }}
        >
          <div className="tree-node-toggle w-4 h-4 flex items-center justify-center mr-1">
            {isExpanded ? '▼' : '▶'}
          </div>
          <FileItemComponent
            type="directory"
            name={dirItem.name}
            path={dirItem.path}
            isSelected={false}
            onSelect={handleSelect}
            onDoubleClick={handleDoubleClick}
            size={0}
            modifiedAt={dirItem.modifiedAt}
          />
        </div>
        
        {isExpanded && (
          <div className="tree-node-children">
            {/* 子节点将由父组件递归渲染 */}
          </div>
        )}
      </div>
    );
  }

  const fileItem = item as FileType;
  return (
    <div className="tree-node">
      <div
        className={cn(
          'tree-node-content',
          'flex items-center px-2 py-1 hover:bg-gray-100 cursor-pointer transition-colors',
          isSelected && 'bg-blue-100 hover:bg-blue-200'
        )}
        onClick={handleSelect}
        onDoubleClick={() => {}}
        style={{ paddingLeft: `${level * 20 + 28}px` }}
      >
        <FileItemComponent
          type="file"
          name={fileItem.name}
          path={fileItem.path}
          isSelected={isSelected}
          onSelect={handleSelect}
          onDoubleClick={() => {}}
          size={fileItem.size}
          modifiedAt={fileItem.modifiedAt}
          extension={fileItem.extension}
        />
      </div>
    </div>
  );
};

const buildTree = (
  directories: DirectoryItem[],
  files: FileType[],
  parentPath: string = '',
  level: number = 0
): (DirectoryItem | FileType)[] => {
  const result: (DirectoryItem | FileType)[] = [];
  
  // 添加当前目录下的子目录
  const childDirectories = directories.filter(dir => dir.parentPath === parentPath);
  childDirectories.forEach(dir => {
    result.push(dir);
    // 递归添加子目录的内容
    const children = buildTree(directories, files, dir.path, level + 1);
    result.push(...children);
  });
  
  // 添加当前目录下的文件
  const childFiles = files.filter(file => file.parentPath === parentPath);
  result.push(...childFiles);
  
  return result;
};

export const DirectoryTree: React.FC<DirectoryTreeProps> = ({
  directories,
  files,
  selectedFiles,
  onFileSelect,
  onDirectoryChange,
  currentPath,
}) => {
  const { expandedDirectories, toggleDirectory } = useFileExplorerStore();

  const treeItems = useMemo(() => {
    return buildTree(directories, files);
  }, [directories, files]);

  const handleToggleDirectory = useCallback((path: string) => {
    toggleDirectory(path);
  }, [toggleDirectory]);

  return (
    <div className="directory-tree">
      <div className="directory-tree-header px-3 py-2 bg-gray-50 border-b">
        <span className="text-sm font-medium">{t('目录树')}</span>
      </div>
      
      <div className="directory-tree-content">
        {treeItems.map((item, index) => (
          <TreeNode
            key={item.path}
            item={item}
            level={0}
            selectedFiles={selectedFiles}
            onFileSelect={onFileSelect}
            onDirectoryChange={onDirectoryChange}
            expandedDirectories={expandedDirectories}
            onToggleDirectory={handleToggleDirectory}
          />
        ))}
        
        {treeItems.length === 0 && (
          <div className="directory-tree-empty px-3 py-8 text-center text-gray-500">
            {t('没有找到文件或目录')}
          </div>
        )}
      </div>
    </div>
  );
};
