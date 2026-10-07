import test from 'node:test'
import assert from 'node:assert/strict'
import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import { javascript } from '@codemirror/lang-javascript'
import { captureNames, inputCompletions } from '../src/source-input-completion.js'
import { createStatusPoller } from '../src/status-poller.js'

test('input 自动补全：顶层、媒体、元文件、捕获字段、可选链', () => {
  function complete(text: string) {
    const state = EditorState.create({doc:text,extensions:[javascript()]})
    return inputCompletions(new CompletionContext(state,text.length,true),['id','author'],['id','title'])
  }
  assert.deepEqual(complete('input.')?.options.map(v=>v.label),['id','directory','media','files'])
  assert.equal(complete('input.media[0].')?.options.some(v=>v.label==='text'),false)
  assert.equal(complete('input.files[0]?.')?.options.some(v=>v.label==='text'),true)
  assert.deepEqual(complete('input.media[0].captures.')?.options.map(v=>v.label),['id','author'])
  assert.deepEqual(complete('input.files.at(0)?.captures.')?.options.map(v=>v.label),['id','title'])
  assert.ok(complete('input?.fi')?.options.some(v=>v.label==='files'))
  assert.equal(complete('// input.'),null)
  assert.equal(complete('"input.'),null)
  assert.equal(complete('other.input.media[0].')?.options.some(v=>v.label==='filename'),true)
  assert.deepEqual(captureNames([{mode:'template',pattern:'{id}_{author}',caseSensitive:false},{mode:'regex',pattern:'(?<id>\\d+)(?<title>.*)',caseSensitive:false}]),['id','author','title'])
})

test('设置页轮询：持续更新、请求不重叠、出错重试、卸载忽略迟到结果', async () => {
  const waits: Array<{resolve(value:number):void;reject(error:Error):void}> = []
  const received:number[]=[],errors:unknown[]=[]
  let active=0,maxActive=0
  const poll = createStatusPoller(() => {
    active++;maxActive=Math.max(maxActive,active)
    return new Promise<number>((resolve,reject)=>waits.push({resolve:v=>{active--;resolve(v)},reject:e=>{active--;reject(e)}}))
  },v=>received.push(v),e=>errors.push(e),5)
  const tick = () => new Promise(r=>setTimeout(r,20))
  try {
    poll.start(); void poll.refresh(); void poll.refresh()
    assert.equal(waits.length,1)
    waits.shift()!.resolve(1); await tick(); assert.deepEqual(received,[1])
    assert.equal(waits.length,1)
    waits.shift()!.reject(new Error('network'));await tick();assert.equal(errors.length,1)
    waits.shift()!.resolve(2);await tick();assert.deepEqual(received,[1,2])
    poll.stop(); waits.shift()!.resolve(3);await tick()
    assert.deepEqual(received,[1,2]); assert.equal(waits.length,0);assert.equal(maxActive,1)
  } finally {poll.stop()}
})
