import { listLinkItems, saveLinkItems } from '@/data/local-store'
import type { BurnContext, BurnVerification, EntryRow, SessionActor } from '@/data/types'

// 用火审批领域规则：分级权限、现场检查冲突裁决、历史缺审批人兼容、批准后执行核查。
// 所有业务判断集中在这里，页面与 local-service 只做编排，不自行裁决。

export const BURN_DRAFT = '待申请'
export const BURN_PENDING = '待审批'
export const BURN_APPROVED = '已批准'
export const BURN_REJECTED = '已驳回'
export const BURN_DONE = '已执行'
export const BURN_WITHDRAWN = '已撤回'

const VERIFICATION_BUCKET = 'burn-verifications'

/** 审批人花名册：级别 1 为林场级（受申请单位管辖范围限制），级别 2 为林区级（全林区）。 */
const APPROVER_DIRECTORY: { name: string; level: 1 | 2; orgs: string[] }[] = [
  { name: '赵审批', level: 1, orgs: ['北山林场', '青山林场'] },
  { name: '钱审批', level: 1, orgs: ['南坡林场'] },
  { name: '孙总监', level: 2, orgs: ['*'] },
]

/** 用火类型 → 基础审批级别。炼山等高风险用火必须林区级（2）审批。 */
const TYPE_BASE_LEVEL: Record<string, 1 | 2> = {
  炼山造林: 2,
  计划烧除: 2,
  林内杂灌焚烧: 1,
  生产性用火: 1,
  生活用火: 1,
}

/** 现场检查处于这些状态时，安全措施声明与现场检查冲突，以现场检查为准并阻断批准。 */
const CHECKPOINT_BLOCK_STATUSES = ['升级检查', '临时关闭']

/** 计划时段落在森林防火期（每年 10 月至次年 4 月）时，审批级别上调一级，封顶林区级。 */
function isFirePreventionSeason(windowText: string): boolean {
  const matched = windowText.match(/(\d{4})-(\d{2})-\d{2}/)
  if (!matched) {
    return false
  }
  const month = Number(matched[2])
  return month >= 10 || month <= 4
}

/** 取用火类型的基础审批级别：花名册里没有的类型按林场级起步。 */
export function baseApproveLevel(fireType: string): 1 | 2 {
  return TYPE_BASE_LEVEL[fireType] ?? 1
}

/** 分级权限：按用火类型定基础级别，防火期内计划时段上调一级。 */
export function requiredApproveLevel(row: EntryRow): 1 | 2 {
  const base = baseApproveLevel(String(row['用火类型'] ?? ''))
  if (base === 2) {
    return 2
  }
  return isFirePreventionSeason(String(row['计划时段'] ?? '')) ? 2 : 1
}

/** 审批级别文案，用于权限提示。 */
export function levelLabel(level: number): string {
  return level === 2 ? '林区级（2级）' : '林场级（1级）'
}

/** 申请单位只能动自己的草稿；审批/驳回只能由审批人或当班值勤员对待审批单操作。 */
export function canSubmit(row: EntryRow, actor: SessionActor): boolean {
  return actor.role === '申请人' && String(row['申请单位']) === actor.org && row.status === BURN_DRAFT
}

export function canWithdraw(row: EntryRow, actor: SessionActor): boolean {
  return (
    actor.role === '申请人' &&
    String(row['申请单位']) === actor.org &&
    (row.status === BURN_DRAFT || row.status === BURN_PENDING)
  )
}

function inApproverDirectory(name: string) {
  return APPROVER_DIRECTORY.find((item) => item.name === name)
}

/**
 * 裁决当前操作者是否有权批准/驳回这张单。
 * 1. 审批人按级别 + 申请单位管辖范围鉴权，越权一律拦截；
 * 2. 历史单缺审批人时，按值勤班次兼容：当班值勤员可裁决，非当班拒绝；
 * 3. 其余角色（申请人等）无审批权。
 */
