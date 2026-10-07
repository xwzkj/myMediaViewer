import { parentPort } from 'node:worker_threads'
import { getQuickJS } from 'quickjs-emscripten'
import { ruleSubject } from '../shared/file-rules.js'
import { rulePattern, LIMITS } from './source-rules.js'
import type { FileRule, SourceRules, ScriptInput } from '../shared/types.js'

const QuickJS = await getQuickJS()
function compile(rule: FileRule) { return new RegExp(`^(?:${rulePattern(rule)})$`, rule.caseSensitive ? '' : 'i') }
function execute(script: string, input?: ScriptInput, compileOnly = false) {
  const rt = QuickJS.newRuntime()
  rt.setMemoryLimit(64 * 1024 * 1024)
  rt.setMaxStackSize(512 * 1024)
  const deadline = Date.now() + 1000
  rt.setInterruptHandler(() => Date.now() >= deadline)
  rt.setModuleLoader(() => { throw new Error('不允许导入任何模块') })
  const vm = rt.newContext()
  const handles: Array<{ dispose(): void }> = []
  const take = <T extends { dispose(): void }>(h: T): T => { handles.push(h); return h }
  try {
    // Serialize inside the guest, under the execution deadline, never dump arbitrary guest objects.
    const bootstrap = take(vm.unwrapResult(vm.evalCode(`(() => {
      const stringify = JSON.stringify.bind(JSON);
      const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
      const input = freeze(${JSON.stringify(input ?? {})});
      return fn => Promise.resolve(fn(input)).then(result => {
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('提取结果必须为对象');
        const output = {};
        for (const key of ['title','author','description','tags','date','originalUrl']) {
          if (result[key] !== undefined) output[key] = result[key];
        }
        const text = stringify(output);
        if (text.length > ${LIMITS.output}) throw Error('输出超过 256 KiB');
        return text;
      });
    })()`)))
    const mod = take(vm.unwrapResult(vm.evalCode(script, 'extract.js', { type: 'module', compileOnly })))
    if (compileOnly) return null
    const fn = take(vm.getProp(mod, 'extract'))
    if (vm.typeof(fn) !== 'function') throw new Error('脚本必须导出 extract(input) 函数')
    if (!input) return null
    const promise = take(vm.unwrapResult(vm.callFunction(bootstrap, vm.undefined, fn)))
    while (true) {
      if (Date.now() >= deadline) throw new Error('脚本执行超时')
      const state = vm.getPromiseState(promise)
      if (state.type === 'fulfilled') {
        const value = take(state.value)
        const text = vm.getString(value)
        if (Buffer.byteLength(text) > LIMITS.output) throw new Error('输出超过 256 KiB')
        return JSON.parse(text)
      }
      if (state.type === 'rejected') {
        take(state.error)
        // Reading stack/message can execute user getters; the outer worker deadline remains authoritative.
        const message = take(vm.getProp(state.error, 'message'))
        const stack = take(vm.getProp(state.error, 'stack'))
        const location = vm.typeof(stack) === 'string' ? vm.getString(stack).match(/extract\.js:(\d+)(?::(\d+))?/) : null
        throw new Error((location ? `JS 第 ${location[1]} 行${location[2] ? `，第 ${location[2]} 列` : ''}：` : '') + (vm.typeof(message) === 'string' ? vm.getString(message).slice(0, 1000) : '脚本执行失败'))
      }
      if (!rt.hasPendingJob()) throw new Error('脚本 Promise 未完成，沙箱不提供外部 I/O')
      const result = rt.executePendingJobs(32)
      if (result.error) { result.error.dispose(); throw new Error('脚本微任务执行失败或超时') }
    }
  } finally {
    for (const h of handles.reverse()) h.dispose()
    vm.dispose(); rt.dispose()
  }
}
parentPort!.on('message', (task: { type: string; rules: SourceRules; names?: string[]; input?: ScriptInput }) => {
  try {
    let result: unknown
    if (task.type === 'extract') result = execute(task.rules.script, task.input)
    else {
      const media = compile(task.rules.media), metas = task.rules.metadata.map(compile)
      if (task.type === 'validate' || task.type === 'syntax') result = execute(task.rules.script, undefined, task.type === 'syntax')
      else result = task.names!.map(name => {
        for (let i = 0; i < metas.length; i++) { const subject = ruleSubject(task.rules.metadata[i], name); const match = metas[i].exec(subject); if (match?.groups && match[0].length === subject.length) return { metadata: true, captures: match.groups } }
        const subject = ruleSubject(task.rules.media, name)
        const match = media.exec(subject)
        return match?.groups && match[0].length === subject.length ? { metadata: false, captures: match.groups } : null
      })
    }
    parentPort!.postMessage({ ok: true, result })
  } catch (error) { parentPort!.postMessage({ ok: false, error: String((error as Error).message || error).slice(0, 1200) }) }
})
parentPort!.postMessage({ ready: true })
