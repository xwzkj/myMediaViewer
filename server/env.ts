import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * 在读取任何配置之前加载 .env。
 *
 * 使用 Node 内置的 .env 解析（无需依赖）；已存在的真实环境变量优先，与
 * `node --env-file` 的行为一致，因此临时覆盖或 CI 注入仍然有效。
 *
 * 必须在入口文件的最前面导入：配置模块在模块加载时就会读取 process.env。
 * 其他位置（如测试）按需自行设置环境变量，不强制走这里。
 *
 * 文件不存在时静默跳过；写错只提示一句，不影响用真实环境变量和默认值启动。
 */
const file = path.resolve(process.env.ENV_FILE || '.env')
if (existsSync(file)) {
  try {
    process.loadEnvFile(file)
  } catch (error) {
    console.warn(`[env] 读取 ${file} 失败，已忽略：${(error as Error).message}`)
  }
}
