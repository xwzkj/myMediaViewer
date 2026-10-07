import { randomUUID } from 'node:crypto'
import { generateSourceRules } from './ai.js'
import { getSourceTreeSample } from './source-tree.js'
import { isBlankSourceRules } from '../shared/source-presets.js'
import type { SourceRules, SourceAiResult } from '../shared/types.js'

type Turn = {role:'user'|'assistant';content:string}
type Conversation = {tree:string; sampleToken:string; turns:Turn[]; expires:number; busy:boolean}
const conversations = new Map<string,Conversation>()
let active = 0
export interface SourceAiTurn { sampleToken: string; conversationId?: string; message: string; currentRules?: SourceRules; ignoreCustomParams?: boolean }
export async function sourceAiTurn(input: SourceAiTurn): Promise<SourceAiResult> {
  for(const [key,value] of conversations) if(value.expires < Date.now() && !value.busy) conversations.delete(key)
  if(active >= 2) throw Object.assign(new Error('AI 生成任务繁忙，请稍后重试'),{statusCode:429})
  if (!input.message.trim()) throw Object.assign(new Error('请输入生成或修改要求'),{statusCode:400})
  const id = input.conversationId || randomUUID()
  let conversation = conversations.get(id)
  if (input.conversationId && !conversation) throw Object.assign(new Error('对话已过期，请新建对话'),{statusCode:410})
  if (conversation && conversation.sampleToken !== input.sampleToken) throw Object.assign(new Error('目录树样本已改变，请新建对话'),{statusCode:409})
  if (conversation?.busy) throw Object.assign(new Error('本轮仍在生成，请稍候'),{statusCode:409})
  if (!conversation) {
    const sample = getSourceTreeSample(input.sampleToken)
    if(conversations.size >= 8) {
      const oldest = [...conversations].find(([,v])=>!v.busy)
      if(oldest) conversations.delete(oldest[0])
    }
    conversation = {tree:sample.tree,sampleToken:sample.token,turns:[],expires:Date.now()+30*60_000,busy:false}
  }
  let currentRules = input.currentRules
  // Drafts may intentionally have syntax errors the user wants the AI to repair.
  // Only detect the blank preset, without executing/validating the supplied draft.
  if(currentRules) {try {if(isBlankSourceRules(currentRules)) currentRules = undefined} catch {/* malformed drafts stay descriptive data */}}
  const user:Turn = {role:'user',content:JSON.stringify({request:input.message,...(currentRules ? {currentRules} : {})})}
  if(Buffer.byteLength(user.content)>192*1024) throw Object.assign(new Error('当前配置过大，请缩短脚本后重试'),{statusCode:413})
  const history = [...conversation.turns]
  let contextTrimmed = false
  while(history.length > 12 || Buffer.byteLength(JSON.stringify([...history,user])) > 384*1024) {
    if(!history.length) break
    history.splice(0,2);contextTrimmed=true
  }
  conversation.busy = true; conversations.set(id,conversation); active++
  try {
    const result = await generateSourceRules(conversation.tree,[...history,user],input.ignoreCustomParams === true)
    conversation.turns = [...history,user,{role:'assistant',content:JSON.stringify(result)}]
    conversation.expires = Date.now()+30*60_000
    conversations.set(id,conversation)
    return {...result,conversationId:id,contextTrimmed}
  } finally {conversation.busy=false;active--}
}
export function forgetSourceAiConversation(id: string): void {
  const session=conversations.get(id)
  if(session?.busy) throw Object.assign(new Error('本轮仍在生成，请稍候'),{statusCode:409})
  conversations.delete(id)
}
