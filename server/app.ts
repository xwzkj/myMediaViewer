import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { stat, realpath } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { sources, saveSources, port, allowPublicAccess } from './config.js'
import { isLocalAddress } from './access.js'
import { allWorks, getAsset, getWork, workAssets, favoriteIds, setFavorite, toWork, db, type StoredAsset } from './database.js'
import { refreshSearch, searchWorks, suggestTags } from './search.js'
import { scanLibrary, scanStatus, onScan, sourceOnline } from './scanner.js'
import { accessibleAsset, sendMedia, thumbnail, detectFFmpeg, ffmpegAvailable, convert, conversionStatus, conversionPath } from './media.js'
import type { Source, LibraryStatus, AiTranslateFields } from '../shared/types.js'
import { listDirectories } from './directories.js'
import { getAiSettings, saveAiSettings, testAiConnection, listAiModels, translateFields, clearTranslationCache } from './ai.js'
import { getMangaJob, getMangaModelStatus, mangaBaseImagePath, startMangaTranslation } from './ai/manga/service.js'
import { debugLogging, logApi, logError, logInfo, setLoggingEnabled } from './log.js'

export async function createApp(logging = true) {
  setLoggingEnabled(logging)
  // 默认关掉 Fastify 的逐请求日志：常规运行使用下方的精简日志。
  // 常驻输出改由下面的 onResponse 钩子整理成「方法 + 路径 + 状态码 + 耗时」；
  // 需要排查问题时，用 LOG_LEVEL=debug 启动即可启用默认逐请求日志。
  const app = Fastify({ logger: logging && debugLogging ? { level: 'info' } : false, bodyLimit: 16_384 })
  const onScanFailed = (error: unknown) => logError('扫描', `扫描失败：${(error as Error).message}`, error)
  // 由错误处理器记录过的请求不再重复打印状态码行。
  const reportedErrors = new WeakSet<object>()
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
  app.setErrorHandler((error: Error & { statusCode?: number; expose?: boolean }, request, reply) => {
    const status = error.statusCode || 500
    // 业务错误（AiError 等）的 message 已经能说明问题，只记一行；其余异常附上调用栈。
    reportedErrors.add(request)
    logError('接口', `${request.method} ${request.url.split('?')[0]} · ${status} · ${error.message}`.trim(), error.expose ? undefined : error)
    // expose 的错误（例如 AI 配置或上游返回问题）直接把原因告诉用户，其余保持笼统提示。
    // 如果是 AI 相关的操作或错误明确带了 message，把具体的错误详情返回给前端；仅当未捕获异常且无消息时兜底
    const message = error.message || '服务器处理失败，请检查运行日志'
    reply.code(status).send({ message })
  })

  // 接口调用日志：只保留人工触发的 API，前端轮询和媒体二进制请求交给各自的进度日志汇报。
  const isQuietRoute = (method: string, url: string) => {
    if (url === '/api/status') return true
    if (method !== 'GET' && method !== 'HEAD') return false
    return /^\/api\/ai\/manga\/jobs\/[^/]+$/.test(url)
      || /^\/api\/assets\/[^/]+\/(file|thumbnail|convert|compatible)$/.test(url)
      || /^\/api\/ai\/manga\/cache\/[^/]+\/base\.png$/.test(url)
  }
  app.addHook('onResponse', async (request, reply) => {
    if (!logging || debugLogging) return
    const url = request.url.split('?')[0] || ''
    if (!url.startsWith('/api/') || isQuietRoute(request.method, url)) return
    // 4xx/5xx 已经由错误处理器连原因一起记录过，这里只补成功请求。
    if (reportedErrors.has(request)) return
    logApi(request.method, url, reply.statusCode, reply.elapsedTime)
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
    void scanLibrary({ reason: 'manual' }).catch(onScanFailed)
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
    logInfo('目录', `新增「${source.name}」· ${source.path}`)
    void scanLibrary().catch(onScanFailed)
    return reply.code(201).send(source)
  })
  app.put<{ Params: { id: string }; Body: Omit<Source, 'id'> }>('/api/sources/:id', { schema: { body: sourceBody } }, async (request, reply) => {
    if (scanStatus.running) return reply.code(409).send({ message: '扫描完成后再修改目录' })
    const existing = sources.find(s => s.id === request.params.id)
    if (!existing) return reply.code(404).send({ message: '目录不存在' })
    const source = { ...await validateSource(request.body, existing.id), id: existing.id }
    if (scanStatus.running) return reply.code(409).send({ message: '扫描完成后再修改目录' })
    saveSources(sources.map(s => s.id === existing.id ? source : s))
    logInfo('目录', `更新「${source.name}」· ${source.path}`)
    void scanLibrary().catch(onScanFailed)
    return source
  })
  app.delete<{ Params: { id: string } }>('/api/sources/:id', async (request, reply) => {
    if (scanStatus.running) return reply.code(409).send({ message: '扫描完成后再修改目录' })
    const removed = sources.find(s => s.id === request.params.id)
    if (!removed) return reply.code(404).send({ message: '目录不存在' })
    saveSources(sources.filter(s => s.id !== request.params.id))
    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM assets WHERE work_id IN (SELECT id FROM works WHERE source_id = ?)').run(request.params.id)
      db.prepare('DELETE FROM favorites WHERE work_id IN (SELECT id FROM works WHERE source_id = ?)').run(request.params.id)
      db.prepare('DELETE FROM works WHERE source_id = ?').run(request.params.id)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    refreshSearch()
    logInfo('目录', `移除「${removed.name}」，已清理该目录的索引和收藏记录`)
    return { ok: true }
  })

  app.get<{ Querystring: { q?: string } }>('/api/tags', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { q: { type: 'string', maxLength: 500 } } } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return suggestTags(request.query.q || '')
  })

  app.get<{ Querystring: { q?: string; source?: string; kind?: string; favorites?: string; page?: string; sort?: string; fuzzy?: string; by?: string; seed?: string } }>('/api/works', async request => {
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
      // 随机顺序：用查询串里的 seed 做可复现的乱序，翻页时顺序保持稳定，不会重复或漏掉作品。
      const seed = query.seed || '0'
      const shuffleKey = (work: { id: string }) => {
        let hash = 2166136261
        const text = seed + work.id
        for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619) }
        return hash >>> 0
      }
      const compare = query.sort === 'random' ? (a: typeof results[number], b: typeof results[number]) => shuffleKey(a.work) - shuffleKey(b.work)
        : query.sort === 'title' ? (a: typeof results[number], b: typeof results[number]) => a.work.title.localeCompare(b.work.title, 'zh-CN')
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

  app.get('/api/ai/settings', async () => getAiSettings())
  app.put<{ Body: Record<string, unknown> }>('/api/ai/settings', async request => {
    const saved = saveAiSettings(request.body)
    logInfo('配置', `AI 接口设置已更新 · 模型 ${saved.model || '未选择'} · ${saved.baseUrl}`)
    return saved
  })
  // 测试与模型列表允许带上设置页里还没保存的表单内容，避免必须“先保存才能测试”。
  app.post<{ Body?: unknown }>('/api/ai/test', async request => testAiConnection(request.body))
  app.post<{ Body?: unknown }>('/api/ai/models', async request => ({ items: await listAiModels(request.body) }))
  app.delete('/api/ai/cache', async () => {
    const removed = clearTranslationCache()
    logInfo('缓存', `已清空 ${removed} 条作品翻译缓存`)
    return { removed }
  })
  app.post<{ Body: { fields?: AiTranslateFields; targetLanguage?: string; force?: boolean } }>('/api/ai/translate', async request => {
    const body = request.body || {}
    return translateFields({ fields: body.fields || {}, targetLanguage: body.targetLanguage, force: body.force === true })
  })
  app.get('/api/ai/manga/status', async () => getMangaModelStatus())
  app.post<{ Body: { assetId?: string; assetIds?: string[]; force?: boolean } }>('/api/ai/manga/translate', async (request, reply) => {
    const body = request.body || {}
    const requested = Array.isArray(body.assetIds) ? body.assetIds : [body.assetId]
    const assetIds = [...new Set(requested.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    if (!assetIds.length) return reply.code(400).send({ message: '没有选择要翻译的图片' })
    const assets: StoredAsset[] = []
    for (const assetId of assetIds) {
      const asset = getAsset(assetId)
      if (!asset || !await accessibleAsset(asset)) return reply.code(404).send({ message: '图片不存在或媒体目录离线' })
      if (asset.kind !== 'image' || asset.extension === 'gif') return reply.code(400).send({ message: '只有静态图片支持漫画翻译' })
      assets.push(asset)
    }
    return startMangaTranslation(assets, body.force === true)
  })
  app.get<{ Params: { id: string } }>('/api/ai/manga/jobs/:id', async (request, reply) => {
    const job = getMangaJob(request.params.id)
    return job || reply.code(404).send({ message: '翻译任务不存在或服务已重启' })
  })
  app.get<{ Params: { key: string } }>('/api/ai/manga/cache/:key/base.png', async (request, reply) => {
    const image = mangaBaseImagePath(request.params.key)
    if (!image) return reply.code(404).send({ message: '漫画翻译缓存不存在' })
    return sendMedia(request, reply, image, 'png')
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
