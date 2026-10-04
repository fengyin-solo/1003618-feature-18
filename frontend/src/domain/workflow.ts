// 用火审批状态机与执行链路：
// 待申请/已驳回 --提交申请--> 待审批 --批准申请--> 已批准（同时向防火检查站、巡护任务各下发一条执行核查）
// 待审批 --撤回草稿--> 待申请；待审批 --驳回答复--> 已驳回；两条核查都完成后 --> 已执行（只读）。
// 检查站通行清单、巡护核查清单在各入口同步同一执行状态；重复批准只生效一次（不重复下发核查）。

import { listRows, saveRows } from '../data/local-store'
import type { ActionResult, EntryRow } from '../data/types'
import { currentActor } from './identity'
import {
  PERMIT_STATUS,
  SITE_CHECK,
  adjudicateApproval,
  adjudicateAuthority,
  availableActions,
  dutyApproverFor,
} from './rules'

const PERMIT_KEY = 'burnpermit'
const CHECKPOINT_KEY = 'checkpoint'
const PATROL_KEY = 'patrol'
const CHAIN_EVENT = 'fire:chain-changed'

export const CHECK_VERIFY = {
  waiting: '待核查',
  passed: '核查通过',
} as const

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function permitIndex(rows: EntryRow[], id: number): number {
  return rows.findIndex((row) => Number(row.id) === id)
}

function isTerminal(status: string): boolean {
  return status === PERMIT_STATUS.approved || status === PERMIT_STATUS.executed
}

// 已批准/已执行单是否已下发过执行核查（重复批准幂等的依据）。
export function hasSpawnedChecks(permitId: number): boolean {
  const linked = (row: EntryRow) => Number(row['来源审批单'] ?? 0) === permitId
  return listRows(CHECKPOINT_KEY).some(linked) || listRows(PATROL_KEY).some(linked)
}

function spawnCheckpointCheck(permit: EntryRow): EntryRow {
  const rows = listRows(CHECKPOINT_KEY)
  const id = nextId(rows)
  const row: EntryRow = {
    id,
    status: '升级检查',
    pending: true,
    abnormal: false,
    '站点编号': `CHEC-A${String(id).padStart(4, '0')}`,
    '站点位置': `${permit['用火地点'] ?? ''}（用火通行核查）`,
    '值守人员': dutyApproverFor(permit) || '当班值守',
    '检查项目': `用火通行核查：${permit['用火类型'] ?? ''}`,
    '通行车辆数': 0,
    '收缴火种数': 0,
    '值班日期': String(permit['计划时段'] ?? '').split(/\s*至\s*/)[0] ?? '',
    '运行状态': '正常运行',
    // 审批链路扩展字段：检查站通行清单据此同步执行状态。
    '来源审批单': Number(permit.id),
    '审批编号': String(permit['审批编号'] ?? ''),
    '申请单位': String(permit['申请单位'] ?? ''),
    '计划时段': String(permit['计划时段'] ?? ''),
    '核查状态': CHECK_VERIFY.waiting,
  }
  saveRows(CHECKPOINT_KEY, [...rows, row])
  return row
}

function spawnPatrolCheck(permit: EntryRow): EntryRow {
  const rows = listRows(PATROL_KEY)
  const id = nextId(rows)
  const period = String(permit['计划时段'] ?? '')
  const row: EntryRow = {
    id,
    status: '待执行',
    pending: true,
    abnormal: false,
    '任务编号': `PATR-A${String(id).padStart(4, '0')}`,
    '巡护区域': String(permit['用火地点'] ?? ''),
    '巡护路线': `用火现场周边巡护：${permit['用火地点'] ?? ''}`,
    '巡护员': dutyApproverFor(permit) || '当班巡护组',
    '巡护日期': period.split(/\s*至\s*/)[0] ?? '',
    '巡护时段': period,
    '发现火情数': 0,
    '任务状态': '待执行',
    '来源审批单': Number(permit.id),
    '审批编号': String(permit['审批编号'] ?? ''),
    '核查状态': CHECK_VERIFY.waiting,
  }
  saveRows(PATROL_KEY, [...rows, row])
  return row
}

