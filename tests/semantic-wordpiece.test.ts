import test from 'node:test'
import assert from 'node:assert/strict'
import { WordPieceTokenizer, wordPieceFromTokenizerJson } from '../server/semantic/wordpiece.js'

/**
 * Chinese-CLIP 的文本塔用中文 BERT 词表（WordPiece）。
 * 这里用一个缩小版词表验证关键行为：CJK 逐字、英文小写、`##` 续接、未知词、截断。
 */
const vocab: Record<string, number> = {
  '[PAD]': 0, '[UNK]': 100, '[CLS]': 101, '[SEP]': 102,
  '有': 1100, '日': 1101, '文': 1102, '漫': 1103, '画': 1104, '页': 1105, '面': 1106,
  'a': 2000, 'manga': 2001, 'page': 2002, 'with': 2003, 'un': 2004, '##usual': 2005, ',': 3000,
}
const tokenizer = new WordPieceTokenizer({ vocab, cls: 101, sep: 102, unk: 100 })
const ids = (text: string) => tokenizer.encode(text).ids

test('中文按字切分，并加上 [CLS]/[SEP]', () => {
  assert.deepEqual(ids('有日文漫画页面'), [101, 1100, 1101, 1102, 1103, 1104, 1105, 1106, 102])
})

test('英文小写，未收录的长词按 ## 续接', () => {
  assert.deepEqual(ids('A MANGA page'), [101, 2000, 2001, 2002, 102])
  assert.deepEqual(ids('unusual'), [101, 2004, 2005, 102])
})

test('未知词退化为 [UNK]，不会凭空造 id', () => {
  assert.deepEqual(ids('zzz'), [101, 100, 102])
  assert.deepEqual(ids('漫画 zzz'), [101, 1103, 1104, 100, 102])
})

test('中英混排与标点按词边界切分', () => {
  assert.deepEqual(ids('漫画 page, with 有'), [101, 1103, 1104, 2002, 3000, 2003, 1100, 102])
})

test('超长输入截断到上限，且始终以 [SEP] 结束', () => {
  const long = new WordPieceTokenizer({ vocab, cls: 101, sep: 102, unk: 100, maxLength: 6 })
  const encoded = long.encode('有日文漫画页面')
  assert.equal(encoded.ids.length, 6)
  assert.equal(encoded.ids[0], 101)
  assert.equal(encoded.ids.at(-1), 102)
  assert.deepEqual(encoded.mask, encoded.ids.map(() => 1))
})

test('只接受 WordPiece 词表，拒绝其它分词模型', () => {
  assert.throws(() => wordPieceFromTokenizerJson({ model: { type: 'BPE', vocab } }), /WordPiece/)
  assert.throws(() => wordPieceFromTokenizerJson({ model: { type: 'WordPiece', vocab: { a: 1 } } }), /UNK/)
  const parsed = wordPieceFromTokenizerJson({ model: { type: 'WordPiece', vocab }, normalizer: { type: 'BertNormalizer', lowercase: true } })
  assert.deepEqual(parsed.encode('A').ids, [101, 2000, 102])
})
