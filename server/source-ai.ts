import { randomUUID } from 'node:crypto'
import { generateSourceRulesInteractive } from './ai.js'
import { getSourceTreeFolder, getSourceTreeSample, readSourceTreeDirectory, SOURCE_TREE_MAX_CALLS, SOURCE_TREE_MAX_LENGTH } from './source-tree.js'
import { summarizeRules } from './source-engine.js'
import { validateRulesShape } from './source-rules.js'
import { isBlankSourceRules } from '../shared/source-presets.js'
import { asAiThinkingLevel } from '../shared/ai-thinking.js'
import { toon } from '../shared/toon.js'
import type { SourceRules, SourceAiResult, SourceAiMessage, SourceAiQuestion, SourceAiQuestionOption, SourceAiToolCall } from '../shared/types.js'
import type { SourceRuleToolTurn, SourceRuleStreamSink } from './ai.js'

type Turn = SourceRuleToolTurn
type Conversation = { folder: string; turns: Turn[]; expires: number; busy: boolean }
const conversations = new Map<string,Conversation>()
let active = 0

export interface SourceAiTurn { path?: string; sampleToken?: string; conversationId?: string; message?: string; currentRules?: SourceRules; ignoreCustomParams?: boolean; thinkingLevel?: string }
export interface SourceAiStreamOptions { onEvent?: SourceRuleStreamSink; signal?: AbortSignal }

/** 每轮对话里 preview_rules 的自检次数上限，避免模型反复试跑浪费额度。 */
const SOURCE_PREVIEW_MAX_CALLS = 4
/** 自检时最多枚举的文件数：只用来判断分组是否合理，不需要全量。 */
const SOURCE_PREVIEW_FILE_LIMIT = 3000
/** 一轮对话里最多向用户提问几次，以及等待回答的时长。 */
const SOURCE_ASK_MAX_CALLS = 3
const SOURCE_ASK_TIMEOUT = 10 * 60_000

/** ask_user 抛出的问题在等待用户点击期间挂在这里；回答到达后唤醒模型继续。 */
interface PendingQuestion { answer: (value: string) => void; fail: (error: Error) => void; timer: NodeJS.Timeout; conversationId: string }
const pendingQuestions = new Map<string, PendingQuestion>()

/** 前端把用户的回答送回本轮挂起的提问；未知或已过期返回 404。 */
export function answerSourceAiQuestion(id: string, answer: string): void {
  const pending = pendingQuestions.get(id)
  if (!pending) throw Object.assign(new Error('这个问题已经失效，请重新提问'), { statusCode: 404 })
  pendingQuestions.delete(id)
  clearTimeout(pending.timer)
  pending.answer(answer.slice(0, 2000) || '（用户未填写内容）')
}

function closeQuestions(conversationId: string): void {
  for (const [id, pending] of pendingQuestions) {
    if (pending.conversationId !== conversationId) continue
    pendingQuestions.delete(id)
    clearTimeout(pending.timer)
    pending.fail(new Error('本轮已结束，提问作废'))
  }
}

