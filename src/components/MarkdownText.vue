<script setup lang="ts">
import { computed } from 'vue'
import MarkdownIt from 'markdown-it'

const props = defineProps<{ text: string }>()

// 安全策略：不解析原始 HTML（html:false 会把标签转义成文本），链接只允许 http/https/mailto，
// 其余协议直接去掉 href；图片一律不渲染，只显示替代文字。渲染器只可能吐出自己生成的标签。
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false })

const SAFE_LINK = /^(?:https?:|mailto:)/i
const renderLinkOpen = markdown.renderer.rules.link_open || ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options))
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index]
  const href = String(token.attrGet('href') ?? '').trim()
  if (SAFE_LINK.test(href)) {
    token.attrSet('href', href)
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noopener noreferrer nofollow')
  } else {
    // 去掉 href 后 <a> 不再可点击，也不会执行 javascript: 之类的伪协议。
    token.attrs = (token.attrs || []).filter(attribute => attribute[0] !== 'href')
    token.attrJoin('class', 'md-inert-link')
  }
  return renderLinkOpen(tokens, index, options, env, self)
}

// 图片不渲染成 <img>：AI 输出的地址不受信任，只保留替代文字。
markdown.renderer.rules.image = tokens => markdown.utils.escapeHtml(tokens[0]?.content || '')

const rendered = computed(() => markdown.render(props.text || ''))
</script>

<template><div class="markdown-body" v-html="rendered" /></template>

<style scoped>
.markdown-body{min-width:0;overflow-wrap:anywhere;white-space:normal}
.markdown-body :deep(> :first-child){margin-top:0}
.markdown-body :deep(> :last-child){margin-bottom:0}
.markdown-body :deep(p){margin:6px 0}
.markdown-body :deep(h1),.markdown-body :deep(h2),.markdown-body :deep(h3),.markdown-body :deep(h4){margin:10px 0 5px;font-size:12px;font-weight:650}
.markdown-body :deep(ul),.markdown-body :deep(ol){margin:6px 0;padding-left:18px}
.markdown-body :deep(li){margin:2px 0}
.markdown-body :deep(code){background:var(--surface-high);border-radius:4px;padding:1px 4px;font:11px/1.5 Consolas,monospace}
.markdown-body :deep(pre){margin:7px 0;padding:8px 9px;border-radius:7px;background:var(--surface-high);overflow:auto;max-height:220px}
.markdown-body :deep(pre code){background:none;padding:0}
.markdown-body :deep(blockquote){margin:6px 0;padding:2px 10px;border-left:3px solid var(--outline);color:var(--muted)}
.markdown-body :deep(a){color:var(--primary)}
.markdown-body :deep(.md-inert-link){color:inherit;text-decoration:line-through dotted}
.markdown-body :deep(table){border-collapse:collapse;margin:7px 0;font-size:11px}
.markdown-body :deep(th),.markdown-body :deep(td){border:1px solid var(--outline);padding:3px 6px;text-align:left}
.markdown-body :deep(hr){border:0;border-top:1px solid var(--outline);margin:10px 0}
</style>
