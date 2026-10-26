import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { BackgroundTaskKind, BackgroundTaskState } from '../../shared/background.js'

export interface Task { id: string; source_id: string; asset_id: string; stamp: string; kind: BackgroundTaskKind; state: BackgroundTaskState; message: string }
export type SourceRunState = 'running' | 'paused' | 'stopped'
export class BackgroundQueue {
  constructor(readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS background_tasks (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL, asset_id TEXT NOT NULL, stamp TEXT NOT NULL,
        kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', message TEXT NOT NULL DEFAULT '', updated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS background_tasks_pick ON background_tasks(state,updated);
      CREATE INDEX IF NOT EXISTS background_tasks_source ON background_tasks(source_id,asset_id);
      CREATE TABLE IF NOT EXISTS background_sources (
        source_id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'running', consent TEXT NOT NULL DEFAULT '',
        file_count INTEGER, checked INTEGER, message TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS background_usage (
        source_id TEXT NOT NULL, day TEXT NOT NULL, pages INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(source_id,day)
      );
    `)
    // A paid call interrupted by a restart may already have been billed. Never retry it automatically.
    db.exec(`UPDATE background_tasks SET state='failed',message='服务重启时翻译未确认完成；可能已计费，请人工检查后重试' WHERE state='running' AND kind='translate';
      UPDATE background_tasks SET state='queued' WHERE state='running';`)
    // 旧版本把超过 40 MP 的页面永久标失败；现在会先缩小再识别，重新排队一次。
    // 语义索引还曾把 CLIP 的 40 MP 解码上限误报成“服务不可用”，同批恢复。
    // 只处理不收费的任务，并尊重来源当前的停止状态。
    db.prepare(`UPDATE background_tasks SET
      state = CASE WHEN (SELECT state FROM background_sources WHERE source_id=background_tasks.source_id)='stopped' THEN 'stopped' ELSE 'queued' END,
      message = '', updated = ?
      WHERE state='failed' AND (
        (kind IN ('ocr','semantic') AND message LIKE ?)
        OR (kind='semantic' AND message=?)
      )`).run(Date.now(), '%超过单页 40 MP 上限%', '远程计算端没有可用的 CLIP 语义编码服务')
  }
  ensure(sourceId: string) { this.db.prepare('INSERT OR IGNORE INTO background_sources(source_id) VALUES (?)').run(sourceId) }
  control(sourceId: string): { state: SourceRunState; consent: string; file_count: number | null; checked: number | null; message: string } {
    this.ensure(sourceId)
    return this.db.prepare('SELECT state,consent,file_count,checked,message FROM background_sources WHERE source_id=?').get(sourceId) as ReturnType<BackgroundQueue['control']>
  }
  setState(sourceId: string, state: SourceRunState) {
    this.ensure(sourceId)
    this.db.prepare('UPDATE background_sources SET state=?,message=? WHERE source_id=?').run(state, '', sourceId)
    if (state === 'stopped') this.db.prepare("UPDATE background_tasks SET state='stopped' WHERE source_id=? AND state='queued'").run(sourceId)
    if (state === 'running') this.db.prepare("UPDATE background_tasks SET state='queued' WHERE source_id=? AND state='stopped'").run(sourceId)
  }
  consent(sourceId: string, fingerprint: string) {
    this.ensure(sourceId)
    this.db.prepare('UPDATE background_sources SET consent=? WHERE source_id=?').run(fingerprint, sourceId)
  }
  message(sourceId: string, text: string) {
    this.ensure(sourceId)
    this.db.prepare('UPDATE background_sources SET message=? WHERE source_id=?').run(text.slice(0, 1000), sourceId)
  }
  fileCount(sourceId: string, count: number, now: number) {
    this.ensure(sourceId)
    this.db.prepare('UPDATE background_sources SET file_count=?,checked=?,message=? WHERE source_id=?').run(count, now, '', sourceId)
  }
  enqueue(sourceId: string, assetId: string, stamp: string, kind: BackgroundTaskKind, now = Date.now()) {
    const id = createHash('sha256').update(JSON.stringify([sourceId,assetId,stamp,kind])).digest('hex')
    // Remove stale versions but leave an in-flight row intact until it reaches its cancellation checkpoint.
    this.db.prepare("DELETE FROM background_tasks WHERE source_id=? AND asset_id=? AND kind=? AND id<>? AND state<>'running'").run(sourceId,assetId,kind,id)
    const state = this.control(sourceId).state === 'stopped' ? 'stopped' : 'queued'
    this.db.prepare('INSERT OR IGNORE INTO background_tasks(id,source_id,asset_id,stamp,kind,state,updated) VALUES (?,?,?,?,?,?,?)').run(id,sourceId,assetId,stamp,kind,state,now)
    return id
  }
  next(sourceId: string, kinds?: BackgroundTaskKind[]): Task | undefined {
    if (this.control(sourceId).state !== 'running') return undefined
    if (!kinds?.length) {
      return this.db.prepare("SELECT * FROM background_tasks WHERE source_id=? AND state='queued' ORDER BY updated,id LIMIT 1").get(sourceId) as Task | undefined
    }
    const placeholders = kinds.map(() => '?').join(',')
    return this.db.prepare(`SELECT * FROM background_tasks WHERE source_id=? AND state='queued' AND kind IN (${placeholders}) ORDER BY updated,id LIMIT 1`).get(sourceId, ...kinds) as Task | undefined
  }
  mark(id: string, state: BackgroundTaskState, message = '') {
    this.db.prepare('UPDATE background_tasks SET state=?,message=?,updated=? WHERE id=?').run(state,message.slice(0,1000),Date.now(),id)
  }
  retry(sourceId: string) {
    this.db.prepare("UPDATE background_tasks SET state='queued',message='' WHERE source_id=? AND state='failed'").run(sourceId)
  }
  counts(sourceId: string): Record<BackgroundTaskState, number> {
    const counts = { queued:0, running:0, done:0, failed:0, stopped:0 }
    for (const row of this.db.prepare('SELECT state,COUNT(*) n FROM background_tasks WHERE source_id=? GROUP BY state').all(sourceId) as Array<{state:BackgroundTaskState;n:number}>) counts[row.state] = row.n
    return counts
  }
  usage(sourceId: string, now = Date.now()): { pages: number; requests: number } {
    const day = new Date(now).toISOString().slice(0,10)
    return (this.db.prepare('SELECT pages,requests FROM background_usage WHERE source_id=? AND day=?').get(sourceId,day) as { pages:number;requests:number } | undefined) || { pages:0,requests:0 }
  }
  reserve(sourceId: string, kind: 'pages' | 'requests', limit: number, now = Date.now()): boolean {
    const day = new Date(now).toISOString().slice(0,10)
    this.db.prepare('INSERT OR IGNORE INTO background_usage(source_id,day) VALUES (?,?)').run(sourceId,day)
    return Number(this.db.prepare(`UPDATE background_usage SET ${kind}=${kind}+1 WHERE source_id=? AND day=? AND ${kind}<?`).run(sourceId,day,limit).changes) === 1
  }
  removeDisabled(sourceId: string, kinds: BackgroundTaskKind[]) {
    for (const kind of ['semantic','ocr','translate'] as const) if (!kinds.includes(kind)) {
      this.db.prepare("DELETE FROM background_tasks WHERE source_id=? AND kind=? AND state<>'running'").run(sourceId,kind)
    }
  }
  removeSource(sourceId: string) {
    this.db.prepare('DELETE FROM background_tasks WHERE source_id=?').run(sourceId)
    this.db.prepare('DELETE FROM background_sources WHERE source_id=?').run(sourceId)
    // Keep daily usage so toggling/removing configuration cannot reset a billing budget.
  }
}
