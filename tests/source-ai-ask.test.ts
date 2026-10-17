import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'

import { customRules } from '../shared/source-presets.js'

// config.ts 在导入时就会解析数据目录，必须在动态 import 服务端模块之前指定。
const root = mkdtempSync(path.join(tmpdir(), 'source-ai-ask-'))
process.env.MEDIA_DATA_DIR = path.join(root, 'data')

const options = [
  { summary: '按住文件夹分开', description: '每个子目录各自成组，适合不同作者分开归档。' },
  { summary: '全部合并', description: '整个来源同 id 合并，适合文件都平铺在根目录的情况。' },
]

const finalRules = { ...customRules(), metadata: [], scope: 'directory' as const, script: 'export async function extract(input) { return { title: input.id }; }' }
const finalAnswer = JSON.stringify({ rules: finalRules, explanation: '按子目录隔离分组，已自检 4 组。' })

async function* readEvents(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    const chunks = buffer.split('\n\n')
    buffer = chunks.pop() || ''
    for (const chunk of chunks) {
      const line = chunk.split('\n').find(item => item.startsWith('data:'))
      if (line) yield JSON.parse(line.slice(5).trim()) as Record<string, any>
    }
  }
}

/** 假上游：第一轮思考后调用 ask_user，第二轮再给最终 JSON。只拦截 AI 上游地址，其余请求照常放行。 */
function upstream(calls: Array<{ body: any }>, passThrough: typeof fetch) {
  return (async (url: string, init: RequestInit) => {
    if (!String(url).includes('ai.example.test')) return passThrough(url, init)
    const body = JSON.parse(String(init?.body))
    calls.push({ body })
    const step = (calls.length - 1) % 2
    const stream = body.stream === true
    const chunk = (delta: Record<string, unknown>) => ({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: 'mock-model', choices: [{ index: 0, delta, finish_reason: null }] })
    const toolCall = { id: 'call_ask', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ reason: '确认是否按子目录隔离', question: '同一个 id 出现在不同子文件夹时，要合并还是分开？', why: '选错会让整份规则的分组全乱', options }) } }
    if (!stream) {
      const message = step === 0 ? { role: 'assistant', content: null, tool_calls: [toolCall] } : { role: 'assistant', content: finalAnswer }
      return new Response(JSON.stringify({ model: 'mock-model', choices: [{ message }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const events = step === 0
      ? [chunk({ role: 'assistant', reasoning_content: '先看目录结构，再决定要不要问用户。' }), chunk({ tool_calls: [{ index: 0, id: 'call_ask', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ reason: '确认是否按子目录隔离', question: '同一个 id 出现在不同子文件夹时，要合并还是分开？', why: '选错会让整份规则的分组全乱', options }) } }] })]
      : [chunk({ role: 'assistant', content: finalAnswer.slice(0, 20) }), chunk({ content: finalAnswer.slice(20) })]
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
}

test('ask_user：提问事件 → 用户回答 → 模型带着回答继续（流式）', async () => {
  const folder = path.join(root, 'media')
  await mkdir(path.join(folder, '作者A'), { recursive: true })
  await writeFile(path.join(folder, '100_p1.jpg'), 'x')
  await writeFile(path.join(folder, '作者A', '100_p1.jpg'), 'x')
  const { createApp } = await import('../server/app.js')
  const { db } = await import('../server/database.js')
  const { saveAiSettings } = await import('../server/ai.js')
  const app = await createApp(false)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = (app.server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`
  const originalFetch = globalThis.fetch
  const calls: Array<{ body: any }> = []
  globalThis.fetch = upstream(calls, originalFetch)
  try {
    saveAiSettings({ baseUrl: 'https://ai.example.test/v1', apiKey: 'k', model: 'mock-model', params: {}, timeoutMs: 5000 })
    const response = await fetch(`${base}/api/sources/ai/chat/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: folder, message: '按 ID 分组', thinkingLevel: 'default' }),
    })
    assert.equal(response.status, 200)
    const events: Record<string, any>[] = []
    let question: Record<string, any> | null = null
    const finished = (async () => {
      for await (const event of readEvents(response.body!.getReader())) {
        events.push(event)
        if (event.type === 'question') question = event.question
      }
    })()
    for (let attempt = 0; attempt < 200 && !question; attempt++) await new Promise(resolve => setTimeout(resolve, 25))
    assert.ok(question, '必须收到提问事件')
    assert.equal(question!.question, '同一个 id 出现在不同子文件夹时，要合并还是分开？')
    assert.deepEqual(question!.options.map((option: any) => option.summary), ['按住文件夹分开', '全部合并'])
    assert.ok(question!.options.every((option: any) => option.description))

    const answered = await fetch(`${base}/api/sources/ai/chat/answer`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questionId: question!.id, answer: '按住文件夹分开' }),
    })
    assert.equal(answered.status, 200)
    await finished

    // 思维链事件先于工具调用到达界面。
    const reasoningIndex = events.findIndex(event => event.type === 'reasoning_delta')
    const toolIndex = events.findIndex(event => event.type === 'tool_call')
    assert.ok(reasoningIndex >= 0 && reasoningIndex < toolIndex, JSON.stringify(events.map(event => event.type)))
    assert.ok(events[reasoningIndex].text.includes('先看目录结构'))

    const questionIndex = events.findIndex(event => event.type === 'tool_call' && event.call?.name === 'ask_user')
    assert.equal(events[questionIndex].call.reason, '确认是否按子目录隔离')
    assert.equal(events[questionIndex].call.status, 'running')
    const settled = events.find(event => event.type === 'tool_result' && event.call?.name === 'ask_user')
    assert.equal(settled.call.status, 'complete')
    assert.equal(settled.call.result.answer, '按住文件夹分开')

    const result = events.find(event => event.type === 'result')
    assert.equal(result.result.rules.scope, 'directory')
    assert.ok(result.result.messages.some((message: any) => /已询问用户/.test(message.text)))

    // 第二次请求必须把用户的回答以 TOON 回给模型，并且不是 JSON。
    const toolMessage = calls[1].body.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === 'call_ask')
    assert.ok(toolMessage.content.includes('userAnswer: 按住文件夹分开'), toolMessage.content)
    assert.ok(!toolMessage.content.trim().startsWith('{'))
    // 读目录 / 自检工具的输入输出都还在同一份 TOON 约定里。
    assert.ok(calls[0].body.tools.some((tool: any) => tool.function.name === 'ask_user'))
    assert.ok(calls[0].body.tools.every((tool: any) => tool.function.parameters.required.includes('reason')))

    // 已经回答过（或不存在）的提问再回答一次是 404，不会挂住任何东西。
    const again = await fetch(`${base}/api/sources/ai/chat/answer`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questionId: question!.id, answer: '全部合并' }),
    })
    assert.equal(again.status, 404)
  } finally {
    globalThis.fetch = originalFetch
    await app.close()
    // 同一进程里 database 是单例，留给本文件最后一个用例统一关闭和清理。
  }
})

