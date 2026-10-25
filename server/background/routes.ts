import type { FastifyInstance } from 'fastify'
import { createTranslationConfirmation, saveBackgroundSettings, getBackgroundStatus, controlBackground } from './service.js'
const settingsSchema = { type:'object', additionalProperties:false, properties: {
  watch:{type:'boolean'}, watchIntervalSeconds:{type:'integer',minimum:30,maximum:86400},
  semantic:{type:'boolean'}, ocr:{type:'boolean'}, autoTranslate:{type:'boolean'},
  maxPagesPerDay:{type:'integer',minimum:1,maximum:100000},
  maxTranslationRequestsPerDay:{type:'integer',minimum:1,maximum:10000},
  localDutyPercent:{type:'integer',minimum:5,maximum:100},
} } as const
export function registerBackgroundRoutes(app: FastifyInstance) {
  app.get('/api/background/status', async () => getBackgroundStatus())
  app.post<{Params:{id:string};Body:{settings:unknown}}>('/api/sources/:id/background/confirm', { schema:{ body:{type:'object',additionalProperties:false,required:['settings'],properties:{settings:settingsSchema}} } }, async request => createTranslationConfirmation(request.params.id,request.body.settings))
  app.put<{Params:{id:string};Body:{settings:unknown;confirmationToken?:string}}>('/api/sources/:id/background', {schema:{body:{type:'object',additionalProperties:false,required:['settings'],properties:{settings:settingsSchema,confirmationToken:{type:'string',maxLength:100}}}}}, async request => ({settings:saveBackgroundSettings(request.params.id,request.body.settings,request.body.confirmationToken)}))
  app.post<{Params:{id:string};Body:{action:'pause'|'stop'|'resume'|'retry'}}>('/api/sources/:id/background/control', {schema:{body:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['pause','stop','resume','retry']}}}}}, async request => {
    controlBackground(request.params.id,request.body.action)
    return getBackgroundStatus()
  })
}