// 批准后：防火检查站通行提醒 + 巡护任务各生成一条执行核查；幂等。
function spawnExecutionChecks(permit: EntryRow): string[] {
  if (hasSpawnedChecks(Number(permit.id))) {
    return []
  }
  const checkpoint = spawnCheckpointCheck(permit)
  const patrol = spawnPatrolCheck(permit)
  return [
    `检查站通行提醒已下发（${checkpoint['站点编号']}）`,
    `巡护核查任务已生成（${patrol['任务编号']}）`,
  ]
}

// 检查站/巡护两条核查都通过后，把审批单同步为「已执行」；已执行记录全程只读。
export function syncPermitExecution(permitId: number): boolean {
  const permits = listRows(PERMIT_KEY)
  const index = permitIndex(permits, permitId)
  if (index < 0 || String(permits[index].status) !== PERMIT_STATUS.approved) {
    return false
  }
  const checkpointDone = listRows(CHECKPOINT_KEY)
    .filter((row) => Number(row['来源审批单'] ?? 0) === permitId)
    .every((row) => String(row['核查状态']) === CHECK_VERIFY.passed)
  const patrolDone = listRows(PATROL_KEY)
    .filter((row) => Number(row['来源审批单'] ?? 0) === permitId)
    .every((row) => String(row['核查状态']) === CHECK_VERIFY.passed)
  if (!checkpointDone || !patrolDone || !(hasSpawnedChecks(permitId))) {
    return false
  }
  const next = [...permits]
  next[index] = { ...permits[index], status: PERMIT_STATUS.executed, pending: false }
  saveRows(PERMIT_KEY, next)
  return true
}

function fail(message: string): ActionResult {
  return { ok: false, message }
}

function persist(rows: EntryRow[], index: number, updated: EntryRow): void {
  const next = [...rows]
  next[index] = updated
  saveRows(PERMIT_KEY, next)
}

export function permitActions(id: number): string[] {
  const rows = listRows(PERMIT_KEY)
  const row = rows.find((item) => Number(item.id) === id)
  return row ? availableActions(row, currentActor()) : []
}

