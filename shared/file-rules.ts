import type { FileRule } from './types.js'

export class RuleSyntaxError extends Error {
  constructor(message: string, public offset: number) { super(message); this.name = 'RuleSyntaxError' }
}
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Pure compilation only: never executes user regex, safe for editor diagnostics. */
export function rulePattern(rule: FileRule): string {
  if (rule.mode === 'regex') return rule.pattern
  let result = ''
  const brackets: number[] = [], names = new Set<string>()
  for (let i = 0; i < rule.pattern.length; i++) {
    const c = rule.pattern[i]
    if (c === '\\') {
      if (++i === rule.pattern.length) throw new RuleSyntaxError('模板末尾缺少被转义的字符', i - 1)
      result += escapeRegex(rule.pattern[i])
    } else if (c === '[') { brackets.push(i); result += '(?:' }
    else if (c === ']') {
      if (!brackets.length) throw new RuleSyntaxError('多余的 ]，可选段应写成 […]', i)
      brackets.pop(); result += ')?'
    } else if (c === '{') {
      const end = rule.pattern.indexOf('}', i), name = rule.pattern.slice(i + 1, end)
      if (end < 0) throw new RuleSyntaxError('占位符缺少右花括号 }', i)
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new RuleSyntaxError('占位符名称以英文字母开头，仅含字母、数字、下划线', i)
      if (names.has(name)) throw new RuleSyntaxError(`占位符 ${name} 重复，请使用不同名称`, i)
      names.add(name)
      const text = rule.target && rule.target !== 'filename' ? '[^/]+?' : '.+?'
      result += `(?<${name}>${name === 'page' || name === 'sequence' ? '\\d+' : name === 'ext' ? '[A-Za-z0-9]+' : text})`
      i = end
    } else if (c === '}') throw new RuleSyntaxError('多余的 }，字面花括号请使用反斜杠转义', i)
    else result += escapeRegex(c)
  }
  if (brackets.length) throw new RuleSyntaxError('可选段括号不匹配，缺少 ]', brackets[0])
  if (!names.has('id')) throw new RuleSyntaxError('缺少 {id}：用它指定哪些文件属于同一组', 0)
  return result
}
export function ruleSubject(rule: FileRule, relativePath: string): string {
  const slash = relativePath.lastIndexOf('/')
  const directory = slash < 0 ? '' : relativePath.slice(0, slash)
  switch (rule.target ?? 'filename') {
    case 'relativePath': return relativePath
    case 'directory': return directory
    case 'directoryName': return directory.slice(directory.lastIndexOf('/') + 1)
    default: return relativePath.slice(slash + 1)
  }
}
