import type { FileRule, SourceRules } from '../shared/types.js'

export const LIMITS = { script: 128 * 1024, file: 2 * 1024 * 1024, files: 64, total: 8 * 1024 * 1024, output: 256 * 1024 }
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export function rulePattern(rule: FileRule): string {
  if (rule.mode === 'regex') return rule.pattern
  let result = '', depth = 0
  const names = new Set<string>()
  for (let i = 0; i < rule.pattern.length; i++) {
    const c = rule.pattern[i]
    if (c === '\\') {
      if (++i === rule.pattern.length) throw new Error('模板末尾不能是转义符')
      result += escapeRegex(rule.pattern[i])
    } else if (c === '[') { depth++; result += '(?:' }
    else if (c === ']') {
      if (!depth--) throw new Error('模板可选段括号不匹配')
      result += ')?'
    } else if (c === '{') {
      const end = rule.pattern.indexOf('}', i)
      const name = rule.pattern.slice(i + 1, end)
      if (end < 0 || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || names.has(name)) throw new Error('模板占位符无效或重复')
      names.add(name)
      result += `(?<${name}>${name === 'page' || name === 'sequence' ? '\\d+' : name === 'ext' ? '[A-Za-z0-9]+' : '.+?'})`
      i = end
    } else result += escapeRegex(c)
  }
  if (depth) throw new Error('模板可选段括号不匹配')
  return result
}
// Only construct/execute RegExp in the interruptible worker.
export function validateRulesShape(value: unknown): asserts value is SourceRules {
  if (!value || typeof value !== 'object') throw new Error('请配置文件规则')
  const r = value as SourceRules
  if (r.version !== 1 || !['source', 'directory'].includes(r.scope) || !['all', 'page'].includes(r.duplicates)) throw new Error('规则版本、分组范围或重复策略无效')
  if (!Array.isArray(r.metadata) || r.metadata.length > 16) throw new Error('元文件规则最多 16 条')
  for (const rule of [r.media, ...r.metadata]) {
    if (!rule || !['template', 'regex'].includes(rule.mode) || typeof rule.caseSensitive !== 'boolean' || typeof rule.pattern !== 'string' || !rule.pattern || rule.pattern.length > 4096) throw new Error('文件规则无效（最多 4096 字符）')
    if (rule.defaultPage !== undefined && (!Number.isSafeInteger(rule.defaultPage) || rule.defaultPage < 0)) throw new Error('默认页码必须是非负安全整数')
    const pattern = rulePattern(rule)
    if (!pattern.includes('(?<id>')) throw new Error('每条规则必须包含 id 命名捕获组或 {id}')
  }
  if (typeof r.script !== 'string' || Buffer.byteLength(r.script) > LIMITS.script || !r.script.trim()) throw new Error('JS 脚本为空或超过 128 KiB')
  if (!r.typeOverrides || typeof r.typeOverrides !== 'object' || Array.isArray(r.typeOverrides) || Object.keys(r.typeOverrides).length > 32) throw new Error('媒体类型覆盖无效')
  for (const [ext, kind] of Object.entries(r.typeOverrides)) if (!/^[a-z0-9]{1,12}$/.test(ext) || !['image', 'video', 'animation'].includes(kind)) throw new Error('媒体类型覆盖无效')
  if (r.preset !== undefined && !['pixiv', 'telegram'].includes(r.preset)) throw new Error('预设标识无效')
}