const TOOL_INSTRUCTION = `工具使用说明（必须遵守）
0. 数据格式：工具结果和当前配置都用 TOON 文本返回，不是 JSON。TOON 语法：\`键: 值\`；嵌套对象换行后缩进两个空格；数组写成 \`键[数量]\`；每项都是扁平对象的数组写成 \`键[数量]{列1,列2}:\` 再跟对应行数的数据行；含逗号、冒号、引号、方括号或换行的字符串用双引号包起来。目录树样本另有一种格式：每行 \`|-- 名称\`，目录以 / 结尾，行首缩进表示层级。
1. 每次工具调用都必须带 reason 参数，用一句中文说明这次调用想确认什么（会直接显示给用户）。
2. read_directory —— 按页读取来源目录里的名称，只返回名称，不返回文件内容。
   · path 为来源内相对目录，根目录写 "."；offset 从 0 开始分页，length 最大 ${SOURCE_TREE_MAX_LENGTH}。
   · 用户第一条消息里通常已经带了目录树样本。样本被截断时会出现「目录树样本已截断」，那不是真实文件名，不能当成文件。样本里没有的目录或文件一律用工具确认，不要猜测。
   · 整个任务最多调用 ${SOURCE_TREE_MAX_CALLS} 次；同一路径已经读过就不用重复读，除非确实需要下一页。
3. preview_rules —— 用一组完整规则在真实目录上试跑分组，返回：枚举文件数 enumerated、命中媒体数 matched、分组数 groupCount、是否截断，以及若干分组样例（id、directory、media、metadata、sample 相对路径）。它只验证「分组对不对」，不读元文件内容、也不执行脚本。
   · 在给出最终结果之前，必须把完整的候选规则传进去自检一次，不能只靠猜。
   · 看摘要自查：组数是否和作品数吻合？enumerated 与 matched 差距过大说明有文件没匹配上；id 里混进了标题/作者/扩展名说明捕获范围过宽；同一作品被拆成多组说明正则太严或缺少默认页码。
   · 发现问题就修正规则后再次自检；最多调用 ${SOURCE_PREVIEW_MAX_CALLS} 次，用完必须给出结论。
   · rules 参数必须是可以直接当最终答案的完整 SourceRules（media、metadata、scope、duplicates、typeOverrides、script 全都要有，没有元文件时 metadata 传 []）。不要传补丁或片段。
4. ask_user —— 只在「凭文件名无法确定、选错会让整份规则白做」时向用户提问，例如元文件字段含义、页码从 0 还是 1 开始、是否按子目录隔离、是否要把 TXT/JSON 当成元文件、作品 ID 取哪一段。
   · 不要问能从文件名直接看出来的事，也不要问用户已经在要求里写清楚的偏好；能靠 preview_rules 验证的就别问。整轮最多问 ${SOURCE_ASK_MAX_CALLS} 次，能一次问清就一次问完（把相关疑问合并成一问）。
   · options 给 2-5 个候选，按推荐度从高到低排列（第一个是你推荐的答案）；每项 summary 不超过 20 字，description 不超过 60 字，说明选了会有什么后果。用户也可以自己输入答案。
   · 提问后等用户回答即可，回答会作为该工具的结果返回给你，不要自己替用户选。
5. submit_rules —— 自检确认后用这个工具把本轮成果交出去，正文可以照常写 Markdown 说明。
   · 参数：rules 是完整的 SourceRules 对象（必须是对象，不要传 JSON 字符串或代码块），summary 是一句话说明这次改了什么、有什么假设。
   · 不要在正文里贴 JSON 或整份规则；正文写人话，规则只走这个工具。
   · 校验不通过时会返回字段级错误，按错误改好再提交；成功即本轮结束，不用再输出任何内容。
6. 工具调用、提问和结果都会直接显示给用户，所以每次调用都要有明确目的。`

/** 目录读取结果按 TOON 表格给模型，比 JSON 省一半以上 token。 */
function directoryReadText(result: unknown): string {
  const read = result as { path?: string; total?: number; offset?: number; hasMore?: boolean; entries?: Array<{ name: string; type: string }> }
  return toon({
    path: read?.path ?? '.',
    total: read?.total ?? 0,
    offset: read?.offset ?? 0,
    hasMore: read?.hasMore ?? false,
    提示: 'type 为 directory 的是子目录，需要时再用 read_directory 展开',
    entries: (read?.entries ?? []).map(entry => ({ name: entry.name, type: entry.type })),
  })
}

/** 自检摘要压成表：枚举/命中/分组概览 + 每个分组的样例。 */
function previewSummaryText(result: unknown): string {
  const summary = result as { enumerated?: number; matched?: number; groupCount?: number; truncated?: boolean; errors?: string[]; groups?: Array<{ id: string; directory: string; media: number; metadata: number; sample: string[] }> }
  const groups = summary?.groups ?? []
  return toon({
    enumerated: summary?.enumerated ?? 0,
    matched: summary?.matched ?? 0,
    groupCount: summary?.groupCount ?? 0,
    truncated: summary?.truncated ?? false,
    errors: summary?.errors ?? [],
    groups: groups.map(group => ({ id: group.id, directory: group.directory, media: group.media, metadata: group.metadata, sample: group.sample.join(' | ') })),
  })
}

function questionText(result: unknown): string {
  const answer = (result as { answer?: string })?.answer ?? ''
  return toon({ userAnswer: answer, 说明: '这是用户对你上一个问题的回答，请据此继续；不要再重复问同一个问题' })
}

/** 提交成功只回一句确认：规则本身不用再回灌给模型，省 token。 */
function submissionText(): string {
  return toon({ ok: true, 说明: '规则已作为本轮成果提交并通过校验，本轮到此结束' })
}

function asQuestionOptions(value: unknown): SourceAiQuestionOption[] {
  const list = Array.isArray(value) ? value : []
  const options = list.slice(0, 5).map(item => {
    const option = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    return {
      summary: String(option.summary ?? option.label ?? '').trim().slice(0, 40),
      description: String(option.description ?? option.detail ?? '').trim().slice(0, 200),
    }
  }).filter(option => option.summary)
  if (options.length < 2) throw new Error('ask_user 至少需要 2 个带 summary 的选项')
  return options
}

