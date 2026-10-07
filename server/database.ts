import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { dataDir } from './config.js'
import type { Work, MediaKind, Source } from '../shared/types.js'

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
  CREATE TABLE IF NOT EXISTS manga_translations (
    key TEXT PRIMARY KEY, data TEXT NOT NULL, image_path TEXT, created INTEGER NOT NULL
  );
`)

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
    const cache = db.prepare('INSERT OR REPLACE INTO group_metadata_cache VALUES (?, ?, ?)')
    for (const row of metadata) cache.run(row.key, row.stamp, row.data)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
export function toWork(work: StoredWork, favorites: Set<string>): Work {
  const { coverId, originalUrl: _url, ...data } = work
  return { ...data, favorite: favorites.has(work.id), cover: `/api/assets/${coverId}/thumbnail?v=${work.updated}` }
}
