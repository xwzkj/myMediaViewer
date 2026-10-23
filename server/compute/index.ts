// 必须最先导入：下面的端口、Key、模型目录都在模块加载时读取 process.env。
import '../env.js'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { createComputeApp } from './app.js'
import { MangaEngine } from '../ai/manga/engine.js'
import { modelRoot } from '../ai/manga/models.js'
import { COMPUTE_MAX_UPLOAD_BYTES, COMPUTE_PROTOCOL_VERSION } from '../../shared/compute.js'
import { logError, logInfo, logWarn } from '../log.js'

/**
 * 远程计算端入口。
 *
 * 与主服务同一个项目、同一个计算核心，但用独立进程和独立端口启动：
 *   pnpm run dev:compute     开发态（tsx watch）
 *   pnpm run start:compute   构建后运行
 *
 * 只读取计算相关环境变量，不读取媒体目录配置，也不打开媒体数据库。
 */
const port = Number(process.env.COMPUTE_PORT || 3211)
const host = process.env.COMPUTE_HOST || '0.0.0.0'
const apiKey = (process.env.COMPUTE_API_KEY || '').trim()
const workDir = path.resolve(process.env.COMPUTE_WORK_DIR || path.join('data-compute', 'work'))
const threads = Number(process.env.COMPUTE_INTRA_OP_THREADS)

if (!apiKey) {
  console.error('远程计算端缺少 COMPUTE_API_KEY，拒绝启动。请写进仓库根目录的 .env，或在启动前设置同名环境变量；主服务的设置页要填同一个 Key。')
  process.exit(1)
}

mkdirSync(workDir, { recursive: true })

const engine = new MangaEngine({
  modelRoot,
  ...(Number.isFinite(threads) && threads > 0 ? { intraOpNumThreads: Math.floor(threads) } : {}),
})

const app = await createComputeApp({ apiKey, workDir, engine })

try {
  await app.listen({ port, host })
  const status = engine.modelStatus()
  const readyModels = status.models.filter(model => model.ready).length
  const missing = status.models.flatMap(model => model.missing)
  logInfo('计算端', `已监听 http://${host}:${port} · 协议 v${COMPUTE_PROTOCOL_VERSION}`)
  logInfo('计算端', `设备 ${status.device} · 线程 ${Number.isFinite(threads) && threads > 0 ? Math.floor(threads) : '由 ONNX Runtime 决定'}`)
  logInfo('计算端', `模型 ${readyModels}/${status.models.length} 就绪${missing.length ? ` · 缺少 ${missing.join('、')}` : ''}`)
  logInfo('计算端', `模型目录 ${modelRoot}`)
  logInfo('计算端', `临时目录 ${workDir} · 单图上限 ${Math.round(COMPUTE_MAX_UPLOAD_BYTES / 1048576)} MB · 任务保留 1 小时`)
  if (!status.ready) logWarn('计算端', '模型尚未就位，首次计算时会自动下载；下载进度会输出在下面')
} catch (error) {
  logError('计算端', '启动失败', error)
  process.exit(1)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logInfo('计算端', `收到 ${signal}，正在停止…`)
    void app.close().finally(() => process.exit(0))
  })
}
