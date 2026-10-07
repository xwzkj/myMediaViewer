import { parse } from 'acorn'
import { RegExpParser, visitRegExpAST } from '@eslint-community/regexpp'
import type { FileRule } from './types.js'
import { rulePattern, RuleSyntaxError } from './file-rules.js'
export interface EditorIssue { from: number; to: number; message: string }
function issue(text: string, from: number, message: string): EditorIssue {
  const pos = Math.min(Math.max(from, 0), text.length)
  return { from: pos, to: Math.min(text.length, pos + 1), message }
}
export function ruleIssues(rule: FileRule): EditorIssue[] {
  try {
    if (rule.pattern.length > 4096) return [issue(rule.pattern, 4096, '规则最多 4096 字符')]
    const pattern = rulePattern(rule)
    // Parse syntax only. Never new RegExp / test / exec on user input in the UI.
    const ast = new RegExpParser({ ecmaVersion: 2024 }).parsePattern(pattern)
    let hasId = false
    visitRegExpAST(ast, { onCapturingGroupEnter(node) { if (node.name === 'id') hasId = true } })
    if (!hasId) return [issue(rule.pattern, 0, '缺少命名捕获组 (?<id>...)，用于分组')]
    return []
  } catch (error) {
    const e = error as { message: string; index?: number }
    return [issue(rule.pattern, error instanceof RuleSyntaxError ? error.offset : rule.mode === 'regex' ? (e.index ?? 0) : 0, e.message)]
  }
}
export function scriptIssues(text: string): EditorIssue[] {
  if (text.length > 128 * 1024) return [issue(text, 0, '脚本超过 128 KiB')]
  try {
    const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
    let extract = false
    const problems: EditorIssue[] = []
    // Bounded syntax traversal, not code execution. A stack avoids deep recursive AST walking.
    const stack: any[] = [ast]
    while (stack.length) {
      const node = stack.pop()
      if (node.type === 'ImportDeclaration' || node.type === 'ImportExpression' || ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source)) problems.push(issue(text, node.start, '沙箱禁止导入外部模块'))
      if (node.type === 'ExportNamedDeclaration') {
        if (node.declaration?.type === 'FunctionDeclaration' && node.declaration.id?.name === 'extract') extract = true
        if (node.declaration?.type === 'VariableDeclaration' && node.declaration.declarations.some((d: any) => d.id?.name === 'extract')) extract = true
        if (node.specifiers?.some((s: any) => s.exported?.name === 'extract')) extract = true
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) { for (const child of value) if (child?.type) stack.push(child) }
        else if (value && typeof value === 'object' && 'type' in value) stack.push(value)
      }
    }
    if (!extract) problems.push(issue(text, 0, '缺少导出的 extract(input) 函数，例如 export async function extract(input) { return {}; }'))
    return problems
  } catch (error) {
    const e = error as { pos?: number; message: string }
    return [issue(text, e.pos ?? 0, e.message)]
  }
}
export function issueLocation(text: string, issue: EditorIssue): string {
  const prefix = text.slice(0, issue.from).split('\n')
  return `第 ${prefix.length} 行，第 ${prefix[prefix.length - 1].length + 1} 列：${issue.message}`
}
