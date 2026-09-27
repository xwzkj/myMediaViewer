import { createApp } from './app.js'
import { host, port, sources, allowPublicAccess } from './config.js'
import { scanLibrary, scanStatus } from './scanner.js'
import { db } from './database.js'

const app = await createApp()
await app.listen({ host, port })
console.log(`\n  拾光 · 媒体收藏馆\n  http://localhost:${port}\n  访问范围：${allowPublicAccess ? '允许公网访问' : '仅局域网与保留地址'}\n  在设置中添加媒体目录，开始整理收藏。\n`)
if (sources.length) void scanLibrary().catch(error => app.log.error(error))
// Reconcile periodically; metadata contents are read again only when size/mtime changes.
const timer = setInterval(() => { if (sources.length && !scanStatus.running) void scanLibrary().catch(error => app.log.error(error)) }, 5 * 60_000)
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
