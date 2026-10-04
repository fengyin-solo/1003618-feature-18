<template>
  <section class="sub-panel">
    <h3 class="sub-title">巡护核查清单（用火现场巡护任务）</h3>
    <p class="sub-desc">批准后同步生成一条巡护任务；与检查站通行核查全部通过后，审批单自动转「已执行」只读。</p>
    <table class="data-table">
      <thead>
        <tr>
          <th>任务编号</th>
          <th>关联审批单</th>
          <th>巡护区域</th>
          <th>巡护日期</th>
          <th>巡护时段</th>
          <th>审批执行状态</th>
          <th>巡护核查</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>{{ row['任务编号'] }}</td>
          <td>{{ row['审批编号'] }}</td>
          <td>{{ row['巡护区域'] }}</td>
          <td>{{ row['巡护日期'] }}</td>
          <td>{{ row['巡护时段'] }}</td>
          <td>{{ permitStatus(row) }}</td>
          <td>{{ row['核查状态'] }}</td>
          <td class="row-actions">
            <button
              v-if="row['核查状态'] !== passed"
              class="link"
              type="button"
              @click="confirm(row)"
            >
              核查通过
            </button>
            <span v-else class="muted-text">已闭环</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="8" class="empty-state">暂无用火巡护核查任务，批准用火审批单后自动生成</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

import { listRows } from '@/data/local-store'
import { runAction } from '@/api/local-service'
import { chainEventName, CHECK_VERIFY } from '@/domain/workflow'
import type { EntryRow } from '@/data/types'

const rows = ref<EntryRow[]>([])
const passed = CHECK_VERIFY.passed

function permitStatus(row: EntryRow): string {
  const permitId = Number(row['来源审批单'] ?? 0)
  const permit = listRows('burnpermit').find((item) => Number(item.id) === permitId)
  return permit ? String(permit.status) : '—'
}

function load() {
  rows.value = listRows('patrol').filter((row) => row['来源审批单'])
}

function confirm(row: EntryRow) {
  runAction('patrol', Number(row.id), '核查通过')
  load()
}

function onChange() {
  load()
}

onMounted(() => {
  load()
  window.addEventListener(chainEventName(), onChange)
})
onBeforeUnmount(() => window.removeEventListener(chainEventName(), onChange))
</script>

<style scoped>
.sub-panel {
  margin-top: 18px;
}
.sub-title {
  font-size: 15px;
  margin: 0 0 4px;
}
.sub-desc {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--muted);
}
.muted-text {
  color: var(--muted);
  font-size: 12px;
}
</style>
