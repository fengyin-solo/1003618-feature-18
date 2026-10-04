import { defineStore } from 'pinia'

import { IDENTITY_PRESETS, LEVEL_NAMES, type Actor } from '@/domain/identity'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: IDENTITY_PRESETS[2].name,
    shiftLabel: IDENTITY_PRESETS[2].shift,
    scope: '森林防火巡护管理系统',
    identityIndex: 2,
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    identity(): Actor {
      return IDENTITY_PRESETS[this.identityIndex] ?? IDENTITY_PRESETS[0]
    },
    identitySummary(): string {
      const actor = this.identity as Actor
      const role = actor.role === 'approver' ? LEVEL_NAMES[actor.level] : '申请单位'
      return `${actor.name}（${actor.unit} · ${role}）`
    },
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    useIdentity(index: number) {
      const actor = IDENTITY_PRESETS[index]
      if (!actor) {
        return
      }
      this.identityIndex = index
      this.operator = actor.name
      this.shiftLabel = actor.shift
    },
  },
})