test('非流式接口不能提问：立刻返回工具错误，让模型自己选一个方案', async () => {
  const folder = path.join(root, 'media2')
  await mkdir(folder, { recursive: true })
  await writeFile(path.join(folder, '200.jpg'), 'x')
  const { createApp } = await import('../server/app.js')
  const { db } = await import('../server/database.js')
  const { saveAiSettings } = await import('../server/ai.js')
  const app = await createApp(false)
  const originalFetch = globalThis.fetch
  const calls: Array<{ body: any }> = []
  globalThis.fetch = upstream(calls, originalFetch)
  try {
    saveAiSettings({ baseUrl: 'https://ai.example.test/v1', apiKey: 'k', model: 'mock-model', params: {}, timeoutMs: 5000 })
    const response = await app.inject({ method: 'POST', url: '/api/sources/ai/chat', payload: { path: folder, message: '按 ID 分组' } })
    assert.equal(response.statusCode, 200, response.body)
    const toolEvent = response.json().toolEvents.find((event: any) => event.name === 'ask_user')
    assert.equal(toolEvent.status, 'error')
    assert.ok(toolEvent.error.includes('不能向用户提问'), toolEvent.error)
    const toolMessage = calls[1].body.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === 'call_ask')
    assert.ok(toolMessage.content.includes('不能向用户提问'), toolMessage.content)
  } finally {
    globalThis.fetch = originalFetch
    await app.close()
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
