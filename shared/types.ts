export type SourceKind = 'pixiv' | 'telegram' | 'custom'
export type MediaKind = 'image' | 'video' | 'animation'
export type WorkOrigin = 'local' | 'pixiv'
export type PixivBookmarkRestrict = 'public' | 'private'
export interface FileRule { mode: 'template' | 'regex'; pattern: string; caseSensitive: boolean; defaultPage?: number; target?: 'filename' | 'relativePath' | 'directory' | 'directoryName' }
export interface SourceRules {
  version: 1; media: FileRule; metadata: FileRule[];
  scope: 'source' | 'directory'; duplicates: 'all' | 'page';
  typeOverrides: Record<string, MediaKind>; script: string;
  preset?: 'pixiv' | 'telegram'
}
// kind is retained for API compatibility/display only, never for scanning.
export interface Source { id: string; name: string; kind: SourceKind; path: string; rules?: SourceRules; pixivWorks?: boolean }
export interface MetadataFields { title: string; author: string; description: string; tags: string[]; date: string; originalUrl: string }
export interface ScriptFile {
  filename: string; relativePath: string; directory?: string; directoryName?: string; extension: string; size: number; modified: number;
  captures: Record<string, string>; page?: number; sequence?: number
}
export interface ScriptInput { id: string; directory: string; media: ScriptFile[]; files: Array<ScriptFile & { text: string }> }
export interface SourcePreview {
  token?: string; enumerated: number; truncated: boolean; errors: string[];
  groups: Array<{ id: string; directory: string; media: string[]; metadata: string[]; captures?: Array<{ relativePath: string; metadata: boolean; captures: Record<string, string> }>; result?: MetadataFields; error?: string }>
}
export interface Asset {
  id: string; workId: string; filename: string; page: number; kind: MediaKind;
  extension: string; size: number; modified: number; url: string; thumbnail: string
  /** local: 由媒体库扫描得到；pixiv: 由服务端代理并按需缓存。 */
  origin?: WorkOrigin
  /** Pixiv 作品 ID；本地资源也可携带，用于与云端收藏合并。 */
  illustId?: string
}
export interface WorkMembership { id: string; name: string; kind: SourceKind; origin: WorkOrigin }
export interface CloudBookmarkState { bookmarked: boolean; restrict: PixivBookmarkRestrict }
export interface Work {
  id: string; sourceId: string; sourceName: string; sourceKind: SourceKind; externalId: string;
  title: string; author: string; description: string; tags: string[]; date: string;
  // 文件名开头的收藏编号（Pixiv 的 bmk_id / Telegram 的消息号），用于按收藏顺序排序。
  collected: number;
  updated: number; count: number; kind: MediaKind; favorite: boolean; cover: string;
  approximate?: boolean
  /** 缺省按 local 处理，兼容旧 API 数据。 */
  origin?: WorkOrigin
  /** 该条目是否拥有可直接播放的本地媒体。 */
  hasLocal?: boolean
  /** Pixiv 作品 ID；存在时可使用云端收藏与云推荐。 */
  pixivId?: string
  /** Pixiv 画师（创作者）ID；存在时可进入创作者主页。作者名仍沿用 author 字符串。 */
  pixivUserId?: string
  /** 该条目所属的全部本地/虚拟来源；首个为主要来源。 */
  memberships?: WorkMembership[]
  /** null 表示状态未知；undefined 表示该作品不支持云收藏。 */
  cloudBookmark?: CloudBookmarkState | null
  /**
   * 服务端确认媒体已不可用（例如 Pixiv 收藏夹里已删除/不可见的作品只剩 placeholder 图）。
   * 这类作品可能没有可用的发布日期，列表排序时一律排在可用作品之后。
   */
  unavailable?: boolean
}
export interface WorkDetail extends Work { assets: Asset[]; originalUrl: string }
export interface ScanStatus {
  running: boolean; phase: string; files: number; works: number; startedAt: number | null;
  finishedAt: number | null; errors: string[]
}
export interface LibraryStatus {
  works: number; files: number; favorites: number; images: number; videos: number; animations: number;
  sources: Array<Source & { works: number; online: boolean }>;
  scan: ScanStatus; ffmpeg: boolean; addresses: string[]; publicAccess: boolean
}
export interface WorksResponse { items: Work[]; total: number; page: number; pages: number; elapsed: number }
export interface PixivAccount {
  id: string; name: string; account: string; premium: boolean; avatarUrl?: string
}
export interface PixivSettings {
  localMode: boolean
  configured: boolean
  account: PixivAccount | null
  defaultBookmarkRestrict: PixivBookmarkRestrict
  autoBookmarkTags: boolean
  cacheLimitMb: number
}
export interface PixivMirrorStatus {
  restrict: PixivBookmarkRestrict
  started: boolean
  phase: 'idle' | 'backfilling' | 'maintaining' | 'ready' | 'error'
  pages: number
  items: number
  lastSynced: number | null
  lastFullSweep: number | null
  error: string
}
export interface PixivCacheStatus {
  bytes: number
  files: number
  limitBytes: number
}
export interface PixivStatus {
  settings: PixivSettings
  cache: PixivCacheStatus
  mirrors: Record<PixivBookmarkRestrict, PixivMirrorStatus>
}
export interface PixivSearchResponse {
  items: Work[]
  nextCursor: string | null
  elapsed: number
}
export interface PixivSearchSuggestionsResponse {
  items: Array<{ name: string; translatedName: string }>
}
/** Pixiv 画师（创作者）摘要：id/name 必需，其余可选；统计一律不编造。 */
export interface PixivUserSummary {
  id: string
  name: string
  account?: string
  comment?: string
  avatarUrl?: string
  isFollowed?: boolean
}
/** Pixiv 画师档案：摘要的可选扩展，仅展示上游返回的公开信息。 */
export interface PixivUserProfile extends PixivUserSummary {
  backgroundUrl?: string
  webpage?: string
  twitterUrl?: string
  totalIllusts?: number
  totalManga?: number
  totalNovels?: number
  totalFollows?: number
  location?: string
  job?: string
  gender?: string
  workspace?: Array<{ label: string; value: string }>
}
export interface PixivUserSearchResponse {
  items: PixivUserSummary[]
  nextCursor: string | null
  elapsed: number
}
export interface PixivBookmarkUpdateResult {
  bookmarked: boolean
  restrict: PixivBookmarkRestrict
  tagsApplied: boolean
  warning?: string
}
export interface TagSuggestion { name: string; count: number }
export interface TagSuggestionsResponse { items: TagSuggestion[]; total: number }
/**
 * 漫画翻译的流水线模式。
 *
 * - sequential：逐页走完「检测 → OCR → 翻译 → 回填」再处理下一页（默认，内存占用最低）。
 * - merged：先把所有页检测与 OCR 完，再把整部文本合并成尽量少的几次大模型调用。
 * - parallel：同 merged 的本地识别阶段，但按页并发调用大模型，并发数可配置。
 */
