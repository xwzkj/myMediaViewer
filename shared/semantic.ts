/** CLIP ViT-B/32 projected vectors. Different model revisions must use different IDs. */
export const SEMANTIC_DIMENSIONS = 512
export interface SemanticSearchStatus {
  ready: boolean
  provider: 'local' | 'remote' | 'unavailable'
  model: string
  dimensions: number
  indexedAssets: number
  indexedWorks: number
  message?: string
  /** 首次使用时正在自动下载模型；界面应展示进度而不是当成错误。 */
  downloading?: boolean
}
export interface SemanticIndexResult { indexed: boolean; reason?: 'cached' | 'unsupported' }
