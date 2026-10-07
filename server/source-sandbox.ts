import { Worker } from 'node:worker_threads'
import type { SourceRules, ScriptInput, MetadataFields } from '../shared/types.js'
import { validateRulesShape } from './source-rules.js'

type Task = { type: 'validate' | 'match' | 'extract'; rules: SourceRules; names?: string[]; input?: ScriptInput }
type Job = { task: Task; resolve(value: any): void; reject(error: Error): void }
type Slot = { worker: Worker; ready: boolean; job?: Job; timer?: ReturnType<typeof setTimeout> }
const slots = new Set<Slot>(), queue: Job[] = []
function dispose(slot: Slot, error: Error) {
  clearTimeout(slot.timer); slots.delete(slot)
  slot.worker.removeAllListeners(); void slot.worker.terminate()
  slot.job?.reject(error); slot.job = undefined
  pump()
}
function dispatch(slot: Slot) {
  slot.worker.ref()
  slot.timer = setTimeout(() => dispose(slot, new Error('规则或脚本执行超时（2 秒）')), 2000)
  slot.worker.postMessage(slot.job!.task)
}
function pump() {
  for (const slot of slots) {
    if (!slot.ready || slot.job || !queue.length) continue
    slot.job = queue.shift()!; dispatch(slot)
  }
  while (queue.length && slots.size < 2) {
    const url = new URL(import.meta.url.endsWith('.ts') ? './source-worker.ts' : './source-worker.js', import.meta.url)
    const code = url.pathname.endsWith('.ts')
      ? `import('tsx/esm/api').then(m => m.tsImport(${JSON.stringify(url.href)}, ${JSON.stringify(import.meta.url)}))`
      : `import(${JSON.stringify(url.href)})`
    const worker = new Worker(code, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 128 } })
    // Reserve during startup: initialization failures reject a real job instead of retrying forever.
    const slot: Slot = { worker, ready: false, job: queue.shift()! }; slots.add(slot)
    slot.timer = setTimeout(() => dispose(slot, new Error('沙箱启动超时')), 15000)
    worker.on('message', message => {
      if (message.ready) { clearTimeout(slot.timer); slot.ready = true; dispatch(slot); return }
      const job = slot.job; slot.job = undefined; clearTimeout(slot.timer); worker.unref()
      if (message.ok) job?.resolve(message.result)
      else { job?.reject(new Error(message.error)); dispose(slot, new Error(message.error)); return }
      pump()
    })
    worker.on('error', error => dispose(slot, error))
    worker.on('exit', code => { if (slots.has(slot)) dispose(slot, new Error(`沙箱已退出 (${code})`)) })
  }
}
export function sandbox<T = unknown>(task: Task): Promise<T> {
  if (queue.length >= 32) return Promise.reject(new Error('沙箱任务队列已满，请稍后重试'))
  return new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); pump() })
}
export async function validateRules(rules: unknown): Promise<void> {
  validateRulesShape(rules)
  await sandbox({ type: 'validate', rules })
}
export function normalizeMetadata(value: unknown): MetadataFields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('提取结果必须为对象')
  const data = value as Record<string, unknown>
  const output: MetadataFields = { title: '', author: '', description: '', date: '', originalUrl: '', tags: [] }
  for (const key of ['title', 'author', 'description', 'date', 'originalUrl'] as const) {
    const v = data[key]
    if (v === undefined) continue
    if (typeof v !== 'string' || v.length > (key === 'description' ? 100000 : key === 'originalUrl' ? 4096 : 2000)) throw new Error(`字段 ${key} 类型或长度无效`)
    output[key] = v.trim()
  }
  if (data.tags !== undefined) {
    if (!Array.isArray(data.tags) || data.tags.length > 1000 || data.tags.some(t => typeof t !== 'string' || t.length > 200)) throw new Error('tags 必须是最多 1000 个短字符串')
    output.tags = [...new Set(data.tags.map(t => t.trim().replace(/^#/, '')).filter(Boolean))]
  }
  if (output.date && !Number.isFinite(Date.parse(output.date))) throw new Error('date 不是有效日期')
  if (output.originalUrl) {
    let url: URL
    try { url = new URL(output.originalUrl) } catch { throw new Error('originalUrl 必须是 HTTP(S) URL') }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('originalUrl 必须是 HTTP(S) URL')
  }
  return output
}
