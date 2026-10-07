<script setup lang="ts">
import { ref, onBeforeMount, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
const props = defineProps<{ title: string; busy?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()
let previousOverflow = '', returnFocus: HTMLElement | null = null
function close() { if (!props.busy) dialog.value?.close() }
onBeforeMount(() => { returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null })
onMounted(() => {
  previousOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  dialog.value?.showModal()
})
onBeforeUnmount(() => {
  dialog.value?.close()
  document.body.style.overflow = previousOverflow
  if (returnFocus?.isConnected) returnFocus.focus()
})
</script>
<template>
  <Teleport to="body">
    <dialog ref="dialog" class="source-editor-dialog" aria-labelledby="source-editor-title" @close="emit('close')" @cancel.prevent="close">
      <header class="source-editor-heading"><div><h2 id="source-editor-title">{{title}}</h2><p>配置分组规则、元信息脚本，并预览真实文件。</p></div><button type="button" class="icon-button" :disabled="busy" aria-label="关闭来源编辑" @click="close"><Icon name="close" /></button></header>
      <slot />
    </dialog>
  </Teleport>
</template>
<style scoped>
.source-editor-dialog { width: min(1060px, calc(100vw - 48px)); max-width: none; height: min(920px, calc(100dvh - 48px)); max-height: none; padding: 0; border: 1px solid var(--outline); border-radius: 22px; background: var(--surface); color: var(--text); overflow: hidden; }
.source-editor-dialog[open] { display: flex; flex-direction: column; }
.source-editor-dialog::backdrop { background: #0008; backdrop-filter: blur(3px); }
.source-editor-heading { padding: 20px 24px; border-bottom: 1px solid var(--outline); display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-shrink: 0; }
.source-editor-heading h2 { font-size: 20px; margin: 0; }
.source-editor-heading p { font-size: 12px; color: var(--muted); margin: 6px 0 0; }
.source-editor-dialog :deep(.source-form) { margin: 0; padding: 20px 24px 0; overflow-y: auto; min-height: 0; border: none; border-radius: 0; background: var(--surface); }
.source-editor-dialog :deep(.form-actions) { position: sticky; bottom: 0; padding: 16px 0; border-top: 1px solid var(--outline); background: var(--surface); z-index: 5; margin-top: 18px; }
@media(max-width: 600px) { .source-editor-dialog { width: calc(100vw - 16px); height: calc(100dvh - 16px); border-radius: 14px; } .source-editor-heading { padding: 14px; } .source-editor-dialog :deep(.source-form) { padding: 14px 12px 0; } }
</style>
