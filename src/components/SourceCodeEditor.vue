<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { basicSetup } from 'codemirror'
import { EditorState, Compartment } from '@codemirror/state'
import { indentWithTab } from '@codemirror/commands'
import { captureNames, inputCompletions } from '../source-input-completion'
import type { FileRule } from '../../shared/types'
import { EditorView, keymap } from '@codemirror/view'
import { javascript } from '@codemirror/lang-javascript'
import { StreamLanguage, syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { linter } from '@codemirror/lint'
import type { EditorIssue } from '../../shared/source-diagnostics'
const props = defineProps<{ modelValue: string; language: 'javascript' | 'template' | 'regex'; label: string; disabled?: boolean; issues: EditorIssue[]; mediaRule?: FileRule; metadataRules?: FileRule[] }>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()
const host = ref<HTMLDivElement>()
let view: EditorView | undefined
const language = new Compartment(), readOnly = new Compartment(), lint = new Compartment()
const ruleLanguage = (mode: string) => StreamLanguage.define({
  token(stream) {
    if (stream.match(/\\./)) return 'escape'
    if (mode === 'template') {
      if (stream.match(/\{[A-Za-z][A-Za-z0-9_]*\}/)) return 'variableName'
      if (stream.match(/[\[\]]/)) return 'operator'
    } else {
      if (stream.match(/\(\?<[^>]+>/)) return 'variableName'
      if (stream.match(/\[[^\]]*\]/)) return 'string'
      if (stream.match(/[()|?*+^$]|\{\d+(?:,\d*)?\}/)) return 'operator'
    }
    stream.next(); return null
  }
})
const mode = () => props.language === 'javascript' ? [javascript(), javascript().language.data.of({ autocomplete: (context: import('@codemirror/autocomplete').CompletionContext) => inputCompletions(context, captureNames(props.mediaRule ? [props.mediaRule] : []), captureNames(props.metadataRules ?? [])) })] : ruleLanguage(props.language)
const diagnostics = () => linter(() => props.issues.map(i => ({...i, severity: 'error' as const})), {delay: 150})
onMounted(() => {
  view = new EditorView({ parent: host.value, state: EditorState.create({ doc: props.modelValue, extensions: [
    basicSetup, keymap.of([indentWithTab]), EditorView.lineWrapping,
    language.of(mode()), readOnly.of([EditorState.readOnly.of(!!props.disabled), EditorView.editable.of(!props.disabled)]), lint.of(diagnostics()),
    EditorView.contentAttributes.of({'aria-label': props.label, 'aria-multiline': 'true'}),
    syntaxHighlighting(HighlightStyle.define([
      {tag: tags.keyword, color: '#ae67d4'}, {tag: tags.string, color: '#319778'}, {tag: tags.number, color: '#c3862e'},
      {tag: tags.comment, color: '#858a95'}, {tag: tags.variableName, color: '#418fc8'}, {tag: tags.operator, color: '#d26e74'},
      {tag: tags.escape, color: '#b18b32'}, {tag: tags.function(tags.variableName), color: '#3d9ca0'},
    ])),
    EditorView.theme({
      '&': {color: 'var(--text)', backgroundColor: 'var(--surface)', fontSize: '12px'},
      '.cm-content': {fontFamily: 'Consolas, monospace', minHeight: props.language === 'javascript' ? '260px' : '44px'},
      '.cm-scroller': {overflow: 'auto', maxHeight: props.language === 'javascript' ? '480px' : '160px'},
      '.cm-gutters': {backgroundColor:'var(--surface-low)', color:'var(--muted)', border:'none'},
      '.cm-activeLine, .cm-activeLineGutter': {backgroundColor:'#88888812'},
      '.cm-cursor': {borderLeftColor:'var(--text)'},
      '.cm-tooltip': {backgroundColor:'var(--surface)',color:'var(--text)',border:'1px solid var(--outline)'},
    }),
    EditorView.updateListener.of(update => { if(update.docChanged) emit('update:modelValue', update.state.doc.toString()) }),
  ]}) })
})
watch(() => props.modelValue, value => { if (view && value !== view.state.doc.toString()) view.dispatch({changes: {from:0, to:view.state.doc.length, insert:value}}) })
watch(() => props.language, () => view?.dispatch({effects:language.reconfigure(mode())}))
watch(() => props.disabled, value => view?.dispatch({effects:readOnly.reconfigure([EditorState.readOnly.of(!!value),EditorView.editable.of(!value)])}))
watch(() => props.issues, () => view?.dispatch({effects:lint.reconfigure(diagnostics())}), {deep:true})
onBeforeUnmount(() => view?.destroy())
</script>
<template><div ref="host" class="source-code-editor" :class="{ 'has-errors': issues.length }" /></template>
