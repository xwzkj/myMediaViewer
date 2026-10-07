import type { FileRule, SourceRules } from '../shared/types.js'

export const LIMITS = { script: 128 * 1024, file: 2 * 1024 * 1024, files: 64, total: 8 * 1024 * 1024, output: 256 * 1024 }
export { rulePattern } from '../shared/file-rules.js'
import { ruleIssues, issueLocation, scriptIssues } from '../shared/source-diagnostics.js'
// Only construct/execute RegExp in the interruptible worker.
export function validateRulesShape(value: unknown): asserts value is SourceRules {
  if (!value || typeof value !== 'object') throw new Error('请配置文件规则')
  const r = value as SourceRules
  if (r.version !== 1 || !['source', 'directory'].includes(r.scope) || !['all', 'page'].includes(r.duplicates)) throw new Error('规则版本、分组范围或重复策略无效')
  if (!Array.isArray(r.metadata) || r.metadata.length > 16) throw new Error('元文件规则最多 16 条')
  for (const rule of [r.media, ...r.metadata]) {
    if (!rule || !['template', 'regex'].includes(rule.mode) || typeof rule.caseSensitive !== 'boolean' || typeof rule.pattern !== 'string' || !rule.pattern || rule.pattern.length > 4096) throw new Error('文件规则无效（最多 4096 字符）')
    if (rule.defaultPage !== undefined && (!Number.isSafeInteger(rule.defaultPage) || rule.defaultPage < 0)) throw new Error('默认页码必须是非负安全整数')
    if (rule.target !== undefined && !['filename', 'relativePath', 'directory', 'directoryName'].includes(rule.target)) throw new Error('匹配对象无效')
    const problems = ruleIssues(rule)
    if (problems.length) throw new Error(`${rule === r.media ? '媒体规则' : `元文件规则 ${r.metadata.indexOf(rule) + 1}`}：${issueLocation(rule.pattern, problems[0])}`)
  }
  if (typeof r.script !== 'string' || Buffer.byteLength(r.script) > LIMITS.script || !r.script.trim()) throw new Error('JS 脚本为空或超过 128 KiB')
  const problems = scriptIssues(r.script)
  if (problems.length) throw new Error(`JS 脚本：${issueLocation(r.script, problems[0])}`)
  if (!r.typeOverrides || typeof r.typeOverrides !== 'object' || Array.isArray(r.typeOverrides) || Object.keys(r.typeOverrides).length > 32) throw new Error('媒体类型覆盖无效')
  for (const [ext, kind] of Object.entries(r.typeOverrides)) if (!/^[a-z0-9]{1,12}$/.test(ext) || !['image', 'video', 'animation'].includes(kind)) throw new Error('媒体类型覆盖无效')
  if (r.preset !== undefined && !['pixiv', 'telegram'].includes(r.preset)) throw new Error('预设标识无效')
}