export function resolveApprovalAuthority(
  row: EntryRow,
  actor: SessionActor,
): { allowed: boolean; reason?: string } {
  if (actor.role === '审批人') {
    const profile = inApproverDirectory(actor.operator)
    if (!profile || actor.approveLevel !== profile.level) {
      return { allowed: false, reason: '当前账号不在对应审批级别花名册内，越权审批已拦截' }
    }
    const required = requiredApproveLevel(row)
    if (profile.level < required) {
      return {
        allowed: false,
        reason: `该用火单需${levelLabel(required)}审批（${String(row['用火类型'])}${
          isFirePreventionSeason(String(row['计划时段'] ?? '')) ? '且计划时段在防火期' : ''
        }），${profile.name}只有${levelLabel(profile.level)}权限，越权审批已拦截`,
      }
    }
    const coversAll = profile.orgs.includes('*')
    if (!coversAll && !profile.orgs.includes(String(row['申请单位']))) {
      return {
        allowed: false,
        reason: `${profile.name}的管辖单位不含「${String(row['申请单位'])}」，跨单位审批已拦截`,
      }
    }
    return { allowed: true }
  }

  const designated = String(row['审批人'] ?? '').trim()
  const isLegacyMissingApprover =
    designated === '' || designated === '—' || !inApproverDirectory(designated)
  if (isLegacyMissingApprover && actor.role === '值勤员') {
    if (!actor.onDuty) {
      return {
        allowed: false,
        reason: `该历史审批单未登记有效审批人，需当班值勤裁决，当前操作者不在「${actor.shiftLabel}」值勤班次内`,
      }
    }
    return { allowed: true }
  }

  return { allowed: false, reason: '当前角色没有审批权限，越权审批已拦截' }
}

/**
 * 安全措施与现场检查冲突裁决：现场检查站处于升级检查/临时关闭时，
 * 即使申请单声明的安全措施齐全，也以现场检查结论为准——先解除现场管控才能批准。
 */
export function checkpointConflict(context: BurnContext): string | null {
  if (CHECKPOINT_BLOCK_STATUSES.includes(context.checkpointStatus)) {
    return `现场检查站当前为「${context.checkpointStatus}」，安全措施声明与现场检查冲突，按现场检查优先裁决：请先解除现场管控再批准`
  }
  return null
}

/** 批准后下发的执行核查（检查站通行核查 + 巡护任务核查），幂等：重复批准只生成一次。 */
export function listVerifications(): BurnVerification[] {
  return listLinkItems<BurnVerification>(VERIFICATION_BUCKET)
}

export function verificationsOf(permitId: number): BurnVerification[] {
  return listVerifications().filter((item) => item.permitId === permitId)
}

function todayText(): string {
  return new Date().toISOString().slice(0, 10)
}

function makeVerifications(row: EntryRow): BurnVerification[] {
  const stamp = todayText()
  const base = {
    permitId: Number(row.id),
    permitNo: String(row['审批编号']),
    fireLocation: String(row['用火地点'] ?? ''),
    plannedWindow: String(row['计划时段'] ?? ''),
    fireType: String(row['用火类型'] ?? ''),
    org: String(row['申请单位'] ?? ''),
    createdAt: stamp,
    status: '待核查' as const,
    checkedAt: '',
    checkedBy: '',
    resultNote: '',
  }
  return [
    {
      ...base,
      key: `${row.id}:checkpoint`,
      target: 'checkpoint',
      title: `用火通行核查 ${base.permitNo}`,
      refCode: String(row['关联检查站'] ?? ''),
    },
    {
      ...base,
      key: `${row.id}:patrol`,
      target: 'patrol',
      title: `用火巡护核查 ${base.permitNo}`,
      refCode: String(row['关联巡护任务'] ?? ''),
    },
  ]
}