export type MangaPipelineMode = 'sequential' | 'merged' | 'parallel' | 'streaming'

// AI 翻译：服务端保存的接口配置。
export interface AiSettings {
  baseUrl: string; apiKey: string; model: string; targetLanguage: string;
  // 用户可编辑的追加提示词，会拼在内置系统提示词之后。
  appendPrompt: string; params: Record<string, unknown>; timeoutMs: number
  outputMode: 'prompt' | 'json_schema' | 'json_object'
  // 漫画翻译流水线，默认边识别边并发翻译。
  mangaPipelineMode: MangaPipelineMode
  // parallel 和 streaming 模式同时发出的翻译请求数上限。
  mangaConcurrency: number
  mangaAutoShowTranslated: boolean
}
// 可供翻译的文字字段，键名与模型输出的 JSON 保持一致。
export interface AiTranslateFields {
  title?: string; author?: string; description?: string; tags?: string[]
}
export interface AiTranslateResult {
  fields: AiTranslateFields; cached: boolean; model: string; createdAt: number; targetLanguage: string
}
export interface AiConnectionResult { reply: string; model: string; elapsed: number }

// 漫画图片翻译：坐标统一使用原图像素。前端 Canvas 直接按这些坐标绘制。
export interface MangaRegion {
  id: number
  x: number; y: number; width: number; height: number
  source: string; translation: string
  /** CTD 检测置信度。 */
  detection: number
  /** manga-ocr 的每 token 几何平均置信度。 */
  confidence: number
  /** 服务端擦字时估出的气泡底色，供 Canvas 兜底。 */
  background: string
  /** 根据底色亮度选出的文字颜色。 */
  textColor: string
}

