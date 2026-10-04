<template>
  <section class="page" data-module="burnpermit">
    <header class="page-head">
      <div>
        <h2>焚烧审批管理</h2>
        <p class="page-desc">用火审批单按申请单位、用火类型、计划时段分级审批：申请单位只能提交/撤回自己的草稿，审批人按级别批准或驳回，已执行记录只读。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出焚烧审批清单</button>
        <button class="btn ghost" type="button" @click="resetAll">回到示例数据</button>
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

    <form v-if="store.actor.role === '申请人'" class="create-form" @submit.prevent="registerDraft">
      <label><span>用火类型</span>
        <select v-model="form.fireType">
          <option v-for="item in fireTypes" :key="item" :value="item">{{ item }}</option>
        </select>
      </label>
      <label><span>用火地点</span><input v-model="form.location" placeholder="用火地点" /></label>
      <label><span>计划时段</span><input v-model="form.window" placeholder="2026-10-20 09:00-11:00" /></label>
      <label><span>关联检查站</span>
        <select v-model="form.checkpoint">
          <option v-for="item in checkpointOptions" :key="item.code" :value="item.code">{{ item.code }}</option>
        </select>
      </label>
      <label><span>关联巡护任务</span>
        <select v-model="form.patrol">
          <option v-for="item in patrolOptions" :key="item" :value="item">{{ item }}</option>
        </select>
      </label>
      <label><span>安全措施</span><input v-model="form.measure" placeholder="安全措施" /></label>
      <button class="btn primary" type="submit">登记草稿（{{ store.actor.org }}）</button>
    </form>
    <p v-else class="page-desc">当前身份为「{{ store.actor.role }}」，只能对待审批单裁决，登记草稿请切换到申请单位身份。</p>

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
          <th>审批级别要求</th>
          <th>检查站通行核查</th>
          <th>巡护任务核查</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="isLocked(row)" class="tag tag-readonly">只读</span>
          </td>
          <td>{{ levelLabel(requiredApproveLevel(row)) }}</td>
          <td>
            <span v-if="verificationOf(row).checkpoint" class="tag" :class="verificationOf(row).checkpoint!.status === '已核查' ? 'tag-done' : 'tag-pending'">
              {{ verificationOf(row).checkpoint!.status }}
            </span>
            <span v-else>—</span>
          </td>
          <td>
            <span v-if="verificationOf(row).patrol" class="tag" :class="verificationOf(row).patrol!.status === '已核查' ? 'tag-done' : 'tag-pending'">
              {{ verificationOf(row).patrol!.status }}
            </span>
            <span v-else>—</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in allowedActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!allowedActions(row).length" class="page-desc">无可用动作</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 5" class="empty-state">暂无焚烧审批数据，可先以申请单位身份登记用火审批单草稿</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条用火审批单 · 当前身份：{{ store.operator }}（{{ authorityHint }}）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="okMessage" class="error-text" style="color:#15803d">{{ okMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  burnPermitVerifications,
  createBurnDraft,
  downloadEntries,
  listEntries,
  moduleMeta,
  resetModule,
  runAction as applyAction,
} from '@/api/local-service'
import { requiredApproveLevel, levelLabel } from '@/api/burn-flow'
import { listRows } from '@/data/local-store'
import type { BurnVerification, EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('burnpermit')
const store = useSessionStore()
const columns = ['审批编号', '申请单位', '用火类型', '用火地点', '计划时段', '关联检查站', '关联巡护任务', '安全措施', '审批人']
const statuses = ['待申请', '待审批', '已批准', '已驳回', '已执行', '已撤回']
const fireTypes = ['炼山造林', '计划烧除', '林内杂灌焚烧', '生产性用火', '生活用火']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const okMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['申请单位', '用火类型', '计划时段']

const checkpointOptions = listRows('checkpoint').map((row) => ({
  code: String(row['站点编号']),
}))
const patrolOptions = listRows('patrol').map((row) => String(row['任务编号']))

const form = reactive({
  fireType: '生产性用火',
  location: '',
  window: '',
  checkpoint: checkpointOptions[0]?.code ?? '',
  patrol: patrolOptions[0] ?? '',
  measure: '',
})

const stats = computed(() => [
  { label: '待审批申请', value: rows.value.filter((row) => row.status === '待审批').length },
  { label: '已批准用火', value: rows.value.filter((row) => row.status === '已批准' || row.status === '已执行').length },
  { label: '驳回申请', value: rows.value.filter((row) => row.status === '已驳回').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const authorityHint = computed(() => {
  const actor = store.actor
  if (actor.role === '申请人') {
    return `申请单位「${actor.org}」，仅能提交/撤回本单位草稿`
  }
  if (actor.role === '审批人') {
    return `${levelLabel(actor.approveLevel)}审批权限`
  }
  return actor.onDuty ? '当班值勤，可裁决历史缺审批人单据' : '休班，历史单据也无权裁决'
})

function isLocked(row: EntryRow): boolean {
  return row.status === '已执行' || row.status === '已驳回'
}

// 页面只按状态+身份做按钮可见性，真正的越权拦截在 local-service/burn-flow 里。
function allowedActions(row: EntryRow): string[] {
  const actor = store.actor
  if (isLocked(row)) {
    return []
  }
  if (actor.role === '申请人' && String(row['申请单位']) === actor.org) {
    if (row.status === '待申请') {
      return ['提交申请', '撤回草稿']
    }
    if (row.status === '待审批') {
      return ['撤回草稿']
    }
    return []
  }
  if (row.status === '待审批' && (actor.role === '审批人' || actor.role === '值勤员')) {
    return ['批准申请', '驳回答复']
  }
  return []
}

function verificationOf(row: EntryRow): {
  checkpoint: BurnVerification | null
  patrol: BurnVerification | null
} {
  return burnPermitVerifications(Number(row.id))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function registerDraft() {
  errorMessage.value = ''
  okMessage.value = ''
  const nextId = rows.value.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const result = createBurnDraft(
    {
      审批编号: `BURN-${String(nextId).padStart(4, '0')}`,
      申请单位: store.actor.org,
      用火类型: form.fireType,
      用火地点: form.location.trim(),
      计划时段: form.window.trim(),
      关联检查站: form.checkpoint,
      关联巡护任务: form.patrol,
      安全措施: form.measure.trim(),
    },
    store.actor,
  )
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  okMessage.value = result.message
  form.location = ''
  form.window = ''
  form.measure = ''
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  okMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action, store.actor)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  okMessage.value = result.message
  reload()
}

function resetAll() {
  resetModule(meta.key)
  reload()
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '焚烧审批列表读取失败'
  }
}

onMounted(reload)
</script>
