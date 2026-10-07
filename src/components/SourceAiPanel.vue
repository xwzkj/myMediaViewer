<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import type { SourceRules, SourceAiSample, SourceAiResult } from '../../shared/types'
import { isBlankSourceRules } from '../../shared/source-presets'
import { api } from '../api'
const props = defineProps<{folder:string; rules:SourceRules; disabled?:boolean}>()
const emit = defineEmits<{apply:[SourceRules];busy:[boolean]}>()
const sample = ref<SourceAiSample | null>(null), conversationId=ref(''), message=ref('')
const ignoreCustomParams=ref(false)
const loading=ref(false), error=ref(''), explanation=ref(''), candidate=ref<SourceAiResult | null>(null)
const turns=ref<Array<{role:'user'|'assistant';text:string}>>([])
const sendsConfig=computed(()=>!isBlankSourceRules(props.rules))
let revision=0
function forget() {if(conversationId.value) void api(`/sources/ai/chat/${encodeURIComponent(conversationId.value)}`,{method:'DELETE'}).catch(()=>{})}
function reset() {forget();revision++;sample.value=null;conversationId.value='';turns.value=[];candidate.value=null;explanation.value='';error.value=''}
watch(()=>props.folder,reset)
onBeforeUnmount(()=>{revision++;forget()})
async function readSample() {
  if(!props.folder || loading.value)return
  reset();loading.value=true;emit('busy',true);const version=revision
  try {const result=await api<SourceAiSample>('/sources/ai/sample',{method:'POST',body:JSON.stringify({path:props.folder})});if(version===revision)sample.value=result}
  catch(e){if(version===revision)error.value=(e as Error).message}
  finally{loading.value=false;emit('busy',false)}
}
async function send() {
  if(!sample.value || !message.value.trim() || loading.value)return
  const request=message.value.trim(), version=revision
  loading.value=true;error.value='';emit('busy',true)
  try {
    const result=await api<SourceAiResult>('/sources/ai/chat',{method:'POST',body:JSON.stringify({sampleToken:sample.value.token,conversationId:conversationId.value || undefined,message:request,ignoreCustomParams:ignoreCustomParams.value,...(sendsConfig.value?{currentRules:props.rules}:{})})})
    if(version!==revision) {void api(`/sources/ai/chat/${encodeURIComponent(result.conversationId)}`,{method:'DELETE'}).catch(()=>{});return}
    conversationId.value=result.conversationId;candidate.value=result
    turns.value.push({role:'user',text:request},{role:'assistant',text:result.explanation || '已生成完整规则与脚本。'})
    if(turns.value.length>16)turns.value.splice(0,turns.value.length-16)
    explanation.value=result.contextTrimmed?'较早轮次已从 AI 上下文中移除，保留近期对话。':''
    message.value=''
  }catch(e){if(version===revision)error.value=(e as Error).message}
  finally{loading.value=false;emit('busy',false)}
}
function apply(){if(candidate.value){emit('apply',JSON.parse(JSON.stringify(candidate.value.rules)));explanation.value='已应用到编辑器；尚未保存，请预览确认。'}}
</script>
<template>
  <details class="source-ai-panel">
    <summary>AI 生成 / 修改规则与脚本</summary>
    <p>复用已保存的 AI 接口、模型、Token、超时、自定义参数和输出模式。先读取目录树，确认后点击发送；会向该 AI 服务发送下面的文件/目录名、你的要求、近期对话{{sendsConfig ? '以及当前编辑配置' : '（空白预设不发送配置）'}}。不会发送文件内容、来源绝对路径或密钥到提示词。</p>
    <div class="rule-row"><button type="button" class="button tonal small" :disabled="disabled || loading || !folder" @click="readSample">{{sample?'重新读取目录树并新建对话':'读取目录树样本'}}</button><button v-if="sample" type="button" class="button text small" :disabled="disabled || loading" @click="reset">清空对话</button></div>
    <details v-if="sample" class="ai-tree" open><summary>将发送的目录树 · {{sample.lines}} 行{{sample.truncated?' · 已截断':''}}</summary><pre>{{sample.tree}}</pre></details>
    <p class="helper">最多 200 行 / 24 KiB / 8 层；超出部分用 … 表示。对话仅保存在内存，关闭编辑器或清空后丢弃；服务端闲置 30 分钟过期。不会自动保存或执行 AI 生成的脚本。</p>
    <div v-if="turns.length" class="ai-conversation" role="log" aria-label="规则生成对话"><div v-for="(turn,index) in turns" :key="index" :class="turn.role"><strong>{{turn.role==='user'?'你':'AI'}}</strong><p>{{turn.text}}</p></div></div>
    <label class="rule-row"><input v-model="ignoreCustomParams" type="checkbox" :disabled="disabled || loading" />不使用自定义参数</label>
    <p class="helper">勾选后，本面板的 AI 请求不附加设置中的自定义参数（如 temperature、thinking）；接口、模型、Token、超时和输出模式仍使用原设置。不修改全局 AI 配置。</p>
    <label class="field">生成要求 / 后续修改<textarea v-model="message" aria-label="AI 规则生成要求" rows="3" maxlength="4000" :disabled="disabled || loading" placeholder="例如：按作品 ID 分组，文件名含作者和标题，元文件可能只有 ID；脚本优先读取 JSON，缺字段时从文件名补齐。" /></label>
    <button type="button" class="button filled small" :disabled="disabled || loading || !sample || !message.trim()" @click="send">{{loading?'正在处理…':conversationId?'发送后续修改':'发送并生成'}}</button>
    <p v-if="error" class="editor-error" role="alert">{{error}}</p><p v-if="explanation" class="helper">{{explanation}}</p>
    <details v-if="candidate" class="ai-candidate"><summary>生成结果（{{candidate.model}}）· 尚未自动应用</summary><pre>{{JSON.stringify({...candidate.rules,script:undefined},null,2)}}</pre><pre>{{candidate.rules.script}}</pre></details>
    <button v-if="candidate" type="button" class="button tonal small" :disabled="disabled || loading" @click="apply">应用生成结果到编辑器</button>
  </details>
</template>
<style scoped>
.source-ai-panel {border:1px solid var(--outline);border-radius:12px;background:var(--surface);padding:16px;font-size:12px;line-height:1.8;min-width:0;}
.source-ai-panel>summary {font-weight:600;color:var(--primary);cursor:pointer;}
.source-ai-panel p {margin:10px 0;overflow-wrap:anywhere;}
.source-ai-panel pre {max-height:280px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--surface-low);padding:10px;font:12px/1.7 Consolas,monospace;border-radius:8px;}
.source-ai-panel details {margin:12px 0;}
.source-ai-panel textarea {width:100%;box-sizing:border-box;resize:vertical;}
.ai-conversation {max-height:320px;overflow:auto;margin:12px 0;}
.ai-conversation>div {padding:8px 12px;border-radius:8px;margin:8px 0;background:var(--surface-low);white-space:pre-wrap;}
.ai-conversation .user {border-left:3px solid var(--primary);}
</style>