export interface MangaPageResult {
  key: string
  width: number; height: number
  /** 已擦除有译文区域的底图；若本页没有可翻译文本则回退到原图 URL。 */
  baseUrl: string
  regions: MangaRegion[]
  cached: boolean
  model: string
  targetLanguage: string
  createdAt: number
}

export interface MangaJobResult {
  assetId: string
  result: MangaPageResult
}

export interface MangaJobFailure {
  assetId: string
  message: string
}

export interface MangaJob {
  id: string
  state: 'queued' | 'processing' | 'ready' | 'failed'
  /** 面向用户展示的阶段文本，不再依赖百分比表达进度。 */
  stage: string
  progress: number
  /** 本次任务包含的图片总数与已完成数量。 */
  total: number
  completed: number
  currentAssetId?: string
  message?: string
  result?: MangaPageResult
  /** 翻译整部时，逐张返回已经完成的结果。 */
  results?: MangaJobResult[]
  failed?: MangaJobFailure[]
}

export interface MangaModelStatus {
  ready: boolean
  device: string
  models: Array<{ name: string; ready: boolean; files: string[]; missing: string[] }>
  message?: string
}

export interface DirectoryEntry { name: string; path: string }
export interface DirectoryListing {
  path: string | null; parent: string | null;
  breadcrumbs: DirectoryEntry[]; directories: DirectoryEntry[]
}

export interface SourceAiSample { token: string; tree: string; truncated: boolean; lines: number }
/** read_directory 返回的一页目录列表。 */
export interface SourceAiDirectoryRead { path: string; offset: number; length: number; total: number; hasMore: boolean; entries: Array<{ name: string; type: 'file' | 'directory' }> }
/** preview_rules 与真实预览共用的紧凑分组摘要。 */
export interface SourceAiPreviewSummary {
  enumerated: number; matched: number; groupCount: number; truncated: boolean; errors: string[]
  groups: Array<{ id: string; directory: string; media: number; metadata: number; sample: string[] }>
}
/** ask_user 工具抛给用户的问题：选项按推荐度从高到低排列。 */
export interface SourceAiQuestionOption { summary: string; description: string }
export interface SourceAiQuestion { id: string; question: string; why?: string; options: SourceAiQuestionOption[]; answer?: string }
export interface SourceAiToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  status: 'running' | 'complete' | 'error'
  /** read_directory 为 SourceAiDirectoryRead；preview_rules 为 SourceAiPreviewSummary。 */
  result?: unknown
  error?: string
  /** 这一轮已经调用过的次数，界面用来提示模型反复读取目录。 */
  round?: number
  /** 模型给这次调用写的目的，折叠状态也直接显示，方便回看。 */
  reason?: string
  /** 实际回给模型的紧凑文本（TOON），界面按原样展示输出。 */
  text?: string
}
export interface SourceAiMessage { role: 'user' | 'assistant' | 'tool'; text: string; toolCall?: SourceAiToolCall; result?: SourceAiResult }
export interface SourceAiResult { conversationId: string; contextTrimmed: boolean; rules: SourceRules; explanation: string; model: string; messages?: SourceAiMessage[]; toolEvents?: SourceAiToolCall[] }
export type SourceAiStreamEvent =
  | { type: 'status'; message?: string }
  | { type: 'reasoning_delta'; text?: string }
  | { type: 'assistant_delta'; text?: string }
  | { type: 'tool_call'; call?: SourceAiToolCall }
  | { type: 'tool_result'; call?: SourceAiToolCall }
  | { type: 'question'; question?: SourceAiQuestion }
  | { type: 'result'; result: SourceAiResult }
  | { type: 'done' }
  | { type: 'error'; message: string; status?: number }
