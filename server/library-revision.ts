/**
 * 媒体库数据版本。
 *
 * 搜索索引、标签统计等派生数据不必每次请求都重建：它们只在媒体库内容真的变化时
 * 失效。这里提供一个进程内的递增版本号，由真正写入数据的模块递增。
 *
 * 只解决「派生数据复用」，不承担任何调度或并发控制。
 */
let revision = 0

/** 当前版本号。只读。 */
export function libraryRevision(): number {
  return revision
}

/** 数据写入后调用，让所有派生缓存失效。 */
export function markLibraryChanged(): void {
  revision++
}