/** 挂起一轮模型调用，等用户点选项或自己输入；超时或客户端断开都会结束本轮。 */
function waitForAnswer(question: SourceAiQuestion, conversationId: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => { signal?.removeEventListener('abort', onAbort); reject(error) }
    const finish = (value: string) => { signal?.removeEventListener('abort', onAbort); resolve(value) }
    const onAbort = () => { const pending = pendingQuestions.get(question.id); if (pending) { pendingQuestions.delete(question.id); clearTimeout(pending.timer) } fail(Object.assign(new Error('已取消本轮任务'), { statusCode: 499 })) }
    const timer = setTimeout(() => { pendingQuestions.delete(question.id); fail(Object.assign(new Error('等待回答超时，本轮已结束'), { statusCode: 408 })) }, SOURCE_ASK_TIMEOUT)
    timer.unref?.()
    pendingQuestions.set(question.id, { answer: finish, fail, timer, conversationId })
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function eventMessages(events: SourceAiToolCall[]): SourceAiMessage[] {
  return events.map(item => {
    const event = item
    const args = event.arguments || {}
    if (event.status === 'error') return { role: 'tool' as const, text: `工具调用失败：${event.error}`, toolCall: event }
    if (event.name === 'preview_rules') {
      const summary = event.result as { groupCount?: number; enumerated?: number; matched?: number } | undefined
      return { role: 'tool' as const, text: `规则自检：枚举 ${summary?.enumerated ?? 0} 个文件，命中 ${summary?.matched ?? 0} 个媒体，分成 ${summary?.groupCount ?? 0} 组`, toolCall: event }
    }
    if (event.name === 'ask_user') return { role: 'tool' as const, text: `已询问用户：${String(args.question ?? '').slice(0, 80)} → ${String((event.result as { answer?: string })?.answer ?? '')}`, toolCall: event }
    return { role: 'tool' as const, text: `已读取 ${String(args.path || '.')}（offset ${String(args.offset ?? 0)}，返回 ${Array.isArray((event.result as { entries?: unknown[] })?.entries) ? (event.result as { entries: unknown[] }).entries.length : 0} 项）`, toolCall: event }
  })
}

export async function sourceAiTurn(input: SourceAiTurn, options: SourceAiStreamOptions = {}): Promise<SourceAiResult> {
  for (const [key,value] of conversations) if (value.expires < Date.now() && !value.busy) conversations.delete(key)
  if (active >= 2) throw Object.assign(new Error('AI 生成任务繁忙，请稍后重试'),{statusCode:429})
  const requestMessage = typeof input.message === 'string' ? input.message : ''
  const id = input.conversationId || randomUUID()
  let conversation = conversations.get(id)
  let firstTree = ''
  if (input.conversationId && !conversation) throw Object.assign(new Error('对话已过期，请新建对话'),{statusCode:410})
  if (conversation?.busy) throw Object.assign(new Error('本轮仍在生成，请稍候'),{statusCode:409})
  if (!conversation) {
    const folder = input.path?.trim() || (() => { try { return getSourceTreeFolder((input as any).sampleToken) } catch { return '' } })()
    if (!folder) throw Object.assign(new Error('请选择来源目录'), { statusCode: 400 })
    // 首轮带上目录树样本，省掉一次 read_directory 往返；样本过期不影响本轮（模型可以自己读）。
    if (input.sampleToken) { try { firstTree = getSourceTreeSample((input as any).sampleToken).tree } catch { firstTree = '' } }
    if (conversations.size >= 8) {
      const oldest = [...conversations].find(([,v])=>!v.busy)
      if (oldest) conversations.delete(oldest[0])
    }
    conversation = { folder, turns: [], expires: Date.now()+30*60_000, busy: false }
  } else if (input.path && input.path.trim() !== conversation.folder) {
    throw Object.assign(new Error('来源目录已改变，请新建对话'), { statusCode: 409 })
  }
  let currentRules = input.currentRules
  if (currentRules) { try { if (isBlankSourceRules(currentRules)) currentRules = undefined } catch {} }
  // 用户消息用纯文本 + TOON，不用 JSON。
  const user: Turn = { role:'user', content:[
    `用户要求：${requestMessage.trim() || '（没有额外说明，先按文件名规律给出方案，有疑问可以提问）'}`,
    firstTree ? `目录树样本（|-- 名称，目录以 / 结尾，... 表示截断）：\n${firstTree}` : '',
    currentRules ? `当前编辑器配置（TOON，请在此基础上修改并保留无关设置）：\n${toon(currentRules)}` : '当前编辑器配置：无（空白起点）',
  ].filter(Boolean).join('\n\n') }
  if (Buffer.byteLength(user.content || '')>192*1024) throw Object.assign(new Error('当前配置过大，请缩短脚本后重试'),{statusCode:413})
  const history = [...conversation.turns]
  let contextTrimmed = false
  while (history.length > 16 || Buffer.byteLength(JSON.stringify([...history,user])) > 384*1024) {
    if (!history.length) break
    history.splice(0,2); contextTrimmed=true
  }
  const folder = conversation.folder
  conversation.busy = true; conversations.set(id,conversation); active++
  const events: SourceAiToolCall[] = []
  // 每个工具单独计数：read_directory 防重复翻页，preview_rules 防反复试跑。
  const used = new Map<string, number>()
  const spend = (name: string, max: number) => {
    const count = (used.get(name) || 0) + 1
    used.set(name, count)
    if (count > max) throw new Error(`${name} 最多调用 ${max} 次，请直接用已知信息确认并提交成果`)
  }
  try {
    await options.onEvent?.({ type: 'status', message: '开始探索来源目录并生成规则' })
    const result = await generateSourceRulesInteractive(
      [{ role:'system', content: TOOL_INSTRUCTION }, ...history, user],
      [{
        name: 'read_directory',
        description: `读取来源目录的一页名称列表。只能读取来源目录内部，length 最大 ${SOURCE_TREE_MAX_LENGTH}，可用 offset 分页；只返回名称，不返回文件内容。结果以 TOON 表格返回。`,
        parameters: { type:'object', additionalProperties:false, properties: {
          reason: { type:'string', description:'本次读取想确认什么，一句话中文，会显示给用户' },
          path: { type:'string', description:'来源内相对目录路径，根目录使用 .' },
          offset: { type:'integer', minimum:0, description:'分页起点，默认 0' },
          length: { type:'integer', minimum:1, maximum:SOURCE_TREE_MAX_LENGTH, description:`本次读取数量，最大 ${SOURCE_TREE_MAX_LENGTH}` },
        }, required:['reason','path','offset','length'] },
        serialize: directoryReadText,
        execute: async (args: unknown) => {
          if (!args || typeof args !== 'object') throw new Error('工具参数无效')
          const raw = args as Record<string, unknown>
          const path = typeof raw.path === 'string' ? raw.path : '.'
          const offset = Number.isInteger(raw.offset) ? raw.offset as number : 0
          const length = Number.isInteger(raw.length) ? raw.length as number : SOURCE_TREE_MAX_LENGTH
          if (length < 1 || length > SOURCE_TREE_MAX_LENGTH) throw new Error(`length 必须是 1-${SOURCE_TREE_MAX_LENGTH}`)
          spend('read_directory', SOURCE_TREE_MAX_CALLS)
          return readSourceTreeDirectory(folder, path, offset, length)
        },
      }, {
        name: 'preview_rules',
        description: '用一组完整规则在真实来源目录上试跑分组，返回枚举文件数、命中媒体数、分组数量与分组样例，用来在给出最终结果前自检分组是否正确。不读取元文件内容、不执行脚本。结果以 TOON 表格返回。',
        parameters: { type:'object', additionalProperties:false, properties: {
          reason: { type:'string', description:'本次自检想确认的问题，一句话中文，会显示给用户' },
          rules: { type:'object', additionalProperties:true, description:'完整的 SourceRules 对象，和最终答案里的 rules 相同' },
        }, required:['reason','rules'] },
        serialize: previewSummaryText,
        execute: async (args: unknown) => {
          if (!args || typeof args !== 'object') throw new Error('工具参数无效')
          const rules = (args as Record<string, unknown>).rules
          if (!rules || typeof rules !== 'object') throw new Error('缺少 rules 参数：请传入完整的 SourceRules 对象')
          // 先做同步形状校验，让模型拿到可读的字段级错误，再真的去跑分组。
          validateRulesShape(rules)
          spend('preview_rules', SOURCE_PREVIEW_MAX_CALLS)
          const summary = await summarizeRules(folder, rules as SourceRules, { fileLimit: SOURCE_PREVIEW_FILE_LIMIT })
          await options.onEvent?.({ type: 'status', message: `规则自检：已枚举 ${summary.enumerated} 个文件，命中 ${summary.matched} 个媒体，分成 ${summary.groupCount} 组` })
          return summary
        },
      }, {
        name: 'ask_user',
        description: '向用户提问并等待回答，用于凭文件名无法确定、猜错会让整份规则白做的关键选择。选项按推荐度从高到低排列，用户也可以自己输入答案。',
        parameters: { type:'object', additionalProperties:false, properties: {
          reason: { type:'string', description:'为什么必须问用户，一句话中文' },
          question: { type:'string', description:'问题本身，一句话中文，不超过 80 字' },
          why: { type:'string', description:'可选：这个选择会影响什么，一句话' },
          options: { type:'array', minItems:2, maxItems:5, description:'2-5 个候选答案，按推荐度从高到低排列，第一个是你推荐的',
            items: { type:'object', additionalProperties:false, properties: {
              summary: { type:'string', description:'选项摘要，不超过 20 字' },
              description: { type:'string', description:'选项说明：选了会有什么结果，不超过 60 字' },
            }, required:['summary','description'] } },
        }, required:['reason','question','options'] },
        serialize: questionText,
        execute: async (args: unknown, context: { emit: SourceRuleStreamSink; signal?: AbortSignal; interactive?: boolean }) => {
          if (!args || typeof args !== 'object') throw new Error('工具参数无效')
          const raw = args as Record<string, unknown>
          if (!context.interactive) throw new Error('当前调用方式不能向用户提问，请直接给出最合理的方案，并在 explanation 里写清假设')
          const question = String(raw.question ?? '').trim().slice(0, 200)
          if (!question) throw new Error('ask_user 缺少 question')
          const options_ = asQuestionOptions(raw.options)
          spend('ask_user', SOURCE_ASK_MAX_CALLS)
          const payload: SourceAiQuestion = { id: randomUUID(), question, why: String(raw.why ?? '').trim().slice(0, 300) || undefined, options: options_ }
          await context.emit({ type: 'status', message: '等待你回答问题…' })
          await context.emit({ type: 'question', question: payload })
          const answer = await waitForAnswer(payload, id, context.signal)
          return { answer }
        },
      }, {
        name: 'submit_rules',
        description: '提交本轮成果：把自检确认过的完整规则交给用户。正文照常用 Markdown 说明你的判断和假设，规则本身只通过这个工具提交，不要写在正文里。校验不通过时会返回字段级错误，改好再提交一次。',
        final: true,
        parameters: { type:'object', additionalProperties:false, properties: {
          reason: { type:'string', description:'本次提交的依据，一句话中文，会显示给用户' },
          rules: { type:'object', additionalProperties:true, description:'完整的 SourceRules 对象，包含 media / metadata / script 等字段' },
          summary: { type:'string', description:'可选：一句话说明这次改了什么、有什么假设，会显示在结果卡片上' },
        }, required:['reason','rules'] },
        serialize: submissionText,
        execute: async (args: unknown) => {
          if (!args || typeof args !== 'object') throw new Error('工具参数无效')
          const raw = args as Record<string, unknown>
          const rules = raw.rules
          if (!rules || typeof rules !== 'object' || Array.isArray(rules)) throw new Error('缺少 rules 参数：请传入完整的 SourceRules 对象，不要用 JSON 字符串')
          // 形状和脚本都要过一遍，失败时把可读原因回给模型，让它自己改。
          validateRulesShape(rules)
          const { validateRules } = await import('./source-sandbox.js')
          try { await validateRules(rules, true) } catch (error) { throw new Error(`规则未通过校验：${(error as Error).message}`) }
          const explanation = String(raw.summary ?? '').trim().slice(0, 4000)
          await options.onEvent?.({ type: 'status', message: '模型已提交规则，正在校验并生成结果' })
          return { rules, explanation }
        },
      }],
      { ignoreCustomParams: input.ignoreCustomParams === true, thinkingLevel: asAiThinkingLevel(input.thinkingLevel), sink: options.onEvent, signal: options.signal },
    )
    const toolEvents = result.toolEvents || []
    events.push(...toolEvents)
    // 历史里只保留最终答案，工具过程不回灌，省 token；注明格式，避免模型下一轮改用别的格式回答。
    conversation.turns = [...history, user, { role:'assistant', content: `（你上一轮的最终输出，和你要给用户的最终答案同一种 JSON 格式）\n${JSON.stringify({ rules: result.rules, explanation: result.explanation })}` }]
    conversation.expires = Date.now()+30*60_000
    conversations.set(id,conversation)
    await options.onEvent?.({ type: 'done', message: '规则与脚本已生成' })
    return { ...result, conversationId:id, contextTrimmed, messages: eventMessages(events) }
  } finally { closeQuestions(id); conversation.busy=false; active-- }
}

export function forgetSourceAiConversation(id: string): void {
  const session=conversations.get(id)
  if(session?.busy) throw Object.assign(new Error('本轮仍在生成，请稍候'),{statusCode:409})
  closeQuestions(id)
  conversations.delete(id)
}
