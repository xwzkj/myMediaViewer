import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { stat, realpath } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { sources, saveSources, port, allowPublicAccess } from './config.js'
import { isLocalAddress } from './access.js'
import { allWorks, getAsset, getWork, workAssets, favoriteIds, setFavorite, toWork, db } from './database.js'
import { refreshSearch, searchWorks, suggestTags } from './search.js'
import { scanLibrary, scanStatus, onScan, sourceOnline } from './scanner.js'
import { accessibleAsset, sendMedia, thumbnail, detectFFmpeg, ffmpegAvailable, convert, conversionStatus, conversionPath } from './media.js'
import type { Source, LibraryStatus } from '../shared/types.js'
import { listDirectories } from './directories.js'

export async function createApp(logging = true) {
  const app = Fastify({ logger: logging, bodyLimit: 16_384 })
  refreshSearch()
  onScan(refreshSearch)
  await detectFFmpeg()
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin')
    // 默认只服务局域网：公网地址、以及任何经过代理转发的请求（本机反向代理/隧道同样会看起来像 127.0.0.1）都拒绝，
    // 除非显式设置 ALLOW_PUBLIC_ACCESS。
    const forwarded = request.headers['x-forwarded-for'] || request.headers['x-real-ip'] || request.headers.forwarded
    if (!allowPublicAccess && (forwarded || !isLocalAddress(request.ip))) {
      return reply.code(403).send({ message: '当前只允许局域网直接访问。如需公网或经由代理访问，请设置环境变量 ALLOW_PUBLIC_ACCESS=1 后重启服务。' })
    }
    // API access is same-origin. Reject browser cross-site writes to the LAN service.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin
      if (request.headers['sec-fetch-site'] === 'cross-site' || (origin && new URL(origin).host !== request.headers.host)) {
        return reply.code(403).send({ message: '不允许跨站请求' })
      }
    }
  })
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    request.log.error(error)
    reply.code(error.statusCode || 500).send({ message: error.statusCode && error.statusCode < 500 ? error.message : '服务器处理失败，请检查运行日志' })
  })

  app.get('/api/status', async (): Promise<LibraryStatus> => {
    const works = allWorks()
    const favorites = favoriteIds()
    return {
      works: works.length, files: works.reduce((total, w) => total + w.count, 0), favorites: works.filter(w => favorites.has(w.id)).length,
      images: works.filter(w => w.kind === 'image').length, videos: works.filter(w => w.kind === 'video').length,
      animations: works.filter(w => w.kind === 'animation').length,
      sources: sources.map(s => ({ ...s, works: works.filter(w => w.sourceId === s.id).length, online: sourceOnline.get(s.id) ?? existsSync(s.path) })),
      scan: scanStatus, ffmpeg: ffmpegAvailable,
      addresses: Object.values(networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => `http://${i!.address}:${port}`),
      publicAccess: allowPublicAccess,
    }
  })
  app.post('/api/scan', async (_request, reply) => {
    if (scanStatus.running) return reply.code(409).send({ message: '正在扫描，请稍候' })
    void scanLibrary().catch(error => app.log.error(error))
    return reply.code(202).send(scanStatus)
  })

  app.get<{ Querystring: { path?: string } }>('/api/directories', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', maxLength: 4096 } } } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return listDirectories(request.query.path)
  })

  const sourceBody = {
    type: 'object', additionalProperties: false, required: ['name', 'path', 'kind'],
    properties: { name: { type: 'string', minLength: 1, maxLength: 60 }, path: { type: 'string', minLength: 1, maxLength: 2048 }, kind: { type: 'string', enum: ['pixiv', 'telegram'] } },
  } as const
  async function validateSource(body: Omit<Source, 'id'>, except?: string) {
    const raw = body.path.trim().replace(/^"|"$/g, '')
    if (!path.isAbsolute(raw)) throw Object.assign(new Error('请输入服务器上的完整目录路径'), { statusCode: 400 })
    let resolved: string
    try {
      resolved = await realpath(raw)
      if (!(await stat(resolved)).isDirectory()) throw new Error()
    } catch { throw Object.assign(new Error('目录不存在或服务器没有读取权限'), { statusCode: 400 }) }
    const canonical = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p
    if (sources.some(s => s.id !== except && canonical(path.resolve(s.path)) === canonical(resolved))) {
      throw Object.assign(new Error('这个目录已经在媒体库中'), { statusCode: 409 })
    }
    if (!body.name.trim()) throw Object.assign(new Error('请输入目录名称'), { statusCode: 400 })
    return { name: body.name.trim(), path: resolved, kind: body.kind }
  }
  app.post<{ Body: Omit<Source, 'id'> }>('/api/sources', { schema: { body: sourceBody } }, async (request, reply) => {
    if (scanStatus.running) return reply.code(409).send({ message: '扫描完成后再修改目录' })
    const source = { ...await validateSource(request.body), id: randomUUID() }
    if (scanStatus.running) return reply.code(409).send({ message: '扫描完成后再修改目录' })
    saveSources([...sources, source])
    void scanLibrary().catch(error => app.log.error(error))
    return reply.code(201).send(source)
  })
  app.put<{ Params: { id: string }; Body: Omit<Source, 'id'> }>('/api/sources/:id', { schema: { body: sourceBody } }, async (request, reply) => {
    if (scanStatus.running) return reply.code(409).send({ message: '扫描完成后再修改目录' })
    const existing = sources.find(s => s.id === request.params.id)
    if (!existing) return reply.code(404).send({ message: '目录不存在' })
    const source = { ...await validateSource(request.body, existing.id), id: existing.id }
    if (scanStatus.running) return reply.code(409).send({ message: '扫描完成后再修改目录' })
    saveSources(sources.map(s => s.id === existing.id ? source : s))
    void scanLibrary().catch(error => app.log.error(error))
    return source
  })
  app.delete<{ Params: { id: string } }>('/api/sources/:id', async (request, reply) => {
    if (scanStatus.running) return reply.code(409).send({ message: '扫描完成后再修改目录' })
    if (!sources.some(s => s.id === request.params.id)) return reply.code(404).send({ message: '目录不存在' })
    saveSources(sources.filter(s => s.id !== request.params.id))
    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM assets WHERE work_id IN (SELECT id FROM works WHERE source_id = ?)').run(request.params.id)
      db.prepare('DELETE FROM favorites WHERE work_id IN (SELECT id FROM works WHERE source_id = ?)').run(request.params.id)
      db.prepare('DELETE FROM works WHERE source_id = ?').run(request.params.id)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    refreshSearch()
    return { ok: true }
  })

  app.get<{ Querystring: { q?: string } }>('/api/tags', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { q: { type: 'string', maxLength: 500 } } } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return suggestTags(request.query.q || '')
  })

  app.get<{ Querystring: { q?: string; source?: string; kind?: string; favorites?: string; page?: string; sort?: string; fuzzy?: string; by?: string } }>('/api/works', async request => {
    const started = performance.now()
    const query = request.query
    const favorites = favoriteIds()
    // kind 支持逗号分隔的多个值，例如 kind=video,animation：界面把视频和动图合并成了一个筛选。
    const kinds = (query.kind || '').split(',').map(value => value.trim()).filter(Boolean)
    let results = searchWorks((query.q || '').slice(0, 500), query.fuzzy === 'true').filter(({ work }) =>
      (!query.source || work.sourceId === query.source) && (!kinds.length || kinds.includes(work.kind))
      && (query.favorites !== 'true' || favorites.has(work.id)))
    if (!query.q?.trim() || query.sort !== 'relevance') {
      // by=collected 时「最新 / 最早」指收藏顺序（文件名开头的收藏编号），否则仍按发布日期。
      // 收藏编号只在同一个媒体目录内部可比：Pixiv 的 bmk_id 和 Telegram 的消息号含义与量级都不同，
      // 所以结果里涉及多个来源（混合显示）时忽略 by=collected，退回发布日期排序。
      const byCollected = query.by === 'collected' && new Set(results.map(({ work }) => work.sourceId)).size === 1
      const collected = (work: { collected?: number }) => work.collected ?? 0
      const compare = query.sort === 'title' ? (a: typeof results[number], b: typeof results[number]) => a.work.title.localeCompare(b.work.title, 'zh-CN')
        : query.sort === 'oldest' ? (a: typeof results[number], b: typeof results[number]) => byCollected
          ? collected(a.work) - collected(b.work) || a.work.updated - b.work.updated
          : a.work.date.localeCompare(b.work.date)
          : (a: typeof results[number], b: typeof results[number]) => byCollected
            ? collected(b.work) - collected(a.work) || b.work.updated - a.work.updated
            : b.work.date.localeCompare(a.work.date)
      results = results.sort(compare)
    }
    const pages = Math.max(1, Math.ceil(results.length / 48))
    const page = Math.min(pages, Math.max(1, Math.floor(Number(query.page)) || 1))
    return { items: results.slice((page - 1) * 48, page * 48).map(({ work, approximate }) => ({ ...toWork(work, favorites), approximate })), total: results.length, page, pages, elapsed: Math.round(performance.now() - started) }
  })
  app.get<{ Params: { id: string } }>('/api/works/:id', async (request, reply) => {
    const work = getWork(request.params.id)
    if (!work) return reply.code(404).send({ message: '作品不存在' })
    return { ...toWork(work, favoriteIds()), originalUrl: /^https?:\/\//.test(work.originalUrl) ? work.originalUrl : '',
      assets: workAssets(work.id).map(({ path: _path, display: _display, ...asset }) => ({ ...asset, url: `/api/assets/${asset.id}/file`, thumbnail: `/api/assets/${asset.id}/thumbnail?v=${asset.modified}` })) }
  })
  app.put<{ Params: { id: string }; Body: { favorite: boolean } }>('/api/works/:id/favorite', {
    schema: { body: { type: 'object', required: ['favorite'], additionalProperties: false, properties: { favorite: { type: 'boolean' } } } },
  }, async (request, reply) => {
    if (!getWork(request.params.id)) return reply.code(404).send({ message: '作品不存在' })
    setFavorite(request.params.id, request.body.favorite)
    return { favorite: request.body.favorite }
  })

  app.get<{ Params: { id: string } }>('/api/assets/:id/file', async (request, reply) => {
    const asset = getAsset(request.params.id)
    if (!asset || !await accessibleAsset(asset)) return reply.code(404).send({ message: '文件不存在或媒体目录离线' })
    return sendMedia(request, reply, asset.path, asset.extension)
  })
  app.get<{ Params: { id: string } }>('/api/assets/:id/thumbnail', async (request, reply) => {
    const asset = getAsset(request.params.id)
    if (!asset || !await accessibleAsset(asset)) return reply.code(404).send({ message: '文件不存在或媒体目录离线' })
    try { return sendMedia(request, reply, await thumbnail(asset), 'webp') }
    catch {
      return reply.type('image/svg+xml').header('Cache-Control', 'private, max-age=60').send('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"><rect width="640" height="480" fill="#e1e8dd"/><path d="M290 190v100l85-50Z" fill="#788a75"/></svg>')
    }
  })
  app.post<{ Params: { id: string } }>('/api/assets/:id/convert', async (request, reply) => {
    const asset = getAsset(request.params.id)
    if (!asset || !await accessibleAsset(asset)) return reply.code(404).send({ message: '文件不存在或媒体目录离线' })
    if (asset.kind === 'image' || asset.extension === 'gif') return reply.code(400).send({ message: '该文件不需要视频转换' })
    return reply.code(202).send(convert(asset))
  })
  app.get<{ Params: { id: string } }>('/api/assets/:id/convert', async (request, reply) => {
    const asset = getAsset(request.params.id)
    return asset ? conversionStatus(asset) : reply.code(404).send({ message: '文件不存在' })
  })
  app.get<{ Params: { id: string } }>('/api/assets/:id/compatible', async (request, reply) => {
    const asset = getAsset(request.params.id)
    if (!asset || !await accessibleAsset(asset) || conversionStatus(asset).state !== 'ready') return reply.code(404).send({ message: '兼容版本尚未就绪' })
    return sendMedia(request, reply, conversionPath(asset), 'mp4')
  })

  const webRoot = path.resolve('dist')
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot })
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || path.extname(request.url.split('?')[0])) return reply.code(404).send({ message: '未找到内容' })
      return reply.sendFile('index.html')
    })
  }
  return app
}
