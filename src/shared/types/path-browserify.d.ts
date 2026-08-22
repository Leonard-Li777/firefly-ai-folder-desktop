/**
 * path-browserify 模块类型声明
 */
declare module 'path-browserify' {
  interface IPath {
    normalize(p: string): string
    join(...paths: string[]): string
    resolve(...pathSegments: string[]): string
    isAbsolute(path: string): boolean
    relative(from: string, to: string): string
    dirname(p: string): string
    basename(p: string, ext?: string): string
    extname(p: string): string
    sep: string
    delimiter: string
    parse(pathString: string): {
      root: string
      dir: string
      base: string
      ext: string
      name: string
    }
    format(pathObject: {
      root?: string
      dir?: string
      base?: string
      ext?: string
      name?: string
    }): string
    posix: IPath
    win32: IPath
  }

  const path: IPath
  export = path
}
