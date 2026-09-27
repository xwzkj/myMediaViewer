export interface SearchToken { value: string; tag: boolean; start: number; end: number }

export function searchTokens(query: string): SearchToken[] {
  return [...query.matchAll(/[#＃]"(?:\\.|[^"\\])*"?|[^\s]+/gu)].map(match => {
    const raw = match[0]
    const tag = /^[#＃]/.test(raw)
    let value = tag ? raw.slice(1) : raw
    if (tag && value.startsWith('"')) {
      value = value.slice(1).replace(/"$/, '').replace(/\\(["\\])/g, '$1')
    }
    return { value, tag, start: match.index!, end: match.index! + raw.length }
  })
}

export function tagQuery(tag: string): string {
  return /[\s"\\]/u.test(tag) ? `#${JSON.stringify(tag)}` : `#${tag}`
}

/** 光标所在的关键词：优先整体包含光标的词，其次是紧跟在光标后的词。 */
export function activeSearchToken(query: string, caret: number): SearchToken {
  const tokens = searchTokens(query)
  return tokens.find(token => caret > token.start && caret < token.end)
    || tokens.find(token => caret === token.start)
    || tokens.find(token => caret === token.end)
    || { value: '', tag: false, start: caret, end: caret }
}

/** 把光标处的关键词替换成标签，并在标签后留出空格方便继续输入。 */
export function replaceWithTag(query: string, caret: number, tag: string): { query: string; caret: number } {
  const token = activeSearchToken(query, caret)
  const prefix = query.slice(0, token.start)
  const suffix = query.slice(token.end).trimStart()
  const replacement = tagQuery(tag)
  return { query: `${prefix}${replacement} ${suffix}`, caret: prefix.length + replacement.length + 1 }
}