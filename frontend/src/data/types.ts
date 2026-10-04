/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 当前操作者：用火审批分级权限按角色、审批级别、申请单位与值勤班次判定。 */
export type SessionActor = {
  operator: string
  role: '申请人' | '审批人' | '值勤员'
  /** 申请人所属单位；审批人可管辖的单位（'*' 表示全林区）。 */
  org: string
  /** 审批级别：1=林场级，2=林区级；申请人与值勤员不做分级。 */
  approveLevel: 0 | 1 | 2
  shiftLabel: string
  /** 是否正在值勤，历史缺审批人的单据只允许当班值勤角色裁决。 */
  onDuty: boolean
}

/** 用火审批单的动作编排需要用到的审批上下文。 */
export type BurnContext = {
  actor: SessionActor
  /** 关联防火检查站的运行状态，用于现场检查冲突裁决。 */
  checkpointStatus: string
}

/** 批准后下发的执行核查：防火检查站、巡护任务各一条。 */
export type BurnVerification = {
  key: string
  permitId: number
  permitNo: string
  target: 'checkpoint' | 'patrol'
  title: string
  /** 关联检查站站点编号 / 巡护任务编号。 */
  refCode: string
  fireLocation: string
  plannedWindow: string
  fireType: string
  org: string
  createdAt: string
  status: '待核查' | '已核查'
  checkedAt: string
  checkedBy: string
  resultNote: string
}
