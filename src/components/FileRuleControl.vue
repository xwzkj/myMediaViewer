<script setup lang="ts">
import { computed } from 'vue'
import type { FileRule } from '../../shared/types'
import { ruleIssues, issueLocation } from '../../shared/source-diagnostics'
import SourceCodeEditor from './SourceCodeEditor.vue'
const props = defineProps<{ modelValue: FileRule; label: string; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [FileRule] }>()
const issues = computed(() => ruleIssues(props.modelValue))
function update(patch: Partial<FileRule>) { emit('update:modelValue', {...props.modelValue,...patch}) }
</script>
<template>
  <div class="file-rule-control">
    <div class="rule-row">
      <select :aria-label="`${label}语法`" :disabled="disabled" :value="modelValue.mode" @change="update({mode: ($event.target as HTMLSelectElement).value as FileRule['mode']})"><option value="template">占位符模板</option><option value="regex">高级正则</option></select>
      <select :aria-label="`${label}匹配对象`" :disabled="disabled" :value="modelValue.target ?? 'filename'" @change="update({target: ($event.target as HTMLSelectElement).value as FileRule['target']})"><option value="filename">文件名</option><option value="relativePath">相对路径（目录 + 文件名）</option><option value="directory">相对目录路径</option><option value="directoryName">直属目录名</option></select>
      <label><input type="checkbox" :disabled="disabled" :checked="modelValue.caseSensitive" @change="update({caseSensitive: ($event.target as HTMLInputElement).checked})" />区分大小写</label>
    </div>
    <SourceCodeEditor :model-value="modelValue.pattern" :language="modelValue.mode" :label="label" :disabled="disabled" :issues="issues" @update:model-value="update({pattern:$event})" />
    <p v-for="(issue, i) in issues" :key="i" class="editor-error" role="alert">{{ issueLocation(modelValue.pattern, issue) }}</p>
  </div>
</template>
