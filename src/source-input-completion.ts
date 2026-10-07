import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import type { FileRule } from '../shared/types'

const fields = (items: Array<[string,string]>): Completion[] => items.map(([label,detail]) => ({label,detail,type:'property'}))
const rootFields = fields([
  ['id','string · 本组 ID'], ['directory','string · 分组相对目录；来源级合并时为空'],
  ['media','MediaFile[] · 媒体描述，不含文件内容'], ['files','MetadataFile[] · 匹配元文件的只读快照'],
])
const fileFields = fields([
  ['filename','string · 文件名'], ['relativePath','string · 来源内相对路径，/ 分隔'],
  ['directory','string · 相对目录路径'], ['directoryName','string · 直属目录名'],
  ['extension','string · 小写扩展名，不含点'], ['size','number · 字节数'],
  ['modified','number · 修改时间，毫秒时间戳'], ['captures','Record<string, string> · 规则捕获字段'],
  ['page','number | undefined · 页码'], ['sequence','number | undefined · 收藏序号'],
])
export function captureNames(rules: FileRule[]): string[] {
  const names = new Set<string>()
  for (const rule of rules) {
    const re = rule.mode === 'template' ? /(?<!\\)\{([A-Za-z][A-Za-z0-9_]*)\}/g : /\(\?<([A-Za-z][A-Za-z0-9_]*)>/g
    for (const match of rule.pattern.matchAll(re)) names.add(match[1])
  }
  return [...names]
}
/** Contextual suggestions for direct input member chains, never evaluates user JS. */
export function inputCompletions(context: CompletionContext, mediaCaptures: string[] = [], metadataCaptures: string[] = []): CompletionResult | null {
  const node = syntaxTree(context.state).resolveInner(context.pos, -1)
  if (/Comment|String|TemplateString/.test(node.name)) return null
  const line = context.state.doc.lineAt(context.pos)
  const before = line.text.slice(0, context.pos - line.from)
  const normal = before.replace(/input\?\./g, 'input.')
  const match = /\binput\.(?:(media|files)(?:\s*\[\s*\d+\s*\]|\.at\(\s*-?\d+\s*\))\??\.(?:(captures)\??\.)?)?([A-Za-z_$][\w$]*)?$/.exec(normal)
  if (match) {
    const collection = match[1], captures = match[2], word = match[3] || ''
    const options = captures ? fields((collection === 'media' ? mediaCaptures : metadataCaptures).map(name => [name,'string · 命名规则捕获']))
      : collection ? [...fileFields, ...(collection === 'files' ? fields([['text','string · 元文件解码文本（UTF-8/UTF-16/GB18030）']]) : [])] : rootFields
    return {from:context.pos-word.length,options,validFor:/^[\w$]*$/}
  }
  const word = context.matchBefore(/\b[a-zA-Z_$][\w$]*/)
  if (word && 'input'.startsWith(word.text)) return {from:word.from,options:[{label:'input',type:'variable',detail:'只读 ScriptInput · 当前媒体分组'}],validFor:/^[\w$]*$/}
  return null
}
