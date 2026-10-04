// 用火审批的分级权限与裁决规则：
// 1) 申请单位只能提交、撤回本单位草稿/待审批单；审批人可批准或驳回；已执行记录只读。
// 2) 审批级别 = 用火类型（高危用火三级）叠加计划时段（森林防火期二级、非防火期一级）。
// 3) 安全措施与现场检查冲突时，现场检查结论优先：未通过/待核查的一律不予批准。
// 4) 历史审批单缺审批人时，按计划时段对应日期的值勤班次兼容补位。

import { listRows } from '../data/local-store'
import type { EntryRow } from '../data/types'
import { LEVEL_NAMES, type Actor } from './identity'

export const PERMIT_STATUS = {
  draft: '待申请',
  pending: '待审批',
  approved: '已批准',
  rejected: '已驳回',
  executed: '已执行',
} as const

// 无论计划时段，一律需要三级审批的高危用火类型。
export const HIGH_RISK_TYPES = ['计划烧除', '炼山造林', '烧荒烧炭']

// 现场检查结论的三种取值；未通过与待核查都构成对「安全措施」的否决。
export const SITE_CHECK = {
  pass: '通过',
  pending: '待核查',
  fail: '未通过',
} as const

// 森林防火期：10 月 1 日至次年 4 月 30 日（按月日判定，跨年）。
export function inFirePreventionPeriod(date: Date): boolean {
  const monthDay = date.getMonth() + 1
  return monthDay >= 10 || monthDay <= 4
}

export function parseStartDate(period: string): Date | null {
  // 计划时段形如「2026-10-04 至 2026-10-05」，取起始日。
  const text = String(period ?? '').trim()
  const match = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (!match) {
    return null
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

function isHighRiskType(fireType: string): boolean {
  return HIGH_RISK_TYPES.some((item) => fireType.includes(item))
}

// 该审批单需要的最低审批级别。
export function requiredLevel(row: EntryRow): number {
  const fireType = String(row['用火类型'] ?? '')
  if (isHighRiskType(fireType)) {
    return 3
  }
  const start = parseStartDate(String(row['计划时段'] ?? ''))
  if (start && inFirePreventionPeriod(start)) {
    return 2
  }
  return 1
}

// 按值勤班次找计划时段起始日的值勤审批人：历史审批单缺审批人时兼容。
export function dutyApproverFor(row: EntryRow): string {
  const start = parseStartDate(String(row['计划时段'] ?? ''))
  const dateText = start
    ? `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`
    : ''
  const duties = listRows('duty')
  const hit =
    duties.find((item) => String(item['值勤日期'] ?? '').startsWith(dateText) && /防火办|指挥部/.test(String(item['值勤岗位'] ?? ''))) ??
    duties.find((item) => String(item['值勤日期'] ?? '').startsWith(dateText))
  return hit ? String(hit['值勤人员'] ?? '') : ''
}

export type Decision = { ok: boolean; message: string }

// 审批级别裁决：身份不对、级别不足一律拦截（批准、驳回均属审批权，同等管控）。
export function adjudicateAuthority(row: EntryRow, actor: Actor): Decision {
  if (actor.role !== 'approver') {
    return { ok: false, message: '当前身份是申请单位，只有审批人可以批准或驳回用火审批单' }
  }
  const need = requiredLevel(row)
  if (actor.level < need) {
    return {
      ok: false,
      message: `越权审批已拦截：该用火类型/计划时段需${LEVEL_NAMES[need]}审批，当前身份为${LEVEL_NAMES[actor.level]}`,
    }
  }
  return { ok: true, message: '' }
}

// 批准裁决：安全措施与现场检查冲突时现场检查优先，未通过/待核查不予批准。
export function adjudicateApproval(row: EntryRow, actor: Actor): Decision {
  const authority = adjudicateAuthority(row, actor)
  if (!authority.ok) {
    return authority
  }
  const site = String(row['现场检查'] ?? '').trim()
  if (site === SITE_CHECK.fail) {
    return { ok: false, message: '现场检查未通过，与申报安全措施冲突：按现场检查优先裁决，不予批准，请驳回并退回整改' }
  }
  if (site === SITE_CHECK.pending || site === '') {
    return { ok: false, message: '现场检查尚未完成（待核查），安全措施无法确认，暂不能批准' }
  }
  return { ok: true, message: '' }
}

// 某条审批单在当前身份下可见的动作（已执行只读，不返回任何动作）。
export function availableActions(row: EntryRow, actor: Actor): string[] {
  const status = String(row.status)
  if (status === PERMIT_STATUS.executed) {
    return []
  }
  if (actor.role === 'applicant') {
    if (String(row['申请单位'] ?? '') !== actor.unit) {
      return []
    }
    if (status === PERMIT_STATUS.draft || status === PERMIT_STATUS.rejected) {
      return ['提交申请']
    }
    if (status === PERMIT_STATUS.pending) {
      return ['撤回草稿']
    }
    return []
  }
  // 审批人只对待审批单裁决；级别不足时仍展示按钮，但操作会被拦截并给出提示。
  if (status === PERMIT_STATUS.pending) {
    return ['批准申请', '驳回答复']
  }
  return []
}
