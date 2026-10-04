import { defineStore } from 'pinia'

import type { SessionActor } from '@/data/types'

// 演示用身份预设：用火审批按角色 + 审批级别 + 申请单位 + 值勤班次鉴权，切换身份即可看到越权拦截。
export type ActorPreset = SessionActor & { label: string }

export const ACTOR_PRESETS: ActorPreset[] = [
  {
    label: '申请人·李明（北山林场）',
    operator: '李明',
    role: '申请人',
    org: '北山林场',
    approveLevel: 0,
    shiftLabel: '白班 08:00-20:00',
    onDuty: true,
  },
  {
    label: '申请人·王华（南坡林场）',
    operator: '王华',
    role: '申请人',
    org: '南坡林场',
    approveLevel: 0,
    shiftLabel: '白班 08:00-20:00',
    onDuty: true,
  },
  {
    label: '林场审批·赵审批（1级：北山/青山）',
    operator: '赵审批',
    role: '审批人',
    org: '防火审批组',
    approveLevel: 1,
    shiftLabel: '白班 08:00-20:00',
    onDuty: true,
  },
  {
    label: '林场审批·钱审批（1级：南坡）',
    operator: '钱审批',
    role: '审批人',
    org: '防火审批组',
    approveLevel: 1,
    shiftLabel: '白班 08:00-20:00',
    onDuty: true,
  },
  {
    label: '林区审批·孙总监（2级：全林区）',
    operator: '孙总监',
    role: '审批人',
    org: '防火指挥部',
    approveLevel: 2,
    shiftLabel: '白班 08:00-20:00',
    onDuty: true,
  },
  {
    label: '当班值勤·周值勤（白班检查站）',
    operator: '周值勤',
    role: '值勤员',
    org: '防火检查站',
    approveLevel: 0,
    shiftLabel: '白班 08:00-20:00',
    onDuty: true,
  },
  {
    label: '休班值勤·吴休班（夜班，当前不当班）',
    operator: '吴休班',
    role: '值勤员',
    org: '防火检查站',
    approveLevel: 0,
    shiftLabel: '夜班 20:00-08:00',
    onDuty: false,
  },
]

export const useSessionStore = defineStore('session', {
  state: () => ({
    presetIndex: 2,
  }),
  getters: {
    actor(state): SessionActor {
      const { label: _label, ...actor } = ACTOR_PRESETS[state.presetIndex]!
      return actor
    },
    operator(): string {
      return this.actor.operator
    },
    shiftLabel(): string {
      return this.actor.shiftLabel
    },
    canOperate(): boolean {
      return this.actor.operator.length > 0
    },
  },
  actions: {
    usePreset(index: number) {
      this.presetIndex = index
    },
  },
})
