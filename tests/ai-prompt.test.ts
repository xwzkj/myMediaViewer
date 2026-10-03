import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// config.ts 在导入时就会解析数据目录，必须在动态 import 之前指定。
process.env.MEDIA_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'media-ai-'))

const { saveAiSettings, getAiSettings, translateFields, translateMangaTexts } = await import('../server/ai.js')
const { DEFAULT_APPEND_PROMPT, DEFAULT_MANGA_PROMPT, DEFAULT_TRANSLATE_PROMPT, fillPrompt } = await import('../shared/prompts.js')

type ChatBody = { messages: Array<{ role: string; content: string }> }

const calls: ChatBody[] = []

/** 用一个假的 fetch 顶掉真实请求，顺带把发出去的请求体抓下来。 */
function stubReply(content: unknown) {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)) as ChatBody)
    return new Response(JSON.stringify({
      model: 'stub-model',
      choices: [{ message: { content: JSON.stringify(content) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

function systemPromptOfLastRequest(): string {
  const body = calls[calls.length - 1]
  assert.ok(body, '这次请求没有被捕捉到')
  const message = body.messages.find(item => item.role === 'system')
  assert.ok(message, '请求里没有 system 消息')
  return message.content
}

function useSettings(patch: Record<string, unknown>) {
  saveAiSettings({ baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'm', targetLanguage: '简体中文', params: {}, timeoutMs: 120000, ...patch })
}

test('缺失配置时自动补上默认追加提示词', () => {
  useSettings({})
  assert.ok(DEFAULT_APPEND_PROMPT.length > 0)
  assert.equal(getAiSettings().appendPrompt, DEFAULT_APPEND_PROMPT)
})

test('追加内容拼在内置提示词之后，中间空两行（标题/标签/描述）', async () => {
  useSettings({})
  stubReply({ title: '译文标题' })
  await translateFields({ fields: { title: '原标题' }, force: true })
  assert.equal(
    systemPromptOfLastRequest(),
    `${fillPrompt(DEFAULT_TRANSLATE_PROMPT, '简体中文')}\n\n${DEFAULT_APPEND_PROMPT}`,
  )
})

test('追加内容同样拼在漫画内置提示词之后', async () => {
  useSettings({})
  stubReply({ translations: ['气泡译文'] })
  await translateMangaTexts({ texts: ['あいう'] })
  assert.equal(
    systemPromptOfLastRequest(),
    `${fillPrompt(DEFAULT_MANGA_PROMPT, '简体中文')}\n\n${DEFAULT_APPEND_PROMPT}`,
  )
})

test('追加提示词留空时只用内置提示词', async () => {
  useSettings({ appendPrompt: '' })
  stubReply({ title: '译文标题' })
  await translateFields({ fields: { title: '另一条原文' }, force: true })
  assert.equal(systemPromptOfLastRequest(), fillPrompt(DEFAULT_TRANSLATE_PROMPT, '简体中文'))
})

test('自定义追加内容原样拼接，不会覆盖内置提示词', async () => {
  useSettings({ appendPrompt: '逐条翻译，不要合并。' })
  stubReply({ title: '译文标题' })
  await translateFields({ fields: { title: '第三条原文' }, force: true })
  const prompt = systemPromptOfLastRequest()
  assert.ok(prompt.startsWith(fillPrompt(DEFAULT_TRANSLATE_PROMPT, '简体中文')))
  assert.ok(prompt.endsWith('\n\n逐条翻译，不要合并。'))
})

test('旧配置里的 systemPrompt 不再生效，回落到默认追加内容', () => {
  useSettings({ systemPrompt: '旧的替换式提示词' })
  assert.equal(getAiSettings().appendPrompt, DEFAULT_APPEND_PROMPT)
})

test('保存后再读回来，追加提示词原样保留', () => {
  useSettings({ appendPrompt: '先补全术语表再翻译。' })
  assert.equal(getAiSettings().appendPrompt, '先补全术语表再翻译。')
})
