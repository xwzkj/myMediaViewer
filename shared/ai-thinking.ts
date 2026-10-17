/**
 * 模型思考深度：界面上的一档到底传什么参数，统一由这里决定。
 *
 * default 是「不额外传参」，交给接口自己的默认行为；其余五档映射成
 * OpenAI 兼容接口通用的 reasoning_effort。
 */
export const AI_THINKING_LEVELS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type AiThinkingLevel = (typeof AI_THINKING_LEVELS)[number]

/** 界面默认挡位。 */
export const DEFAULT_AI_THINKING_LEVEL: AiThinkingLevel = 'high'

export const AI_THINKING_OPTIONS: ReadonlyArray<{ value: AiThinkingLevel; label: string; hint: string }> = [
  { value: 'default', label: '默认', hint: '不额外传参，使用接口自己的默认思考行为' },
  { value: 'low', label: '低', hint: 'reasoning_effort: low' },
  { value: 'medium', label: '中', hint: 'reasoning_effort: medium' },
  { value: 'high', label: '高', hint: 'reasoning_effort: high' },
  { value: 'xhigh', label: '很高', hint: 'reasoning_effort: xhigh' },
  { value: 'max', label: '最高', hint: 'reasoning_effort: max' },
]

export function isAiThinkingLevel(value: unknown): value is AiThinkingLevel {
  return typeof value === 'string' && (AI_THINKING_LEVELS as readonly string[]).includes(value)
}

export function asAiThinkingLevel(value: unknown, fallback: AiThinkingLevel = DEFAULT_AI_THINKING_LEVEL): AiThinkingLevel {
  return isAiThinkingLevel(value) ? value : fallback
}

export function aiThinkingLabel(level: AiThinkingLevel): string {
  return AI_THINKING_OPTIONS.find(option => option.value === level)?.label || level
}

/** default 挡位不产生任何请求字段；其余挡位映射成 reasoning_effort。 */
export function thinkingRequestParams(level: AiThinkingLevel): Record<string, unknown> {
  return level === 'default' ? {} : { reasoning_effort: level }
}
