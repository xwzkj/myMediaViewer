<script setup lang="ts">
import { ref, watch } from 'vue'
import Icon from './Icon.vue'

const dark = ref(false)
try { dark.value = localStorage.getItem('theme') === 'dark' } catch { dark.value = false }

watch(dark, value => {
  document.documentElement.dataset.theme = value ? 'dark' : 'light'
  try { localStorage.setItem('theme', value ? 'dark' : 'light') } catch { /* UI preference only. */ }
}, { immediate: true })
</script>

<template>
  <section class="settings-section">
    <div class="section-heading"><div><h3>外观</h3><p>切换媒体库与设置页的显示主题。</p></div><Icon :name="dark ? 'moon' : 'sun'" /></div>
    <div class="theme-options" role="radiogroup" aria-label="显示主题">
      <button type="button" class="theme-option" :class="{ active: !dark }" role="radio" :aria-checked="!dark" @click="dark = false"><Icon name="sun" :size="20" />浅色</button>
      <button type="button" class="theme-option" :class="{ active: dark }" role="radio" :aria-checked="dark" @click="dark = true"><Icon name="moon" :size="20" />深色</button>
    </div>
  </section>
</template>

<style scoped>
.theme-options { display: flex; gap: 10px; }
.theme-option { min-height: 42px; padding: 0 16px; display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--outline); border-radius: 12px; background: var(--surface); color: var(--text); }
.theme-option.active { border-color: var(--primary); background: var(--primary-container); color: var(--on-container); }
</style>
