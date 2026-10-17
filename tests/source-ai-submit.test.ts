import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { customRules } from '../shared/source-presets.js'

// config.ts 在导入时就会解析数据目录，必须在动态 import 服务端模块之前指定。
const root = mkdtempSync(path.join(tmpdir(), 'source-ai-submit-'))
process.env.MEDIA_DATA_DIR = path.join(root, 'data')

const validRules = { ...customRules(), metadata: [], scope: 'directory' as const, script: 'export async function extract(input) { return { title: input.id }; }' }
const brokenRules = { ...customRules(), media: { mode: 'template', pattern: '{title}', caseSensitive: false } }

function toolCall(id: string, name: string, args: unknown) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

test('成果走 submit_rules 工具：正文照常说话，规则和说明由工具带回', async () => {
  const folder = path.join(root, 'media')
  await mkdir(folder, { recursive: true })
  await writeFile(path.join(folder, '100_p1.jpg'), 'x')
  await writeFile(path.join(folder, '100.json'), '{}')

  const { createApp } = await import('../server/app.js')
  const { db } = await import('../server/database.js')
  const { saveAiSettings } = await import('../server/ai.js')
  const app = await createApp(false)
  const originalFetch = globalThis.fetch
  const calls: Array<{ body: any }> = []

  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    calls.push({ body })
    const round = calls.length
    const message = round === 1
      // 第一轮：确认目录。
      ? { role: 'assistant', content: '', tool_calls: [toolCall('call_read', 'read_directory', { reason: '确认有哪些文件', path: '.', offset: 0, length: 100 })] }
      // 第二轮：正文写人话 + 调工具提交成果。
      : { role: 'assistant', content: '按 **文件名数字** 分组，页码取 `_p` 后面的数字。', tool_calls: [toolCall('call_submit', 'submit_rules', { reason: '已自检通过', rules: validRules, summary: '按 ID 分组，按子目录隔离' })] }
    return new Response(JSON.stringify({ model: 'stub-model', choices: [{ message }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  try {
    // 翻译的输出模式设成 json_object，也不能强迫规则 Agent 只吐 JSON。
    saveAiSettings({ baseUrl: 'https://ai.example.test/v1', apiKey: 'test-token', model: 'test-model', params: {}, outputMode: 'json_object', timeoutMs: 5000 })
    const response = await app.inject({ method: 'POST', url: '/api/sources/ai/chat', payload: { path: folder, message: '按 ID 分组' } })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(calls.length, 2, '提交后就该结束，不再请求模型')

    for (const call of calls) assert.equal(call.body.response_format, undefined, '规则 Agent 不再用 response_format 限制输出格式')
    const names = calls[0].body.tools.map((tool: any) => tool.function.name).sort()
    assert.deepEqual(names, ['ask_user', 'preview_rules', 'read_directory', 'submit_rules'])
    assert.ok(calls[0].body.messages[1].content.includes('submit_rules'), '工具说明必须讲清提交方式')

    const submitted = calls[1].body.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === 'call_read')
    assert.ok(submitted.content.includes('entries[2]'), submitted.content)

    const result = response.json()
    assert.equal(result.rules.scope, 'directory')
    assert.equal(result.rules.media.pattern, validRules.media.pattern)
    assert.equal(result.explanation, '按 ID 分组，按子目录隔离')
    assert.deepEqual(result.toolEvents.map((event: any) => [event.name, event.status]), [['read_directory', 'complete'], ['submit_rules', 'complete']])
    assert.equal(result.toolEvents[1].reason, '已自检通过')
    // 提交成功只回一句确认，不把整份规则再灌回去。
    assert.ok(result.toolEvents[1].text.includes('ok: true'), result.toolEvents[1].text)

    // 没写 summary 时用本轮正文兜底，结果卡片不会空着。
    calls.length = 0
    globalThis.fetch = (async () => new Response(JSON.stringify({
      model: 'stub-model',
      choices: [{ message: { role: 'assistant', content: '这轮直接提交，正文就是说明。', tool_calls: [toolCall('call_submit', 'submit_rules', { reason: '直接提交', rules: validRules })] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const noSummary = await app.inject({ method: 'POST', url: '/api/sources/ai/chat', payload: { path: folder, message: '再来' } })
    assert.equal(noSummary.statusCode, 200, noSummary.body)
    assert.equal(noSummary.json().explanation, '这轮直接提交，正文就是说明。')
  } finally {
    globalThis.fetch = originalFetch
    await app.close()
    // db 是单例，清理放在本文件最后一个用例里，否则后面的用例会撞上「database is not open」。
  }
})

test('submit_rules 校验失败会把字段级错误回给模型，改好再提交才算成果', async () => {
  const folder = path.join(root, 'media2')
  await mkdir(folder, { recursive: true })
  await writeFile(path.join(folder, '300.jpg'), 'x')

  const { createApp } = await import('../server/app.js')
  const { db } = await import('../server/database.js')
  const { saveAiSettings } = await import('../server/ai.js')
  const app = await createApp(false)
  const originalFetch = globalThis.fetch
  const calls: Array<{ body: any }> = []

  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body)) })
    const message = calls.length === 1
      ? { role: 'assistant', content: '先提交一版看看。', tool_calls: [toolCall('call_bad', 'submit_rules', { reason: '先试一版', rules: brokenRules })] }
      : { role: 'assistant', content: '按错误改好了。', tool_calls: [toolCall('call_good', 'submit_rules', { reason: '已修正', rules: validRules, summary: '修正后提交' })] }
    return new Response(JSON.stringify({ model: 'stub-model', choices: [{ message }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  try {
    saveAiSettings({ baseUrl: 'https://ai.example.test/v1', apiKey: 'test-token', model: 'test-model', params: {}, timeoutMs: 5000 })
    const response = await app.inject({ method: 'POST', url: '/api/sources/ai/chat', payload: { path: folder, message: '按 ID 分组' } })
    assert.equal(response.statusCode, 200, response.body)
    const result = response.json()
    assert.deepEqual(result.toolEvents.map((event: any) => [event.name, event.status]), [['submit_rules', 'error'], ['submit_rules', 'complete']])
    assert.ok(result.toolEvents[0].error.includes('缺少 {id}'), result.toolEvents[0].error)
    // 错误以 TOON 回到模型，正文（人话）也一起带进下一轮。
    const errorMessage = calls[1].body.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === 'call_bad')
    assert.ok(errorMessage.content.includes('缺少 {id}'), errorMessage.content)
    assert.ok(!errorMessage.content.trim().startsWith('{'), errorMessage.content)
    const assistant = calls[1].body.messages.find((message: any) => message.role === 'assistant')
    assert.equal(assistant.content, '先提交一版看看。')
    assert.equal(result.explanation, '修正后提交')
  } finally {
    globalThis.fetch = originalFetch
    await app.close()
  }
})

test('既没提交也没给出 JSON 时给出可读错误，而不是把正文当规则', async () => {
  const folder = path.join(root, 'media3')
  await mkdir(folder, { recursive: true })
  await writeFile(path.join(folder, '400.jpg'), 'x')

  const { createApp } = await import('../server/app.js')
  const { db } = await import('../server/database.js')
  const { saveAiSettings } = await import('../server/ai.js')
  const app = await createApp(false)
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async () => new Response(JSON.stringify({
    model: 'stub-model',
    choices: [{ message: { role: 'assistant', content: '我觉得按文件名分组就行，你看这样好不好？' } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch

  try {
    saveAiSettings({ baseUrl: 'https://ai.example.test/v1', apiKey: 'test-token', model: 'test-model', params: {}, timeoutMs: 5000 })
    const response = await app.inject({ method: 'POST', url: '/api/sources/ai/chat', payload: { path: folder, message: '按 ID 分组' } })
    assert.equal(response.statusCode, 502)
    assert.ok(response.json().message.includes('没有提交规则'), response.body)
  } finally {
    globalThis.fetch = originalFetch
    await app.close()
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
