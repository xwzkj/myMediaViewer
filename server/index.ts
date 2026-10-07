import { createApp } from './app.js'
import { host, port, sources, allowPublicAccess } from './config.js'
import { scanLibrary } from './scanner.js'
import { db } from './database.js'
import { logError, logInfo } from './log.js'

const app = await createApp()
await app.listen({ host, port })
const onScanFailed = (error: unknown) => logError('扫描', `扫描失败：${(error as Error).message}`, error)
logInfo('服务', `拾光 · 媒体收藏馆已启动 · http://localhost:${port}`)
logInfo('服务', `访问范围：${allowPublicAccess ? '允许公网访问' : '仅局域网与保留地址'} · 在设置中添加媒体目录开始整理收藏`)
// 每次启动整理一次。运行期间仅由手动刷新或来源配置变更触发，不定时扫描。
if (sources.length) void scanLibrary({ reason: 'startup' }).catch(onScanFailed)
let closing = false
async function close() {
  if (closing) return
  closing = true
  await app.close()
  db.close()
  process.exit(0)
}
process.on('SIGINT', close)
process.on('SIGTERM', close)
