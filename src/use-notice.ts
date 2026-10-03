import { onScopeDispose, shallowRef } from 'vue'

export interface NoticeAction {
  label: string
  handler: () => void
}

export interface Notice {
  message: string
  action?: NoticeAction
  tone: 'info' | 'error'
}

export function useNotice() {
  const toast = shallowRef<Notice | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined

  function dismiss() {
    clearTimeout(timer)
    timer = undefined
    toast.value = null
  }

  function notice(message: string, action?: NoticeAction, tone: Notice['tone'] = 'info') {
    dismiss()
    toast.value = { message, action, tone }
    timer = setTimeout(dismiss, action ? 8000 : 4200)
  }

  function runAction() {
    const action = toast.value?.action
    dismiss()
    action?.handler()
  }

  onScopeDispose(dismiss)
  return { toast, notice, dismiss, runAction }
}
