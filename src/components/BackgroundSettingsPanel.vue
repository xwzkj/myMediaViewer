<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, onActivated, onDeactivated, nextTick, watch } from 'vue'
import type { Source } from '../../shared/types'
import { normalizeSourceBackground, type BackgroundStatus, type SourceBackgroundSettings } from '../../shared/background'
import { api } from '../api'
import { createStatusPoller } from '../status-poller'
const props = defineProps<{ sources: Source[] }>()
const emit = defineEmits<{ changed: []; notice: [message: string] }>()
const status = ref<BackgroundStatus | null>(null)
const drafts = ref<Record<string, SourceBackgroundSettings>>({})
const localMode = ref(false)
const busy = ref(''), error = ref('')
const confirmation = ref<{ sourceId:string; settings:SourceBackgroundSettings; token:string; warning:string } | null>(null)
const accepted = ref(false)
const costDialog = ref<HTMLElement>()
watch(() => props.sources, sources => {
  for (const source of sources) if (!drafts.value[source.id]) drafts.value[source.id] = normalizeSourceBackground(source.background)
  for (const id of Object.keys(drafts.value)) if (!sources.some(source => source.id === id)) delete drafts.value[id]
}, { immediate:true })
const poller = createStatusPoller(
  () => api<BackgroundStatus>('/background/status'),
  value => { status.value=value; localMode.value=value.localComputeMode === 'local' },
  e => { error.value=(e as Error).message }, 5000,
)
const refresh = poller.refresh
let activeEntry = false
function startPolling() { if (!activeEntry) { activeEntry=true; poller.start() } }
onMounted(startPolling)
onActivated(startPolling)
onDeactivated(() => { activeEntry=false; poller.stop(); confirmation.value=null })
onBeforeUnmount(poller.stop)
function sourceStatus(id:string) { return status.value?.sources.find(item => item.sourceId === id) }
async function persist(id:string, settings:SourceBackgroundSettings, token?:string) {
  await api(`/sources/${encodeURIComponent(id)}/background`, { method:'PUT', body:JSON.stringify({settings,confirmationToken:token}) })
  drafts.value[id] = {...settings}
  emit('changed'); emit('notice','后台设置已保存；手动翻译始终优先')
  await refresh()
}
async function save(id:string) {
  busy.value=id; error.value=''
  try {
    const settings = normalizeSourceBackground(drafts.value[id])
    const current = sourceStatus(id)
    if (settings.autoTranslate && (!current?.settings.autoTranslate || !current.translationConsentValid || settings.maxTranslationRequestsPerDay > current.settings.maxTranslationRequestsPerDay)) {
      const result = await api<{token:string;warning:string}>(`/sources/${encodeURIComponent(id)}/background/confirm`,{method:'POST',body:JSON.stringify({settings})})
      confirmation.value={sourceId:id,settings,...result}; accepted.value=false
      await nextTick()
      costDialog.value?.scrollIntoView({block:'center'})
      costDialog.value?.focus()
    } else await persist(id,settings)
  } catch (e) { error.value=(e as Error).message }
  finally { busy.value='' }
}
async function confirmPaid() {
  const pending=confirmation.value
  if (!pending || !accepted.value) return
  busy.value=pending.sourceId; error.value=''
  try { await persist(pending.sourceId,pending.settings,pending.token); confirmation.value=null }
  catch(e) { error.value=(e as Error).message }
  finally { busy.value='' }
}
async function control(id:string, action:'pause'|'stop'|'resume'|'retry') {
  busy.value=id; error.value=''
  try { status.value=await api<BackgroundStatus>(`/sources/${encodeURIComponent(id)}/background/control`,{method:'POST',body:JSON.stringify({action})}) }
  catch(e) { error.value=(e as Error).message }
  finally { busy.value='' }
}
</script>
<template>
  <section class="settings-section background-settings">
    <div class="section-heading"><div><h3>后台索引与漫画预热</h3><p>所有功能默认关闭，按媒体来源启用。手动翻译优先；暂停和停止在当前计算检查点生效，不重复计费重试。</p></div></div>
    <p class="helper">CLIP 以文搜图需要单独安装匹配的模型和分词器；缺少模型时明确提示，不生成虚假结果。OCR 预热只缓存识别与透明擦字层，不调用收费翻译接口，也不修改原图。</p>
    <p v-if="!sources.length" class="helper">先添加媒体来源，再启用需要的后台功能。</p>
    <details v-for="source in sources" :key="source.id" class="background-source">
      <summary>{{ source.name }} <small>{{ sourceStatus(source.id)?.state === 'paused' ? '已暂停' : sourceStatus(source.id)?.state === 'stopped' ? '已停止' : '可运行' }} · 待处理 {{ sourceStatus(source.id)?.counts.queued || 0 }} · 完成 {{ sourceStatus(source.id)?.counts.done || 0 }}</small></summary>
      <form v-if="drafts[source.id]" @submit.prevent="save(source.id)">
        <label class="check"><input v-model="drafts[source.id]!.watch" type="checkbox" />定时检查目录文件数量，变化后扫描并运行已启用任务</label>
        <label v-if="drafts[source.id]!.watch" class="field">检查间隔（秒）<input v-model.number="drafts[source.id]!.watchIntervalSeconds" type="number" min="30" max="86400" required /><span>不跟随符号链接；同数量的文件替换请使用手动扫描。</span></label>
        <label class="check"><input v-model="drafts[source.id]!.semantic" type="checkbox" />CLIP 以文搜图索引</label>
        <label class="check"><input v-model="drafts[source.id]!.ocr" type="checkbox" />漫画 OCR / 擦字覆盖层预热（不收费翻译）</label>
        <label class="check"><input v-model="drafts[source.id]!.autoTranslate" type="checkbox" />预热后自动翻译（可能收费，保存时二次确认）</label>
        <div class="budget-fields">
          <label class="field">每日后台计算项上限<input v-model.number="drafts[source.id]!.maxPagesPerDay" type="number" min="1" max="100000" required /></label>
          <label v-if="drafts[source.id]!.autoTranslate" class="field">每日翻译请求上限<input v-model.number="drafts[source.id]!.maxTranslationRequestsPerDay" type="number" min="1" max="10000" required /></label>
          <label v-if="localMode" class="field">本地后台占空比（%）<input v-model.number="drafts[source.id]!.localDutyPercent" type="number" min="5" max="100" required /><span>通过任务间休息降低平均负载，并非 CPU 使用率硬上限。E3 等低配主机建议 25%。</span></label>
        </div>
        <p v-if="status?.active?.sourceId === source.id" class="helper" role="status">正在处理：{{ status.active.kind === 'semantic' ? 'CLIP 索引' : status.active.kind === 'translate' ? '自动翻译' : 'OCR 预热' }}</p>
        <p class="helper">今日已尝试 {{ sourceStatus(source.id)?.pagesToday || 0 }} 项计算 / {{ sourceStatus(source.id)?.translationRequestsToday || 0 }} 次翻译请求。按 UTC 日期重置；请求上限不等于金额上限，失败调用也可能计费。</p>
        <p v-if="sourceStatus(source.id)?.settings.autoTranslate && !sourceStatus(source.id)?.translationConsentValid" class="warning">AI 配置已变更，自动翻译暂停；请重新保存并确认费用。</p>
        <p v-if="sourceStatus(source.id)?.message" class="warning" role="status">{{ sourceStatus(source.id)?.message }}</p>
        <p v-if="sourceStatus(source.id)?.lastCheckedAt" class="helper">最近监测 {{ new Date(sourceStatus(source.id)!.lastCheckedAt!).toLocaleString() }} · {{ sourceStatus(source.id)?.lastFileCount }} 个文件</p>
        <div class="background-actions">
          <button class="button filled small" :disabled="!!busy">保存后台设置</button>
          <button type="button" class="button outlined small" :disabled="!!busy" @click="control(source.id,'pause')">暂停</button>
          <button type="button" class="button outlined small" :disabled="!!busy" @click="control(source.id,'resume')">继续</button>
          <button type="button" class="button text small" :disabled="!!busy" @click="control(source.id,'stop')">停止</button>
          <button v-if="sourceStatus(source.id)?.counts.failed" type="button" class="button text small" :disabled="!!busy" @click="control(source.id,'retry')">重试失败项（可能再次计费）</button>
        </div>
      </form>
    </details>
    <div v-if="confirmation" ref="costDialog" tabindex="-1" role="alertdialog" aria-labelledby="background-cost-title" class="cost-confirm">
      <h4 id="background-cost-title">再次确认自动翻译费用 · {{ sources.find(source => source.id === confirmation!.sourceId)?.name }}</h4><p>{{ confirmation.warning }}</p>
      <label class="check"><input v-model="accepted" type="checkbox" />我理解会发送漫画文字并可能产生费用，愿意在所设预算内自动调用。</label>
      <div class="background-actions"><button class="button filled small" :disabled="!accepted || !!busy" @click="confirmPaid">确认费用并启用</button><button class="button text small" :disabled="!!busy" @click="confirmation=null">取消</button></div>
    </div>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.background-source{border:1px solid var(--outline);border-radius:12px;padding:14px;margin-top:12px}.background-source summary{cursor:pointer;font-weight:600}.background-source summary small{font-weight:400;color:var(--muted);margin-left:8px}.background-source form{margin-top:16px}.check{display:flex;align-items:center;gap:10px;margin:12px 0;font-size:13px;line-height:1.6}.check input{accent-color:var(--primary);flex-shrink:0}.budget-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-top:18px}.background-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.cost-confirm{border:2px solid var(--primary);border-radius:12px;padding:18px;margin-top:20px}.cost-confirm p,.warning{font-size:13px;line-height:1.8}.warning{color:var(--primary)}
</style>
