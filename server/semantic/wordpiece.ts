/**
 * BERT WordPiece 分词器。
 *
 * Chinese-CLIP 的文本塔用的是中文 BERT 词表（21128 词），不是 CLIP 的 byte-level BPE。
 * 这里实现推理需要的部分：清理字符、按 CJK/字母数字/标点切分、最长匹配 + `##` 续接、
 * 加 [CLS]/[SEP] 并截断。与 HuggingFace `BertTokenizer` 的默认行为保持一致：
 * 小写、去重音、中文逐字成词。
 *
 * 只依赖 tokenizer.json 里的 vocab，不引入任何分词库。
 */

export interface WordPieceConfig {
  vocab: Record<string, number>
  cls: number
  sep: number
  unk: number
  /** 是否小写；Chinese-CLIP 的中文词表为 true。 */
  lowercase?: boolean
  /** 文本塔的最大长度（含 [CLS]/[SEP]）。 */
  maxLength?: number
  /** 续接片段前缀，BERT 固定为 `##`。 */
  continuation?: string
}

export interface TokenizedText {
  ids: number[]
  mask: number[]
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/
const WORD = /[\p{L}\p{N}]/u

/** 去重音：NFD 之后去掉组合附加符号。 */
function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/** 按 BERT 的 pre-tokenizer 规则切成「词」：CJK 逐字、字母数字连写、标点单独。 */
function preTokenize(text: string): string[] {
  const tokens: string[] = []
  let current = ''
  const flush = () => { if (current) { tokens.push(current); current = '' } }
  for (const char of text) {
    if (CJK.test(char)) { flush(); tokens.push(char); continue }
    if (WORD.test(char)) { current += char; continue }
    flush()
    if (!/\s/.test(char)) tokens.push(char)
  }
  flush()
  return tokens
}

export class WordPieceTokenizer {
  private readonly continuation: string
  private readonly maxLength: number
  constructor(private readonly config: WordPieceConfig) {
    this.continuation = config.continuation ?? '##'
    this.maxLength = Math.max(2, config.maxLength ?? 77)
  }

  private encodeWord(word: string): number[] {
    const ids: number[] = []
    let start = 0
    while (start < word.length) {
      let end = word.length
      let piece: string | undefined
      while (start < end) {
        const candidate = (start === 0 ? '' : this.continuation) + word.slice(start, end)
        if (this.config.vocab[candidate] !== undefined) { piece = candidate; break }
        end--
      }
      if (!piece) return [this.config.unk]
      ids.push(this.config.vocab[piece]!)
      start = end
    }
    return ids
  }

  encode(text: string): TokenizedText {
    const normalized = this.config.lowercase === false ? text : text.toLowerCase()
    const ids = [this.config.cls]
    for (const token of preTokenize(stripAccents(normalized))) {
      if (ids.length >= this.maxLength - 1) break
      ids.push(...this.encodeWord(token))
    }
    ids.length = Math.min(ids.length, this.maxLength - 1)
    ids.push(this.config.sep)
    return { ids, mask: ids.map(() => 1) }
  }
}

/** 从 HuggingFace `tokenizer.json` 构造；只支持 WordPiece/BertNormalizer。 */
export function wordPieceFromTokenizerJson(json: unknown): WordPieceTokenizer {
  const model = (json as { model?: { type?: string; vocab?: Record<string, number>; unk_token?: string } }).model
  if (!model || model.type !== 'WordPiece' || !model.vocab) {
    throw new Error('分词器不是 WordPiece 模型；Chinese-CLIP 需要 BERT 词表')
  }
  const vocab = model.vocab
  const unk = vocab[model.unk_token || '[UNK]'] ?? vocab['[UNK]']
  const cls = vocab['[CLS]']
  const sep = vocab['[SEP]']
  if (unk === undefined || cls === undefined || sep === undefined) {
    throw new Error('分词器缺少 [UNK]/[CLS]/[SEP] 词条')
  }
  const normalizer = (json as { normalizer?: { lowercase?: boolean; type?: string } }).normalizer
  if (normalizer?.type && normalizer.type !== 'BertNormalizer') {
    throw new Error(`暂不支持的分词归一化器：${normalizer.type}`)
  }
  return new WordPieceTokenizer({ vocab, cls, sep, unk, lowercase: normalizer?.lowercase !== false })
}
