<script setup lang="ts" generic="T extends string">
import { computed, nextTick, onBeforeUnmount, onDeactivated, ref, useId, watch } from 'vue'
import Icon from './Icon.vue'

const props = defineProps<{
  modelValue: T
  options: readonly { value: NoInfer<T>; label: string; disabled?: boolean }[]
  disabled?: boolean
  compact?: boolean
  label: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: T] }>()
const id = useId()
const trigger = ref<HTMLButtonElement>()
const popup = ref<HTMLDivElement>()
const open = ref(false)
const active = ref(-1)
const selected = computed(() => props.options.find(option => option.value === props.modelValue))
const popupStyle = ref<Record<string, string>>({})
let search = '', lastSearch = 0

function close() { popup.value?.hidePopover() }
function enabled() { return props.options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0) }
function scrollActive() {
  nextTick(() => popup.value?.querySelector<HTMLElement>(`[data-index="${active.value}"]`)?.scrollIntoView({ block: 'nearest' }))
}
async function show(last = false) {
  if (!trigger.value || trigger.value.matches(':disabled') || !enabled().length) return
  active.value = props.options.findIndex(option => option.value === props.modelValue && !option.disabled)
  if (active.value < 0) active.value = last ? enabled().at(-1)! : enabled()[0]!
  popup.value?.showPopover()
  open.value = true
  await nextTick()
  const rect = trigger.value.getBoundingClientRect()
  const width = Math.min(Math.max(rect.width, popup.value?.scrollWidth || 0), window.innerWidth - 24)
  const below = window.innerHeight - rect.bottom - 20, above = rect.top - 20
  const upward = below < Math.min(popup.value?.scrollHeight || 0, 280) && above > below
  const height = Math.min(280, Math.max(0, upward ? above : below))
  popupStyle.value = {
    width: `${width}px`, maxHeight: `${height}px`,
    left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
    top: upward ? 'auto' : `${rect.bottom + 6}px`,
    bottom: upward ? `${window.innerHeight - rect.top + 6}px` : 'auto',
  }
  scrollActive()
}
function pick(index: number) {
  const option = props.options[index]
  if (!option || option.disabled || trigger.value?.matches(':disabled')) return
  emit('update:modelValue', option.value)
  close()
  trigger.value?.focus({ preventScroll: true })
}
function move(delta: number) {
  const indexes = enabled(), current = indexes.indexOf(active.value)
  active.value = indexes[(current + delta + indexes.length) % indexes.length] ?? -1
  scrollActive()
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Tab') { close(); return }
  if (event.key === 'Escape' && open.value) { event.preventDefault(); event.stopPropagation(); close(); return }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
    event.preventDefault()
    if (!open.value) { void show(event.key === 'ArrowUp' || event.key === 'End'); return }
    if (event.key === 'Enter' || event.key === ' ') pick(active.value)
    else if (event.key === 'Home' || event.key === 'End') {
      active.value = (event.key === 'Home' ? enabled()[0] : enabled().at(-1)) ?? -1
      scrollActive()
    } else move(event.key === 'ArrowDown' ? 1 : -1)
  } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault()
    if (!open.value) void show()
    const now = Date.now()
    search = now - lastSearch < 700 ? search + event.key.toLocaleLowerCase() : event.key.toLocaleLowerCase()
    lastSearch = now
    const match = props.options.findIndex(option => !option.disabled && option.label.toLocaleLowerCase().startsWith(search))
    if (match >= 0) { active.value = match; scrollActive() }
  }
}
function onScroll(event: Event) { if (!popup.value?.contains(event.target as Node)) close() }
function onToggle(event: Event) {
  open.value = (event as ToggleEvent).newState === 'open'
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', close)
  if (open.value) {
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
  }
}
watch(() => props.disabled, disabled => { if (disabled) close() })
watch(() => props.options, () => { if (open.value) close() })
onDeactivated(close)
onBeforeUnmount(() => {
  close()
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', close)
})
</script>

<template>
  <div class="app-select" :class="{ compact }">
    <button ref="trigger" type="button" class="app-select-trigger" role="combobox" aria-haspopup="listbox"
      :aria-label="label" :aria-expanded="open" :aria-controls="`${id}-list`"
      :aria-activedescendant="open && active >= 0 ? `${id}-option-${active}` : undefined"
      :disabled="disabled" @click="open ? close() : show()" @keydown="keydown" @blur="close">
      <span class="app-select-value">{{ selected?.label ?? '请选择' }}</span>
      <Icon name="down" :size="18" class="app-select-arrow" :class="{ expanded: open }" />
    </button>
    <!-- Popover enters the top layer, including inside modal source editors, without clipping. -->
    <div :id="`${id}-list`" ref="popup" popover="auto" class="app-select-popup" role="listbox"
      :aria-label="label" :style="popupStyle" @toggle="onToggle" @mousedown.prevent>
      <button v-for="(option, index) in options" :id="`${id}-option-${index}`" :key="option.value"
        type="button" role="option" tabindex="-1" class="app-select-option" :data-index="index"
        :class="{ highlighted: index === active, selected: option.value === modelValue }"
        :aria-selected="option.value === modelValue" :disabled="option.disabled"
        @pointermove="!option.disabled && (active = index)" @click="pick(index)">
        <span>{{ option.label }}</span><Icon v-if="option.value === modelValue" name="check" :size="17" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.app-select { min-width: 0; width: 100%; }
.app-select-trigger { display: flex; align-items: center; justify-content: space-between; gap: 14px; width: 100%; min-height: 46px; padding: 10px 14px; border: 1px solid var(--outline); border-radius: 10px; background: var(--surface); color: var(--text); font-size: 12px; line-height: 1.6; text-align: left; transition: border-color .16s, background .16s; }
.app-select-trigger:not(:disabled):hover { border-color: var(--primary); background: var(--surface-high); }
.app-select-trigger[aria-expanded=true] { border-color: var(--primary); }
.app-select-trigger:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
.app-select-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.app-select-arrow { color: var(--muted); transition: transform .16s; }
.app-select-arrow.expanded { transform: rotate(180deg); }
.compact .app-select-trigger { min-height: 36px; padding: 6px 10px; gap: 8px; }
.app-select-popup { position: fixed; inset: auto; margin: 0; padding: 6px; min-width: 0; max-width: calc(100vw - 24px); overflow-y: auto; overscroll-behavior: contain; border: 1px solid var(--outline); border-radius: 13px; background: var(--card); color: var(--text); box-shadow: 0 12px 36px #0003; }
.app-select-popup::backdrop { background: transparent; }
.app-select-option { display: flex; align-items: center; justify-content: space-between; gap: 14px; width: 100%; min-height: 38px; padding: 9px 11px; border-radius: 8px; background: transparent; text-align: left; font-size: 12px; line-height: 1.6; }
.app-select-option span { overflow-wrap: anywhere; }
.app-select-option.highlighted { background: var(--surface-high); }
.app-select-option.selected { color: var(--primary); font-weight: 600; }
.app-select-option.selected.highlighted { background: var(--primary-container); color: var(--on-container); }
</style>