/** 批准生效时调用：已存在核查（批准过一次）则不再补发，保证重复批准只生效一次。 */
export function issueVerifications(row: EntryRow): { created: BurnVerification[]; issued: boolean } {
  // 先确保历史已执行单的核查种子在位，避免首次批准直接写 bucket 时把历史种子覆盖掉。
  ensureVerificationSeed()
  const existing = listVerifications()
  if (existing.some((item) => item.permitId === Number(row.id))) {
    return { created: [], issued: false }
  }
  const created = makeVerifications(row)
  saveLinkItems(VERIFICATION_BUCKET, [...existing, ...created])
  return { created, issued: true }
}

/** 完成一条执行核查（检查站/巡护两个入口共用），返回更新后的核查；找不到返回 null。 */
export function completeVerification(
  key: string,
  actor: SessionActor,
  resultNote: string,
): BurnVerification | null {
  if (!(actor.role === '审批人' || actor.role === '值勤员') || !actor.onDuty) {
    return null
  }
  const items = listVerifications()
  const index = items.findIndex((item) => item.key === key)
  if (index < 0 || items[index]!.status === '已核查') {
    return null
  }
  items[index] = {
    ...items[index]!,
    status: '已核查',
    checkedAt: todayText(),
    checkedBy: actor.operator,
    resultNote,
  }
  saveLinkItems(VERIFICATION_BUCKET, items)
  return items[index]
}

/** 检查站/巡护两个入口的通行核查清单，按目标类型取数。 */
export function verificationsForTarget(target: BurnVerification['target']): BurnVerification[] {
  return listVerifications().filter((item) => item.target === target)
}

/** 一张已批准用火单的两条核查都完成后即视为执行完毕，单状态转为「已执行」（只读）。 */
export function allVerificationsDone(permitId: number): boolean {
  const mine = verificationsOf(permitId)
  return mine.length === 2 && mine.every((item) => item.status === '已核查')
}

export function verificationSummary(permitId: number): {
  checkpoint: BurnVerification | null
  patrol: BurnVerification | null
} {
  const mine = verificationsOf(permitId)
  return {
    checkpoint: mine.find((item) => item.target === 'checkpoint') ?? null,
    patrol: mine.find((item) => item.target === 'patrol') ?? null,
  }
}

/** 重置焚烧审批模块时一并清掉历史核查，保证示例数据可回到初始态。 */
export function resetBurnVerifications(): void {
  saveLinkItems(VERIFICATION_BUCKET, seedVerifications())
}

/** 历史「已执行」样例单自带两条已完成核查，保证检查站/巡护入口初始就能看到同步的执行状态。 */
function seedVerifications(): BurnVerification[] {
  return [
    {
      key: '5:checkpoint',
      permitId: 5,
      permitNo: 'BURN-0005',
      target: 'checkpoint',
      title: '用火通行核查 BURN-0005',
      refCode: 'CHEC-0003',
      fireLocation: '北山林场三号沟',
      plannedWindow: '2026-09-05 09:00-11:00',
      fireType: '生产性用火',
      org: '北山林场',
      createdAt: '2026-09-04',
      status: '已核查',
      checkedAt: '2026-09-05',
      checkedBy: '周值勤',
      resultNote: '通行车辆与火种登记齐全',
    },
    {
      key: '5:patrol',
      permitId: 5,
      permitNo: 'BURN-0005',
      target: 'patrol',
      title: '用火巡护核查 BURN-0005',
      refCode: 'PATR-0003',
      fireLocation: '北山林场三号沟',
      plannedWindow: '2026-09-05 09:00-11:00',
      fireType: '生产性用火',
      org: '北山林场',
      createdAt: '2026-09-04',
      status: '已核查',
      checkedAt: '2026-09-05',
      checkedBy: '周值勤',
      resultNote: '现场巡护盯守到位，用火已完成',
    },
  ]
}

// 首次进入时把历史核查播种进链路存储。
export function ensureVerificationSeed(): void {
  if (listLinkItems<BurnVerification>(VERIFICATION_BUCKET).length === 0) {
    saveLinkItems(VERIFICATION_BUCKET, seedVerifications())
  }
}
