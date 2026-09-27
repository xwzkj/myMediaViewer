export type SourceKind = 'pixiv' | 'telegram'
export type MediaKind = 'image' | 'video' | 'animation'
export interface Source { id: string; name: string; kind: SourceKind; path: string }
export interface Asset {
  id: string; workId: string; filename: string; page: number; kind: MediaKind;
  extension: string; size: number; modified: number; url: string; thumbnail: string
}
export interface Work {
  id: string; sourceId: string; sourceName: string; sourceKind: SourceKind; externalId: string;
  title: string; author: string; description: string; tags: string[]; date: string;
  // 文件名开头的收藏编号（Pixiv 的 bmk_id / Telegram 的消息号），用于按收藏顺序排序。
  collected: number;
  updated: number; count: number; kind: MediaKind; favorite: boolean; cover: string;
  approximate?: boolean
}
export interface WorkDetail extends Work { assets: Asset[]; originalUrl: string }
export interface ScanStatus {
  running: boolean; phase: string; files: number; works: number; startedAt: number | null;
  finishedAt: number | null; errors: string[]
}
export interface LibraryStatus {
  works: number; files: number; favorites: number; images: number; videos: number; animations: number;
  sources: Array<Source & { works: number; online: boolean }>;
  scan: ScanStatus; ffmpeg: boolean; addresses: string[]
}
export interface WorksResponse { items: Work[]; total: number; page: number; pages: number; elapsed: number }
export interface TagSuggestion { name: string; count: number }
export interface TagSuggestionsResponse { items: TagSuggestion[]; total: number }
export interface DirectoryEntry { name: string; path: string }
export interface DirectoryListing {
  path: string | null; parent: string | null;
  breadcrumbs: DirectoryEntry[]; directories: DirectoryEntry[]
}
