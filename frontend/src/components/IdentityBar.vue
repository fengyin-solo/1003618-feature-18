<template>
  <div class="identity-bar">
    <label class="identity-pick">
      <span>当前身份</span>
      <select :value="store.identityIndex" @change="onChange">
        <option v-for="(item, index) in presets" :key="item.name + item.unit" :value="index">
          {{ item.name }} · {{ item.unit }} ·
          {{ item.role === 'approver' ? levelNames[item.level] : '申请单位' }}
        </option>
      </select>
    </label>
    <p class="identity-hint">
      申请单位只能提交/撤回本单位草稿；审批人按「用火类型 + 计划时段」分级裁决，越权拦截；
      安全措施与现场检查冲突时以现场检查为准；已执行记录只读。
    </p>
  </div>
</template>

<script setup lang="ts">
import { useSessionStore } from '@/stores/session'
import { IDENTITY_PRESETS, LEVEL_NAMES } from '@/domain/identity'

const store = useSessionStore()
const presets = IDENTITY_PRESETS
const levelNames = LEVEL_NAMES

function onChange(event: Event) {
  store.useIdentity(Number((event.target as HTMLSelectElement).value))
}
</script>

<style scoped>
.identity-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  background: #eef4ff;
  border: 1px solid #c6d8fb;
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 12px;
}
.identity-pick {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  white-space: nowrap;
}
.identity-pick select {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.identity-hint {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
</style>
