import {
  BURN_APPROVED,
  BURN_DONE,
  BURN_DRAFT,
  BURN_PENDING,
  BURN_REJECTED,
  BURN_WITHDRAWN,
  allVerificationsDone,
  canSubmit,
  canWithdraw,
  checkpointConflict,
  completeVerification,
  ensureVerificationSeed,
  issueVerifications,
  resetBurnVerifications,
  resolveApprovalAuthority,
  verificationsForTarget,
  verificationsOf,
  verificationSummary,
} from '@/api/burn-flow'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  BurnVerification,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  SessionActor,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚', '撤回']

// 审批调用没显式带身份时的兜底：与值勤页默认班次一致。
const DEFAULT_ACTOR: SessionActor = {
  operator: '值班管理员',
  role: '值勤员',
  org: '防火检查站',
  approveLevel: 0,
  shiftLabel: '白班 08:00-20:00',
  onDuty: true,
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 用火审批终态：已执行/已驳回只读，已撤回的草稿不再处于审批链路。
const BURN_LOCKED_STATUSES = [BURN_DONE, BURN_REJECTED]

function findCheckpointStatus(code: string): string {
  const station = listRows('checkpoint').find(
    (row) => String(row['站点编号']) === code || String(row['站点位置']).includes(code),
  )
  return station ? String(station.status) : '正常检查'
}

/**
 * 用火审批单专用动作编排：分级权限、申请单位归属、现场检查冲突裁决、
 * 批准后下发检查站/巡护两条执行核查（幂等）都在这里，页面不做业务判断。
 */
function runBurnAction(
  id: number,
  action: string,
  actor: SessionActor,
): ActionResult & { verifications?: BurnVerification[] } {
  const rows = listRows('burnpermit')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的用火审批单` }
  }
  const row = rows[index]!

  // 已执行、已驳回为只读终态，任何动作一律拦截。
  if (BURN_LOCKED_STATUSES.includes(row.status)) {
    return { ok: false, message: `用火审批单已「${row.status}」，记录只读，不能再执行任何动作` }
  }

  const persist = (status: string, patch: Partial<EntryRow> = {}) => {
    const updated: EntryRow = {
      ...row,
      ...patch,
      status,
      pending: ![BURN_APPROVED, BURN_DONE, BURN_REJECTED, BURN_WITHDRAWN].includes(status),
      abnormal: status === BURN_REJECTED || status === BURN_WITHDRAWN,
    }
    const next = [...rows]
    next[index] = updated
    saveRows('burnpermit', next)
    return updated
  }

  if (action === '提交申请') {
    if (!canSubmit(row, actor)) {
      if (row.status !== BURN_DRAFT) {
        return { ok: false, message: `当前状态「${row.status}」不能提交，只有草稿（待申请）可提交` }
      }
      return {
        ok: false,
        message: `申请单位只能提交自己的草稿：当前身份「${actor.org}」与申请单位「${String(
          row['申请单位'],
        )}」不一致`,
      }
    }
    persist(BURN_PENDING, { 审批状态: BURN_PENDING })
    return { ok: true, message: `申请已提交，进入待审批（编号 ${String(row['审批编号'])}）` }
  }

  if (action === '撤回草稿') {
    if (!canWithdraw(row, actor)) {
      if (row.status !== BURN_DRAFT && row.status !== BURN_PENDING) {
        return { ok: false, message: `当前状态「${row.status}」不能撤回` }
      }
      return {
        ok: false,
        message: `申请单位只能撤回自己的单据：当前身份「${actor.org}」与申请单位「${String(
          row['申请单位'],
        )}」不一致`,
      }
    }
    if (row.status === BURN_DRAFT) {
      persist(BURN_WITHDRAWN, { 审批状态: BURN_WITHDRAWN })
      return { ok: true, message: '草稿已撤回作废，可重新登记' }
    }
    persist(BURN_DRAFT, { 审批状态: BURN_DRAFT })
    return { ok: true, message: '待审批申请已撤回，退回本单位草稿' }
  }

  if (action === '批准申请' || action === '驳回答复') {
    if (row.status !== BURN_PENDING) {
      return { ok: false, message: `只有「待审批」单据可裁决，当前为「${row.status}」` }
    }
    const authority = resolveApprovalAuthority(row, actor)
    if (!authority.allowed) {
      // 越权审批必须拦截。
      return { ok: false, message: authority.reason ?? '越权审批已拦截' }
    }

    if (action === '驳回答复') {
      persist(BURN_REJECTED, { 审批状态: BURN_REJECTED })
      return { ok: true, message: `用火审批单已驳回（裁决人：${actor.operator}）` }
    }

    // 安全措施与现场检查冲突：现场检查结论优先，阻断批准。
    const linkedStation = String(row['关联检查站'] ?? '')
    const conflict = checkpointConflict({
      actor,
      checkpointStatus: findCheckpointStatus(linkedStation),
    })
    if (conflict) {
      return { ok: false, message: conflict }
    }

    // 重复批准只生效一次：已经批准并下发过核查的不再重复下发。
    const updated = persist(BURN_APPROVED, { 审批状态: BURN_APPROVED })
    const { created, issued } = issueVerifications(updated)
    if (!issued) {
      return {
        ok: true,
        message: '该审批单此前已批准并下发过执行核查，重复批准未重复生效',
        verifications: verificationsOf(Number(row.id)),
      }
    }
    return {
      ok: true,
      message: `用火审批单已批准（审批人：${actor.operator}），已向检查站、巡护任务各下发 1 条执行核查`,
      verifications: created,
    }
  }

  return { ok: false, message: `用火审批单没有登记「${action}」这个动作` }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  actor: SessionActor = DEFAULT_ACTOR,
): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  if (key === 'burnpermit') {
    return runBurnAction(id, action, actor)
  }

  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/** 登记一张新用火审批单草稿：仅申请人、且申请单位必须是自己所属单位。 */
export function createBurnDraft(
  draft: Omit<EntryRow, 'id' | 'status' | 'pending' | 'abnormal'>,
  actor: SessionActor,
): ActionResult & { id?: number } {
  if (actor.role !== '申请人') {
    return { ok: false, message: '只有申请单位（申请人角色）可以登记用火审批单草稿' }
  }
  if (String(draft['申请单位']) !== actor.org) {
    return {
      ok: false,
      message: `只能为本单位登记：当前身份所属「${actor.org}」，不能替「${String(
        draft['申请单位'],
      )}」申请`,
    }
  }
  const rows = listRows('burnpermit')
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const row: EntryRow = {
    ...draft,
    id,
    status: BURN_DRAFT,
    pending: true,
    abnormal: false,
    审批人: '',
    审批状态: BURN_DRAFT,
  }
  saveRows('burnpermit', [...rows, row])
  return { ok: true, message: `草稿已登记（编号 ${String(row['审批编号'])}），可由本单位提交`, id }
}

/**
 * 检查站 / 巡护任务两个入口共用：完成一条执行核查。
 * 任一入口完成都会回写同一份核查清单，其余入口再读取时同步看到执行状态；
 * 两条核查都完成后，用火审批单自动转为「已执行」（只读）。
 */
export function finishBurnVerification(
  key: string,
  actor: SessionActor,
  resultNote: string,
): ActionResult {
  const updated = completeVerification(key, actor, resultNote)
  if (!updated) {
    return {
      ok: false,
      message: '只有当班的审批人/值勤员可以完成核查，且不能重复核查',
    }
  }
  if (allVerificationsDone(updated.permitId)) {
    const rows = listRows('burnpermit')
    const index = rows.findIndex((row) => Number(row.id) === updated.permitId)
    if (index >= 0 && rows[index]!.status === BURN_APPROVED) {
      const row = rows[index]!
      rows[index] = { ...row, status: BURN_DONE, pending: false, 审批状态: BURN_DONE }
      saveRows('burnpermit', rows)
      return { ok: true, message: '核查已完成：检查站、巡护两条核查均已闭环，用火单转为已执行' }
    }
  }
  return {
    ok: true,
    message: `${updated.target === 'checkpoint' ? '检查站通行' : '巡护任务'}核查已完成，等待另一入口核查`,
  }
}

export function burnChecklist(target: BurnVerification['target']): BurnVerification[] {
  ensureVerificationSeed()
  return verificationsForTarget(target)
}

export function burnPermitVerifications(permitId: number) {
  ensureVerificationSeed()
  return verificationSummary(permitId)
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  if (key === 'burnpermit') {
    resetBurnVerifications()
  }
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
