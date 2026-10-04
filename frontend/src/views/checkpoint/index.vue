<template>
  <section class="page" data-module="checkpoint">
    <header class="page-head">
      <div>
        <h2>防火检查站管理</h2>
        <p class="page-desc">维护防火检查站，围绕站点编号、站点位置、值守人员、检查项目做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记防火检查站</button>
        <button class="btn" type="button" @click="exportRows">导出防火检查站清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无防火检查站数据，可先登记防火检查站</td>
        </tr>
      </tbody>
    </table>

    <div class="sub-panel">
      <h3>检查站通行清单（用火批准后自动下发，与焚烧审批、巡护任务实时同步执行状态）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>审批编号</th><th>关联站点</th><th>用火地点</th><th>计划时段</th><th>用火类型</th><th>申请单位</th><th>执行状态</th><th>核查时间</th><th>核查人</th><th>核查结果</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in verifications" :key="item.key">
            <td>{{ item.permitNo }}</td>
            <td>{{ item.refCode }}</td>
            <td>{{ item.fireLocation }}</td>
            <td>{{ item.plannedWindow }}</td>
            <td>{{ item.fireType }}</td>
            <td>{{ item.org }}</td>
            <td>
              <span class="tag" :class="item.status === '已核查' ? 'tag-done' : 'tag-pending'">{{ item.status }}</span>
            </td>
            <td>{{ item.checkedAt || '—' }}</td>
            <td>{{ item.checkedBy || '—' }}</td>
            <td>{{ item.resultNote || '待现场核验通行车辆与火种' }}</td>
            <td>
              <button
                v-if="item.status === '待核查' && canCheck"
                class="link"
                type="button"
                @click="finish(item.key)"
              >完成核查</button>
              <span v-else-if="item.status === '待核查'" class="page-desc">仅当班审批人/值勤员可核查</span>
              <span v-else class="page-desc">已闭环</span>
            </td>
          </tr>
          <tr v-if="!verifications.length">
            <td colspan="11" class="empty-state">暂无通行核查任务，用火审批单批准后会自动下发到这里</td>
          </tr>
        </tbody>
      </table>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条防火检查站记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  burnChecklist,
  downloadEntries,
  finishBurnVerification,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { BurnVerification, EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('checkpoint')
const store = useSessionStore()
const columns = ["站点编号", "站点位置", "值守人员", "检查项目", "通行车辆数", "收缴火种数", "值班日期", "运行状态"]
const actions = ["升级检查", "关闭站点", "安排换岗"]
const statuses = ["正常检查", "临时关闭", "升级检查", "等待换岗"]
const stats = [{"label": "站点总数", "value": 0}, {"label": "正常检查数", "value": 0}, {"label": "收缴火种数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const verifications = ref<BurnVerification[]>([])

const canCheck = computed(
  () => store.actor.onDuty && (store.actor.role === '审批人' || store.actor.role === '值勤员'),
)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '防火检查站登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action, store.actor)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function finish(key: string) {
  errorMessage.value = ''
  const result = finishBurnVerification(key, store.actor, '通行车辆与火种登记核验通过')
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    verifications.value = burnChecklist('checkpoint')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '防火检查站列表读取失败'
  }
}

onMounted(reload)
</script>
