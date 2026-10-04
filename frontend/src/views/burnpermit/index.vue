<template>
  <section class="page" data-module="burnpermit">
    <header class="page-head">
      <div>
        <h2>焚烧审批管理</h2>
        <p class="page-desc">按申请单位、用火类型与计划时段分级裁决：申请单位管草稿，审批人分级批准/驳回，批准后检查站与巡护各生成一条执行核查。</p>
      </div>
      <div class="page-actions">
        <button
          v-if="store.identity.role === 'applicant'"
          class="btn primary"
          type="button"
          @click="showForm = !showForm"
        >
          登记用火审批单
        </button>
        <button class="btn" type="button" @click="exportRows">导出焚烧审批清单</button>
      </div>
    </header>

    <IdentityBar />

    <form v-if="showForm && store.identity.role === 'applicant'" class="create-card" @submit.prevent="submitDraft">
      <label class="create-item">
        <span>申请单位</span>
        <input v-model="draftForm.unit" readonly />
      </label>
      <label class="create-item">
        <span>用火类型</span>
        <select v-model="draftForm.fireType">
          <option value="林缘杂物焚烧">林缘杂物焚烧</option>
          <option value="林缘农田秸秆焚烧">林缘农田秸秆焚烧</option>
          <option value="烧除隔离带可燃物">烧除隔离带可燃物</option>
          <option value="计划烧除">计划烧除（高危·三级）</option>
          <option value="烧荒烧炭">烧荒烧炭（高危·三级）</option>
          <option value="炼山造林">炼山造林（高危·三级）</option>
        </select>
      </label>
      <label class="create-item">
        <span>用火地点</span>
        <input v-model="draftForm.location" placeholder="具体用火地点" />
      </label>
      <label class="create-item">
        <span>计划时段</span>
        <input v-model="draftForm.period" placeholder="2026-10-10 至 2026-10-11" />
      </label>
      <label class="create-item wide">
        <span>安全措施</span>
        <input v-model="draftForm.safety" placeholder="隔离带、灭火机具、看守人员等" />
      </label>
      <label class="create-item">
        <span>现场检查</span>
        <select v-model="draftForm.siteCheck">
          <option value="待核查">待核查</option>
          <option value="通过">通过</option>
          <option value="未通过">未通过</option>
        </select>
      </label>
      <div class="create-actions">
        <button class="btn primary" type="submit">保存草稿</button>
        <button class="btn ghost" type="button" @click="showForm = false">取消</button>
      </div>
    </form>

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
          <th>审批级别</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ readonly: row.status === '已执行' }">
          <td v-for="column in columns" :key="column">{{ row[column] === '' ? '（按班次补位）' : (row[column] ?? '—') }}</td>
          <td>{{ levelNames[requiredLevel(row)] }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-for="action in actionsFor(row)" :key="action">
              <button class="link" type="button" @click="runAction(action, row)">{{ action }}</button>
            </template>
            <span v-if="row.status === '已执行'" class="muted-text">只读</span>
            <span v-else-if="!actionsFor(row).length" class="muted-text">无权限</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无焚烧审批数据，申请单位可先登记草稿</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条焚烧审批记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <FirePassageList />
    <PatrolCheckList />
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { createDraft, chainEventName } from '@/domain/workflow'
import { availableActions, requiredLevel, PERMIT_STATUS } from '@/domain/rules'
import { LEVEL_NAMES } from '@/domain/identity'
import { useSessionStore } from '@/stores/session'
import IdentityBar from '@/components/IdentityBar.vue'
import FirePassageList from '@/components/FirePassageList.vue'
import PatrolCheckList from '@/components/PatrolCheckList.vue'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('burnpermit')
const store = useSessionStore()
const columns = ["审批编号", "申请单位", "用火类型", "用火地点", "计划时段", "安全措施", "现场检查", "审批人"]
const statuses = ["待申请", "待审批", "已批准", "已驳回", "已执行"]
const levelNames = LEVEL_NAMES

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const showForm = ref(false)
const filters = ref<Record<string, string>>({})
// 分级权限的三个维度都要能筛。
const filterFields = ["申请单位", "用火类型", "计划时段"]
const draftForm = reactive({
  unit: store.identity.unit,
  fireType: '林缘杂物焚烧',
  location: '',
  period: '',
  safety: '',
  siteCheck: '待核查',
})

const stats = computed(() => [
  { label: '待审批申请', value: rows.value.filter((row) => row.status === PERMIT_STATUS.pending).length },
  { label: '已批准用火', value: rows.value.filter((row) => row.status === PERMIT_STATUS.approved).length },
  { label: '驳回申请', value: rows.value.filter((row) => row.status === PERMIT_STATUS.rejected).length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function actionsFor(row: EntryRow): string[] {
  return availableActions(row, store.identity)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function submitDraft() {
  errorMessage.value = ''
  const result = createDraft({ ...draftForm })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  showForm.value = false
  draftForm.location = ''
  draftForm.period = ''
  draftForm.safety = ''
  draftForm.siteCheck = '待核查'
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    draftForm.unit = store.identity.unit
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '焚烧审批列表读取失败'
  }
}

function onChainChange() {
  reload()
}

onMounted(() => {
  reload()
  window.addEventListener(chainEventName(), onChainChange)
})
onBeforeUnmount(() => window.removeEventListener(chainEventName(), onChainChange))
</script>

<style scoped>
.create-card {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
}
.create-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
.create-item.wide {
  flex: 1;
  min-width: 240px;
}
.create-item input,
.create-item select {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  min-width: 160px;
}
.create-actions {
  display: flex;
  gap: 8px;
}
.readonly {
  background: #f8fafc;
}
.muted-text {
  color: var(--muted);
  font-size: 12px;
}
</style>
