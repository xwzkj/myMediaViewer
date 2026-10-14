import mitt from 'mitt'

export interface WorkReturnPayload {
  workId: string
  returnPath: string
  /**
   * 来源页实例 pid（从 recorded from 解析而来）：来源只认发往自己的返回。
   * 详情自己的 pid 不在此字段中，避免来源按自身 pid 比较永远不匹配。
   */
  sourcePid?: string
  /** 前后翻页导致当前作品与来源锚点不一致时，来源页可直接定位而不重置。 */
  changed?: boolean
}

export interface PixivAuthChangedPayload {
  configured: boolean
  localMode: boolean
  /** 账号 id：同 configured/localMode 下换账号也必须失效缓存。 */
  accountId?: string
}

export interface PixivBookmarkSyncedPayload {
  illustId: string
  bookmarked: boolean
  restrict: 'public' | 'private'
}

type AppEvents = {
  'work:return': WorkReturnPayload
  'pixiv:auth-changed': PixivAuthChangedPayload
  'pixiv:bookmark-synced': PixivBookmarkSyncedPayload
}

export const appEvents = mitt<AppEvents>()
