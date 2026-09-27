import Fuse from 'fuse.js'
import { Converter } from 'opencc-js'
import { pinyin } from 'pinyin-pro'
import { allWorks, type StoredWork } from './database.js'
import type { TagSuggestionsResponse } from '../shared/types.js'
import { searchTokens } from '../shared/search-query.js'

const simplify = Converter({ from: 't', to: 'cn' })
export function normalize(text: string): string { return simplify(text.normalize('NFKC')).toLowerCase().replace(/\s+/g, ' ').trim() }
interface Document { work: StoredWork; title: string; labels: string; body: string; phonetic: string; tags: Set<string> }
interface IndexedTag { name: string; normalized: string; count: number; phonetic: string; initials: string }
let documents: Document[] = []
let tags: IndexedTag[] = []
let fuzzy: Fuse<Document>
export function refreshSearch(): void {
  documents = allWorks().map(work => {
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
export function searchWorks(query: string, allowFuzzy: boolean): Array<{ work: StoredWork; score: number; approximate: boolean }> {
  const tokens = searchTokens(query).map(token => ({ ...token, value: normalize(token.value) })).filter(token => token.value).slice(0, 12)
  const terms = tokens.map(token => token.value)
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
