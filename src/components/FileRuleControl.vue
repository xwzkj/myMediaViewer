<script setup lang="ts">
import { computed } from 'vue'
import type { FileRule } from '../../shared/types'
import { ruleIssues, issueLocation } from '../../shared/source-diagnostics'
import SourceCodeEditor from './SourceCodeEditor.vue'
import AppSelect from './AppSelect.vue'
const props = defineProps<{ modelValue: FileRule; label: string; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [FileRule] }>()
const issues = computed(() => ruleIssues(props.modelValue))
function update(patch: Partial<FileRule>) { emit('update:modelValue', {...props.modelValue,...patch}) }
</script>
<template>
  <div class="file-rule-control">
    <div class="rule-row">
      <AppSelect :label="`${label}语法`" :disabled="disabled" :model-value="modelValue.mode" :options="[{ value: 'template', label: '占位符模板' }, { value: 'regex', label: '高级正则' }]" @update:model-value="update({mode: $event as FileRule['mode']})" />
      <AppSelect :label="`${label}匹配对象`" :disabled="disabled" :model-value="modelValue.target ?? 'filename'" :options="[{ value: 'filename', label: '文件名' }, { value: 'relativePath', label: '相对路径（目录 + 文件名）' }, { value: 'directory', label: '相对目录路径' }, { value: 'directoryName', label: '直属目录名' }]" @update:model-value="update({target: $event as FileRule['target']})" />
      <label><input type="checkbox" :disabled="disabled" :checked="modelValue.caseSensitive" @change="update({caseSensitive: ($event.target as HTMLInputElement).checked})" />区分大小写</label>
    </div>
    <SourceCodeEditor :model-value="modelValue.pattern" :language="modelValue.mode" :label="label" :disabled="disabled" :issues="issues" @update:model-value="update({pattern:$event})" />
    <p v-for="(issue, i) in issues" :key="i" class="editor-error" role="alert">{{ issueLocation(modelValue.pattern, issue) }}</p>
  </div>
</template>
