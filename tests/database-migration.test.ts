import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 升级回归：`CREATE TABLE IF NOT EXISTS` 不会给已存在的表补列。
 *
 * 旧库的 manga_translations / manga_prepared_pages 没有 overlay_path 和 source_path，
 * 如果启动时不 ALTER，所有漫画写入都会报「no column named overlay_path」——
 * 而这发生在译文已经付费生成之后，代价很高。
 */
test('旧库启动时补齐漫画缓存新增列并保留旧数据', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'media-migrate-'))
  process.env.MEDIA_DATA_DIR = dir
  const legacy = new DatabaseSync(path.join(dir, 'library.sqlite'))
  legacy.exec(`
    CREATE TABLE manga_translations (key TEXT PRIMARY KEY, data TEXT NOT NULL, image_path TEXT, created INTEGER NOT NULL);
    CREATE TABLE manga_prepared_pages (key TEXT PRIMARY KEY, data TEXT NOT NULL, image_path TEXT, created INTEGER NOT NULL);
    INSERT INTO manga_translations VALUES ('legacy-key', '{"key":"legacy-key"}', NULL, 1);
  `)
  legacy.close()

  const { db } = await import('../server/database.js')
  try {
    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name)
    for (const table of ['manga_translations', 'manga_prepared_pages']) {
      assert.ok(columns(table).includes('overlay_path'), `${table} 需要 overlay_path`)
      assert.ok(columns(table).includes('source_path'), `${table} 需要 source_path`)
    }
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM manga_translations').get() as { n: number }).n, 1, '旧数据必须保留')
    // 新列必须真的可写，否则迁移只做了半截。
    db.prepare('INSERT INTO manga_prepared_pages (key, data, image_path, overlay_path, source_path, created) VALUES (?, ?, ?, ?, ?, ?)')
      .run('new-key', '{"key":"new-key"}', null, '/tmp/overlay.png', '/tmp/source.png', 2)
    assert.equal((db.prepare('SELECT source_path FROM manga_prepared_pages WHERE key = ?').get('new-key') as { source_path: string }).source_path, '/tmp/source.png')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