// 用火审批单统一动作入口：所有越权/重复/只读操作在这里拦截。
export function runPermitAction(id: number, action: string): ActionResult {
  const actor = currentActor()
  const rows = listRows(PERMIT_KEY)
  const index = permitIndex(rows, id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的用火审批单`)
  }
  const row = rows[index]
  const status = String(row.status)

  // 已执行记录只读：任何动作一律拦截。
  if (status === PERMIT_STATUS.executed) {
    return fail('该用火审批单已执行，记录只读，不能再变更')
  }

  if (action === '提交申请') {
    const own = actor.role === 'applicant' && String(row['申请单位'] ?? '') === actor.unit
    if (!own) {
      return fail('申请单位只能提交本单位的用火审批草稿')
    }
    if (status !== PERMIT_STATUS.draft && status !== PERMIT_STATUS.rejected) {
      return fail(`当前状态「${status}」不能提交申请`)
    }
    persist(rows, index, {
      ...row,
      status: PERMIT_STATUS.pending,
      pending: true,
      abnormal: false,
    })
    return { ok: true, message: '申请已提交，进入待审批' }
  }

  if (action === '撤回草稿') {
    const own = actor.role === 'applicant' && String(row['申请单位'] ?? '') === actor.unit
    if (!own) {
      return fail('申请单位只能撤回本单位提交的用火申请')
    }
    if (status !== PERMIT_STATUS.pending) {
      return fail(`当前状态「${status}」不能撤回`)
    }
    persist(rows, index, { ...row, status: PERMIT_STATUS.draft, pending: true })
    return { ok: true, message: '申请已撤回为草稿' }
  }

  if (action === '批准申请' || action === '驳回答复') {
    if (actor.role !== 'approver') {
      return fail('当前身份是申请单位，无权审批；请切换审批人身份')
    }
    if (status !== PERMIT_STATUS.pending) {
      // 已批准/已执行再次操作：只生效一次，明确拒绝重复裁决。
      if (isTerminal(status)) {
        return fail(`该申请已「${status}」，重复操作不生效`)
      }
      return fail(`当前状态「${status}」不能${action === '批准申请' ? '批准' : '驳回'}`)
    }
    if (action === '驳回答复') {
      const authority = adjudicateAuthority(row, actor)
      if (!authority.ok) {
        return fail(authority.message)
      }
      persist(rows, index, { ...row, status: PERMIT_STATUS.rejected, pending: true, abnormal: true })
      return { ok: true, message: '申请已驳回，申请单位可修改后重新提交' }
    }
    const need = adjudicateApproval(row, actor)
    if (!need.ok) {
      return fail(need.message)
    }
    // 历史缺审批人：按值勤班次兼容补位。
    const approver = String(row['审批人'] ?? '').trim() || dutyApproverFor(row) || actor.name
    persist(rows, index, {
      ...row,
      status: PERMIT_STATUS.approved,
      pending: true,
      abnormal: false,
      '审批人': approver,
    })
    const spawned = spawnExecutionChecks({ ...row, status: PERMIT_STATUS.approved, '审批人': approver })
    window.dispatchEvent(new Event(CHAIN_EVENT))
    return {
      ok: true,
      message: spawned.length
        ? `已批准：${spawned.join('；')}`
        : '已批准（执行核查此前已下发，本次不重复生成）',
    }
  }

  return fail(`用火审批单没有登记「${action}」这个动作`)
}

// 登记新草稿：仅申请单位身份可用，草稿归属当前单位。
export function createDraft(input: {
  unit: string
  fireType: string
  location: string
  period: string
  safety: string
  siteCheck: string
}): ActionResult {
  const actor = currentActor()
  if (actor.role !== 'applicant' || input.unit !== actor.unit) {
    return fail('只有申请单位身份可以登记本单位的用火审批草稿')
  }
  if (!input.fireType || !input.location || !input.period) {
    return fail('用火类型、用火地点、计划时段为必填项')
  }
  const rows = listRows(PERMIT_KEY)
  const id = nextId(rows)
  const row: EntryRow = {
    id,
    status: PERMIT_STATUS.draft,
    pending: true,
    abnormal: false,
    '审批编号': `BURN-${String(id).padStart(4, '0')}`,
    '申请单位': input.unit,
    '用火类型': input.fireType,
    '用火地点': input.location,
    '计划时段': input.period,
    '安全措施': input.safety || '按规范配置灭火机具与看守人员',
    '审批人': '',
    '现场检查': input.siteCheck || SITE_CHECK.pending,
  }
  saveRows(PERMIT_KEY, [...rows, row])
  window.dispatchEvent(new Event(CHAIN_EVENT))
  return { ok: true, message: `草稿 ${row['审批编号']} 已登记` }
}

// 检查站通行核查通过（通行清单各入口共用，状态同步）。
export function verifyCheckpoint(id: number): ActionResult {
  const rows = listRows(CHECKPOINT_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail('没有找到该检查站通行核查记录')
  }
  const row = rows[index]
  if (!row['来源审批单']) {
    return fail('该检查站记录不属于用火审批执行核查')
  }
  if (String(row['核查状态']) === CHECK_VERIFY.passed) {
    return fail('该通行核查已通过，请勿重复操作')
  }
  const next = [...rows]
  next[index] = {
    ...row,
    status: '正常检查',
    pending: false,
    abnormal: false,
    '核查状态': CHECK_VERIFY.passed,
  }
  saveRows(CHECKPOINT_KEY, next)
  syncPermitExecution(Number(row['来源审批单']))
  window.dispatchEvent(new Event(CHAIN_EVENT))
  return { ok: true, message: '检查站通行核查已通过' }
}

// 巡护任务核查通过（巡护清单各入口共用，状态同步）。
export function verifyPatrol(id: number): ActionResult {
  const rows = listRows(PATROL_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail('没有找到该巡护核查任务')
  }
  const row = rows[index]
  if (!row['来源审批单']) {
    return fail('该巡护任务不属于用火审批执行核查')
  }
  if (String(row['核查状态']) === CHECK_VERIFY.passed) {
    return fail('该巡护核查已通过，请勿重复操作')
  }
  const next = [...rows]
  next[index] = {
    ...row,
    status: '已完成',
    pending: false,
    abnormal: false,
    '任务状态': '已完成',
    '核查状态': CHECK_VERIFY.passed,
  }
  saveRows(PATROL_KEY, next)
  syncPermitExecution(Number(row['来源审批单']))
  window.dispatchEvent(new Event(CHAIN_EVENT))
  return { ok: true, message: '巡护核查已通过' }
}

export function chainEventName(): string {
  return CHAIN_EVENT
}
