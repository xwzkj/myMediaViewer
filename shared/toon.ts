/**
 * TOON 风格的紧凑序列化：给模型看的结构化数据不再用 JSON，省 token 也更好读。
 *
 * - 对象：`key: 值`，嵌套对象换行后缩进两个空格
 * - 全是标量的数组：`key[3]: a,b,c`
 * - 全是扁平对象的数组：`key[2]{列1,列2}:` 后跟两行数据（等价于表格）
 * - 其他数组：`key[2]:` 后跟 `- 值` 列表
 * 字符串只在含逗号、冒号、引号、换行或首尾空格时用双引号包起来，其余原样输出。
 */

const needsQuotes = /[",:[\]{}]|\n|\r|\t|^\s|\s$/
const keyNeedsQuotes = /[",:\s[\]{}]/

function scalar(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean') return String(value)
  const text = String(value)
  return text === '' || needsQuotes.test(text) ? JSON.stringify(text) : text
}

const isScalar = (value: unknown): boolean => value === null || value === undefined || typeof value !== 'object'

function isFlatObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.values(value as Record<string, unknown>).every(isScalar)
}

function key(name: string): string {
  return keyNeedsQuotes.test(name) ? JSON.stringify(name) : name
}

function rows(items: Record<string, unknown>[], pad: string, label: string): string[] {
  const columns: string[] = []
  for (const item of items) for (const column of Object.keys(item)) if (!columns.includes(column)) columns.push(column)
  return [
    `${label}[${items.length}]{${columns.map(key).join(',')}}:`,
    ...items.map(item => `  ${pad}${columns.map(column => scalar(item[column])).join(',')}`),
  ]
}

function list(items: unknown[], depth: number, pad: string, label: string): string[] {
  if (!items.length) return [`${label}[0]:`]
  if (items.every(isScalar)) return [`${label}[${items.length}]: ${items.map(scalar).join(',')}`]
  if (items.every(isFlatObject)) return rows(items, pad, label)
  const lines = [`${label}[${items.length}]:`]
  for (const item of items) {
    if (isScalar(item)) lines.push(`${pad}  - ${scalar(item)}`)
    else { lines.push(`${pad}  -`); lines.push(...block(item, depth + 2)) }
  }
  return lines
}

function block(value: unknown, depth: number): string[] {
  const pad = '  '.repeat(depth)
  if (isScalar(value)) return [pad + scalar(value)]
  if (Array.isArray(value)) return list(value, depth, pad, pad)
  const lines: string[] = []
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) continue
    if (isScalar(item)) lines.push(`${pad}${key(name)}: ${scalar(item)}`)
    else if (Array.isArray(item)) lines.push(...list(item, depth, pad, `${pad}${key(name)}`))
    else { lines.push(`${pad}${key(name)}:`); lines.push(...block(item, depth + 1)) }
  }
  return lines.length ? lines : [`${pad}{}`]
}

/** 把任意值编码成 TOON 文本；顶层是数组时同样支持表格形式。 */
export function toon(value: unknown): string {
  return block(value, 0).join('\n')
}
