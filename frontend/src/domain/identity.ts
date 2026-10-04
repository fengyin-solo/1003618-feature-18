// 用火审批的身份模型：申请单位（草稿人）与审批人分级，审批级别按用火类型与计划时段确定。

export type Role = 'applicant' | 'approver'

export type Actor = {
  /** 当前操作人姓名 */
  name: string
  /** 申请单位：申请单位身份时用于限定只能操作本单位草稿 */
  unit: string
  role: Role
  /** 审批级别：1 林场防火办 / 2 县防火指挥部 / 3 市防火指挥部，值越大权限越高 */
  level: number
  /** 当前值勤班次，用于历史缺审批人时按班次兼容 */
  shift: string
}

export const IDENTITY_PRESETS: Actor[] = [
  { name: '王立军', unit: '青山林场', role: 'applicant', level: 0, shift: '白班 08:00-20:00' },
  { name: '李守林', unit: '红松岭林场', role: 'applicant', level: 0, shift: '夜班 20:00-08:00' },
  { name: '赵德山', unit: '青山林场防火办', role: 'approver', level: 1, shift: '白班 08:00-20:00' },
  { name: '陈志刚', unit: '县森林防火指挥部', role: 'approver', level: 2, shift: '白班 08:00-20:00' },
  { name: '刘总指挥', unit: '市森林防火指挥部', role: 'approver', level: 3, shift: '夜班 20:00-08:00' },
]

export const LEVEL_NAMES: Record<number, string> = {
  0: '申请单位',
  1: '林场防火办（一级）',
  2: '县防火指挥部（二级）',
  3: '市防火指挥部（三级）',
}

// 身份来源：UI 从会话 store 注入；领域逻辑不直接依赖 pinia，便于脚本验证。
let resolver: () => Actor | null = () => null

export function setActorResolver(source: () => Actor | null): void {
  resolver = source
}

export function currentActor(): Actor {
  return resolver() ?? IDENTITY_PRESETS[2]
}

export function actorLabel(actor: Actor): string {
  const role = actor.role === 'approver' ? LEVEL_NAMES[actor.level] : '申请单位'
  return `${actor.name}（${actor.unit} · ${role}）`
}
