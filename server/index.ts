import { createApp } from './app.js'
import { host, port, sources, allowPublicAccess } from './config.js'
import { scanLibrary, scanStatus } from './scanner.js'
import { db } from './database.js'
import { logError, logInfo } from './log.js'

const app = await createApp()
await app.listen({ host, port })
const onScanFailed = (error: unknown) => logError('扫描', `扫描失败：${(error as Error).message}`, error)
logInfo('服务', `拾光 · 媒体收藏馆已启动 · http://localhost:${port}`)
logInfo('服务', `访问范围：${allowPublicAccess ? '允许公网访问' : '仅局域网与保留地址'} · 在设置中添加媒体目录开始整理收藏`)
// 启动时先整理一次；此后每 5 分钟对账一次，只有发现变化或出错才会留下日志。
if (sources.length) void scanLibrary({ reason: 'manual' }).catch(onScanFailed)
const timer = setInterval(() => { if (sources.length && !scanStatus.running) void scanLibrary().catch(onScanFailed) }, 5 * 60_000)
timer.unref()
let closing = false
async function close() {
  if (closing) return
  closing = true
  clearInterval(timer)
  await app.close()
  db.close()
  process.exit(0)
}
process.on('SIGINT', close)
process.on('SIGTERM', close)
