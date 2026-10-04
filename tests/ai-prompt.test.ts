import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// config.ts 在导入时就会解析数据目录，必须在动态 import 之前指定。
process.env.MEDIA_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'media-ai-'))

const { saveAiSettings, getAiSettings, translateFields, translateMangaTexts } = await import('../server/ai.js')
const { DEFAULT_APPEND_PROMPT, DEFAULT_MANGA_PROMPT, DEFAULT_TRANSLATE_PROMPT, fillPrompt } = await import('../shared/prompts.js')

test('首次使用默认 DeepSeek 配置，显式自定义设置可覆盖默认值', () => {
  const initial = getAiSettings()
  assert.equal(initial.baseUrl, 'https://api.deepseek.com')
  assert.equal(initial.model, 'deepseek-flash')
  assert.equal(initial.apiKey, '')
  assert.deepEqual(initial.params, { thinking: { type: 'disabled' } })
  const custom = saveAiSettings({ baseUrl: 'https://example.com/v1', model: 'custom', params: {} })
  assert.equal(custom.baseUrl, 'https://example.com/v1')
  assert.equal(custom.model, 'custom')
  assert.deepEqual(custom.params, {})
  const fallback = saveAiSettings({})
  assert.equal(fallback.model, initial.model)
  assert.deepEqual(fallback.params, initial.params)
})

type ChatBody = { messages: Array<{ role: string; content: string }>; response_format?: any }

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

test('输出模式默认兼容旧配置，非法值回落默认，覆盖配置继承已保存模式', async () => {
  const { mergeAiSettings } = await import('../server/ai.js')
  useSettings({})
  assert.equal(getAiSettings().outputMode, 'prompt')
  useSettings({ outputMode: 'invalid' })
  assert.equal(getAiSettings().outputMode, 'prompt')
  useSettings({ outputMode: 'json_schema' })
  assert.equal(mergeAiSettings({}).outputMode, 'json_schema')
  assert.equal(mergeAiSettings({ outputMode: 'json_object' }).outputMode, 'json_object')
  const reloaded = await import(`../server/ai.js?output-mode=${Date.now()}`)
  assert.equal(reloaded.getAiSettings().outputMode, 'json_schema')
})

for (const outputMode of ['prompt', 'json_schema', 'json_object'] as const) {
  test(`${outputMode}：作品与漫画请求使用所选格式且自定义参数不能覆盖`, async () => {
    useSettings({ outputMode, params: { response_format: { type: 'invalid' } } })
    stubReply({ title: '译文', tags: ['标签'] })
    await translateFields({ fields: { title: 'title', tags: ['tag'] }, force: true })
    const work = calls.at(-1)!
    stubReply({ translations: ['译文'] })
    await translateMangaTexts({ texts: ['text'] })
    const manga = calls.at(-1)!
    for (const body of [work, manga]) {
      if (outputMode === 'prompt') assert.equal('response_format' in body, false)
      else assert.equal(body.response_format.type, outputMode)
    }
    if (outputMode === 'json_schema') {
      assert.deepEqual(work.response_format.json_schema, {
        name: 'work_translation', strict: true,
        schema: {
          type: 'object', additionalProperties: false, required: ['title', 'tags'],
          properties: { title: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
        },
      })
      assert.deepEqual(manga.response_format.json_schema, {
        name: 'manga_translation', strict: true,
        schema: {
          type: 'object', additionalProperties: false, required: ['translations'],
          properties: { translations: { type: 'array', items: { type: 'string' } } },
        },
      })
    }
  })
}
