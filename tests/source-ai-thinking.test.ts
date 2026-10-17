import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { customRules } from '../shared/source-presets.js'
import { AI_THINKING_LEVELS, DEFAULT_AI_THINKING_LEVEL, asAiThinkingLevel, thinkingRequestParams } from '../shared/ai-thinking.js'

// config.ts 在导入时就会解析数据目录，必须在动态 import 服务端模块之前指定。
const root = mkdtempSync(path.join(tmpdir(), 'source-ai-thinking-'))
process.env.MEDIA_DATA_DIR = path.join(root, 'data')

test('思考深度：default 不额外传参，其余五档映射成 reasoning_effort', () => {
  assert.equal(DEFAULT_AI_THINKING_LEVEL, 'high')
  assert.deepEqual([...AI_THINKING_LEVELS], ['default', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(thinkingRequestParams('default'), {})
  assert.deepEqual(thinkingRequestParams('low'), { reasoning_effort: 'low' })
  assert.deepEqual(thinkingRequestParams('high'), { reasoning_effort: 'high' })
  assert.deepEqual(thinkingRequestParams('xhigh'), { reasoning_effort: 'xhigh' })
  assert.deepEqual(thinkingRequestParams('max'), { reasoning_effort: 'max' })
  assert.equal(asAiThinkingLevel('medium'), 'medium')
  assert.equal(asAiThinkingLevel('nope'), 'high')
  assert.equal(asAiThinkingLevel(null), 'high')
  assert.equal(asAiThinkingLevel(undefined, 'default'), 'default')
})

test('规则 Agent：思考深度独立于自定义参数，并强制用 preview_rules 自检', async () => {
  const folder = path.join(root, 'media')
  await mkdir(folder, { recursive: true })
  await writeFile(path.join(folder, '100_p1.jpg'), 'x')
  await writeFile(path.join(folder, '100_p2.jpg'), 'x')
  await writeFile(path.join(folder, '200.jpg'), 'x')
  await writeFile(path.join(folder, '100.txt'), 'PRIVATE METADATA CONTENT')

  const { createApp } = await import('../server/app.js')
  const { db } = await import('../server/database.js')
  const { saveAiSettings } = await import('../server/ai.js')
  const app = await createApp(false)
  const originalFetch = globalThis.fetch
  const calls: Array<{ body: any }> = []
  const finalRules = { ...customRules(), metadata: [], script: 'export async function extract(input) { return { title: input.id }; }' }

  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body)) })
    // 第一轮先要求模型自检分组，第二轮用提交工具交出成果。
    const message = calls.length === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_preview', type: 'function', function: { name: 'preview_rules', arguments: JSON.stringify({ rules: finalRules }) } }] }
      : { role: 'assistant', content: '按 ID 分组，已自检。', tool_calls: [{ id: 'call_submit', type: 'function', function: { name: 'submit_rules', arguments: JSON.stringify({ reason: '自检通过', rules: finalRules, summary: '按 ID 分组，已自检' }) } }] }
    return new Response(JSON.stringify({ model: 'stub-model', choices: [{ message }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  try {
    saveAiSettings({ baseUrl: 'https://ai.example.test/v1', apiKey: 'test-token', model: 'test-model', params: { temperature: 0.3, top_p: 0.9 }, timeoutMs: 5000 })

    const first = await app.inject({ method: 'POST', url: '/api/sources/ai/chat', payload: { path: folder, message: '按 ID 分组', ignoreCustomParams: true, thinkingLevel: 'low' } })
    assert.equal(first.statusCode, 200, first.body)
    assert.equal(calls.length, 2, '工具调用后应当再请求一次模型')
    const toolNames = calls[0].body.tools.map((tool: any) => tool.function.name).sort()
    assert.deepEqual(toolNames, ['ask_user', 'preview_rules', 'read_directory', 'submit_rules'])
    // 思考深度和「不使用自定义参数」互不影响：参数被跳过，思考仍然传下去。
    assert.equal(calls[0].body.reasoning_effort, 'low')
    assert.equal(calls[0].body.temperature, undefined)
    assert.equal(calls[0].body.top_p, undefined)
    assert.ok(calls[0].body.messages[0].content.includes('非贪婪'), '内置提示词照旧生效')
    assert.ok(calls[0].body.messages[1].content.includes('preview_rules'), '工具说明必须写清 preview_rules 的用法')
    assert.ok(calls[0].body.messages[1].content.includes('submit_rules'), '工具说明必须写清成果怎么提交')
    assert.equal(calls[0].body.response_format, undefined, '成果走工具提交，不再强迫模型只输出 JSON')

    const toolMessage = calls[1].body.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === 'call_preview')
    assert.ok(toolMessage, '第二轮请求必须带回自检结果')
    // 回给模型的是 TOON 文本，不是 JSON。
    assert.ok(!toolMessage.content.trim().startsWith('{'), toolMessage.content)
    assert.ok(toolMessage.content.includes('groupCount: 2'), toolMessage.content)
    assert.ok(toolMessage.content.includes('matched: 3'), toolMessage.content)
    assert.ok(toolMessage.content.includes('enumerated: 4'), toolMessage.content)
    assert.ok(toolMessage.content.includes('groups[2]{id,directory,media,metadata,sample}:'), toolMessage.content)
    assert.ok(toolMessage.content.includes('100,"",2,0,100_p1.jpg | 100_p2.jpg'), toolMessage.content)
    assert.ok(!toolMessage.content.includes('PRIVATE'), toolMessage.content)
    assert.ok(toolMessage.content.length < JSON.stringify(first.json().toolEvents[0].result).length, 'TOON 应比 JSON 短')

    const result = first.json()
    assert.equal(result.rules.media.pattern, finalRules.media.pattern)
    assert.equal(result.explanation, '按 ID 分组，已自检')
    assert.deepEqual(result.toolEvents.map((event: any) => [event.name, event.status]), [['preview_rules', 'complete'], ['submit_rules', 'complete']])
    assert.ok(result.messages.some((message: any) => /规则自检：枚举 4 个文件，命中 3 个媒体，分成 2 组/.test(message.text)))

    // 换一轮：不再勾选「不使用自定义参数」，思考深度用 default 挡位。
    calls.length = 0
    const second = await app.inject({ method: 'POST', url: '/api/sources/ai/chat', payload: { path: folder, message: '再来一次', ignoreCustomParams: false, thinkingLevel: 'default' } })
    assert.equal(second.statusCode, 200, second.body)
    assert.equal(calls[0].body.reasoning_effort, undefined)
    assert.equal(calls[0].body.temperature, 0.3)
    assert.equal(calls[0].body.top_p, 0.9)

    // 非法挡位由请求校验直接拒绝。
    const invalid = await app.inject({ method: 'POST', url: '/api/sources/ai/chat', payload: { path: folder, message: 'x', thinkingLevel: 'turbo' } })
    assert.equal(invalid.statusCode, 400)
  } finally {
    globalThis.fetch = originalFetch
    await app.close()
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
