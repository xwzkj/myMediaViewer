import Fuse from 'fuse.js'
import { Converter } from 'opencc-js'
import { pinyin } from 'pinyin-pro'
import { allWorks } from './database.js'
import { libraryRevision } from './library-revision.js'
import type { TagSuggestionsResponse, Work } from '../shared/types.js'
import { searchTokens } from '../shared/search-query.js'

const simplify = Converter({ from: 't', to: 'cn' })
export function normalize(text: string): string { return simplify(text.normalize('NFKC')).toLowerCase().replace(/\s+/g, ' ').trim() }
interface Document { work: Work; title: string; labels: string; body: string; phonetic: string; tags: Set<string> }
interface IndexedTag { name: string; normalized: string; count: number; phonetic: string; initials: string }
let documents: Document[] = []
let tags: IndexedTag[] = []
let fuzzy: Fuse<Document>
/**
 * 上次建索引时使用的数据签名。`undefined` 表示这次索引由不提供签名的调用建立：
 * 数据版本未知，下一次带签名的请求必须重建才能确认索引没有过期。
 */
let indexedSignature: string | undefined
function fallbackLocalWorks(): Work[] {
  return allWorks().map(work => ({
    ...work,
    favorite: false,
    cover: '',
    origin: 'local',
    hasLocal: true,
    pixivId: work.sourceKind === 'pixiv' && /^\d+$/.test(work.externalId) ? work.externalId : undefined,
  }))
}
/** 用给定作品重建全部派生数据（简繁转换、拼音、标签聚合、Fuse），并记住这批数据的签名。 */
function buildIndex(works: Work[], signature: string | undefined): void {
  documents = works.map(work => {
    const labels = normalize(`${work.author} ${work.tags.join(' ')}`)
    const title = normalize(work.title)
    const names = `${title} ${labels}`
    return {
      work, title, labels, body: normalize(`${work.description} ${work.externalId}`),
      tags: new Set(work.tags.map(tag => normalize(tag)).filter(Boolean)),
      phonetic: `${pinyin(names, { toneType: 'none', separator: '' })} ${pinyin(names, { pattern: 'first', toneType: 'none', separator: '' })}`.toLowerCase(),
    }
  })
  const tagCounts = new Map<string, IndexedTag>()
  for (const { work } of documents) {
    const counted = new Set<string>()
    for (const raw of work.tags) {
      const name = raw.trim()
      const normalized = normalize(name)
      if (!normalized || counted.has(normalized)) continue
      counted.add(normalized)
      const existing = tagCounts.get(normalized)
      if (existing) existing.count++
      else tagCounts.set(normalized, {
        name, normalized, count: 1,
        phonetic: pinyin(normalized, { toneType: 'none', separator: '' }).toLowerCase(),
        initials: pinyin(normalized, { pattern: 'first', toneType: 'none', separator: '' }).toLowerCase(),
      })
    }
  }
  tags = [...tagCounts.values()]
  fuzzy = new Fuse(documents, {
    includeScore: true, ignoreLocation: true, threshold: 0.3, minMatchCharLength: 2,
    keys: [{ name: 'title', weight: 0.5 }, { name: 'labels', weight: 0.35 }, { name: 'body', weight: 0.15 }],
  })
  indexedSignature = signature
}
export function refreshSearch(works?: Work[], signature?: string): void {
  // 无参调用（启动、扫描结束的 onScan）建的是本地库索引，签名只跟数据版本有关；
  // 带 works 且给了 signature 的调用走同一套判断，数据没变就不重建。
  const next = signature ?? (works ? undefined : `local:${libraryRevision()}`)
  if (works && next !== undefined && next === indexedSignature && documents.length) return
  buildIndex(works || fallbackLocalWorks(), next)
}
export function suggestTags(query: string): TagSuggestionsResponse {
  const term = normalize(query).replace(/^[#＃]/, '')
  const matches = tags.flatMap(tag => {
    const score = !term ? 0 : tag.normalized === term ? 4 : tag.normalized.startsWith(term) ? 3
      : tag.normalized.includes(term) ? 2
        : /^[a-z]+$/.test(term) && (tag.phonetic.includes(term) || tag.initials.includes(term)) ? 1 : -1
    return score < 0 ? [] : [{ tag, score }]
  }).sort((a, b) => b.score - a.score || b.tag.count - a.tag.count || a.tag.name.localeCompare(b.tag.name, 'zh-CN'))
  return { total: matches.length, items: matches.slice(0, 12).map(({ tag }) => ({ name: tag.name, count: tag.count })) }
}
/**
 * `signature` 是调用方按自己的数据版本算出的签名（例如 `${libraryRevision()}:${catalog.length}`）。
 * 同时传入 works 和 signature 时，签名与上次建索引相同且索引非空就跳过重建；否则用这批 works 重建并记住签名。
 */
export function searchWorks(query: string, allowFuzzy: boolean, works?: Work[], signature?: string): Array<{ work: Work; score: number; approximate: boolean }> {
  if (works) refreshSearch(works, signature)
  const tokens = searchTokens(query).map(token => ({ ...token, value: normalize(token.value) })).filter(token => token.value).slice(0, 12)
  const terms = tokens.map(token => token.value)
  // 空查询直接返回全部文档（分数 0、不算近似匹配），不需要为它准备拼音或 Fuse 数据。
  if (!terms.length) return documents.map(doc => ({ work: doc.work, score: 0, approximate: false }))
  const fuzzyTerms = terms.map((term, i) => {
    if (!allowFuzzy || tokens[i].tag || [...term].length < 2) return new Map<string, number>()
    // Fuse patterns over 32 chars are unnecessary for typo suggestions; exact matching still uses the entire term.
    return new Map(fuzzy.search(term.slice(0, 32)).map(result => [result.item.work.id, result.score ?? 1]))
  })
  return documents.flatMap(doc => {
    let score = 0
    let approximate = false
    for (let i = 0; i < terms.length; i++) {
      const term = terms[i]
      if (tokens[i].tag) {
        if (!doc.tags.has(term)) return []
        score += 100
      }
      else if (doc.title.includes(term)) score += doc.title === term ? 100 : 60
      else if (doc.labels.includes(term)) score += 40
      else if (doc.body.includes(term)) score += 20
      else if (/^[a-z]{2,}$/.test(term) && doc.phonetic.includes(term)) score += 10
      else if (fuzzyTerms[i].has(doc.work.id)) { score += 1 - fuzzyTerms[i].get(doc.work.id)!; approximate = true }
      else return []
    }
    return [{ work: doc.work, score, approximate }]
  }).sort((a, b) => Number(a.approximate) - Number(b.approximate) || b.score - a.score)
}
