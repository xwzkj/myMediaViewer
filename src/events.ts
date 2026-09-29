import mitt from 'mitt'

export interface WorkReturnPayload {
  workId: string
  returnPath: string
}

type AppEvents = {
  'work:return': WorkReturnPayload
}

export const appEvents = mitt<AppEvents>()
