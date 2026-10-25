import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { dataDir } from './config.js'
import type { Work, MediaKind, Source } from '../shared/types.js'
import { localPixivId } from './pixiv/identity.js'
import { markLibraryChanged } from './library-revision.js'

export interface StoredAsset {
  id: string; workId: string; path: string; filename: string; page: number; kind: MediaKind;
  extension: string; size: number; modified: number; display: boolean
}
export interface StoredWork extends Omit<Work, 'favorite' | 'cover' | 'approximate'> { coverId: string; originalUrl: string }

export const db = new DatabaseSync(path.join(dataDir, 'library.sqlite'))
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS works (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS works_source ON works(source_id);
  CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, work_id TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS assets_work ON assets(work_id);
  CREATE TABLE IF NOT EXISTS favorites (work_id TEXT PRIMARY KEY, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS group_metadata_cache (key TEXT PRIMARY KEY, stamp TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS metadata_cache (path TEXT PRIMARY KEY, stamp TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS translations (key TEXT PRIMARY KEY, data TEXT NOT NULL, created INTEGER NOT NULL);
  -- CLIP vectors are model-specific, little-endian Float32 blobs (512 dimensions).
  -- Keep across unchanged rescans; stale/deleted assets are excluded by the semantic store.
  CREATE TABLE IF NOT EXISTS semantic_embeddings (
    asset_id TEXT NOT NULL, model TEXT NOT NULL, fingerprint TEXT NOT NULL,
    dimensions INTEGER NOT NULL CHECK (dimensions = 512),
    vector BLOB NOT NULL CHECK (length(vector) = 2048), created INTEGER NOT NULL,
    PRIMARY KEY (asset_id, model)
  );
  CREATE INDEX IF NOT EXISTS semantic_embeddings_model ON semantic_embeddings(model);
  -- image_path 是旧版的整页擦字底图；新结果只写 overlay_path（透明擦字覆盖层）。
  CREATE TABLE IF NOT EXISTS manga_translations (
    key TEXT PRIMARY KEY, data TEXT NOT NULL, image_path TEXT, overlay_path TEXT, source_path TEXT, created INTEGER NOT NULL
  );
  -- OCR/擦字预热：只存识别结果与覆盖层，不写译文，因此不会被误当成已翻译缓存。
  CREATE TABLE IF NOT EXISTS manga_prepared_pages (
    key TEXT PRIMARY KEY, data TEXT NOT NULL, image_path TEXT, overlay_path TEXT, source_path TEXT, created INTEGER NOT NULL
  );
  -- 原图指纹 → 结果 key 的映射：自动查询只做一次 stat 就能定位缓存，不必重读整张原图。
  -- 指纹是 size + mtime：刻意保留两者不变的替换无法识别，强制重译会重新校验内容。
  CREATE TABLE IF NOT EXISTS manga_asset_cache (
    asset_id TEXT NOT NULL, language TEXT NOT NULL, version INTEGER NOT NULL,
    key TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, content_hash TEXT NOT NULL,
    created INTEGER NOT NULL, last_used INTEGER NOT NULL,
    PRIMARY KEY (asset_id, language, version)
  );
`)

/**
 * 旧库补列。
 *
 * `CREATE TABLE IF NOT EXISTS` 对已存在的表不会生效，新版本增加的列必须在启动时
 * 显式补上，否则老用户的插入语句会直接报「no column named ...」。
 * 表名与列名都是本文件里的字面量，不接受外部输入。
 */
function ensureColumn(table: string, column: string, definition: string): void {
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name)
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}
ensureColumn('manga_translations', 'overlay_path', 'TEXT')
ensureColumn('manga_translations', 'source_path', 'TEXT')
ensureColumn('manga_prepared_pages', 'overlay_path', 'TEXT')
ensureColumn('manga_prepared_pages', 'source_path', 'TEXT')

export function allWorks(): StoredWork[] {
  return (db.prepare('SELECT data FROM works').all() as { data: string }[]).map(row => JSON.parse(row.data))
}
export function getWork(id: string): StoredWork | undefined {
  const row = db.prepare('SELECT data FROM works WHERE id = ?').get(id) as { data: string } | undefined
  return row ? JSON.parse(row.data) : undefined
}
export function getAsset(id: string): StoredAsset | undefined {
  const row = db.prepare('SELECT data FROM assets WHERE id = ?').get(id) as { data: string } | undefined
  return row ? JSON.parse(row.data) : undefined
}
export function workAssets(id: string): StoredAsset[] {
  return (db.prepare('SELECT data FROM assets WHERE work_id = ?').all(id) as { data: string }[])
    .map(row => JSON.parse(row.data) as StoredAsset).filter(asset => asset.display).sort((a, b) => a.page - b.page)
}
export function favoriteIds(): Set<string> {
  return new Set((db.prepare('SELECT work_id FROM favorites').all() as { work_id: string }[]).map(row => row.work_id))
}
export function setFavorite(id: string, favorite: boolean): void {
  if (favorite) db.prepare('INSERT OR IGNORE INTO favorites VALUES (?, ?)').run(id, Date.now())
  else db.prepare('DELETE FROM favorites WHERE work_id = ?').run(id)
  markLibraryChanged()
}
export function saveSource(source: Source, works: StoredWork[], assets: StoredAsset[], metadata: Array<{key: string; stamp: string; data: string}> = []): void {
  const addWork = db.prepare('INSERT INTO works VALUES (?, ?, ?)')
  const addAsset = db.prepare('INSERT INTO assets VALUES (?, ?, ?)')
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM assets WHERE work_id IN (SELECT id FROM works WHERE source_id = ?)').run(source.id)
    db.prepare('DELETE FROM works WHERE source_id = ?').run(source.id)
    for (const work of works) addWork.run(work.id, source.id, JSON.stringify(work))
    for (const asset of assets) addAsset.run(asset.id, asset.workId, JSON.stringify(asset))
    // 必须在资产重新写入之后再清理：此时表里只剩真正被删除的资源，
    // 否则重扫会把自己刚删掉的这一来源的全部语义向量清空。
    db.prepare('DELETE FROM semantic_embeddings WHERE asset_id NOT IN (SELECT id FROM assets)').run()
    const cache = db.prepare('INSERT OR REPLACE INTO group_metadata_cache VALUES (?, ?, ?)')
    for (const row of metadata) cache.run(row.key, row.stamp, row.data)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  markLibraryChanged()
}
export function toWork(work: StoredWork, favorites: Set<string>): Work {
  const { coverId, originalUrl: _url, ...data } = work
  return { ...data, pixivId: localPixivId(work) || undefined, favorite: favorites.has(work.id), cover: `/api/assets/${coverId}/thumbnail?v=${work.updated}` }
}
