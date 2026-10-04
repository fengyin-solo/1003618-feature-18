// 临时验证脚本：在 node 里给 local-store 打 localStorage/window 垫片，跑全部审批链路断言。
const path = require('path')
const esbuild = require('esbuild')
const fs = require('fs')

const result = []
function check(name, cond, extra = '') {
  result.push({ name, ok: !!cond, extra })
}

async function main() {
  const code = `
    const store = {}
    globalThis.window = {
      localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v) },
        removeItem: (k) => { delete store[k] },
      },
    }
    globalThis.localStorage = globalThis.window.localStorage
    const { SEED_ROWS } = require('@/data/seed')
    globalThis.window.localStorage.setItem('forest-fire-patrol:entries', JSON.stringify(SEED_ROWS))
    module.exports = require('@/api/local-service')
  `
  const tmp = path.join(__dirname, '.__harness.cjs')
  const src = path.join(__dirname, '.__harness.src.cjs')
  fs.writeFileSync(src, code)
  await esbuild.build({
    entryPoints: [src],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: tmp,
    alias: { '@': path.join(__dirname, '..', 'src') },
  })
  const svc = require(tmp)

  const liMing = { operator: '李明', role: '申请人', org: '北山林场', approveLevel: 0, shiftLabel: '白班 08:00-20:00', onDuty: true }
  const wangHua = { operator: '王华', role: '申请人', org: '南坡林场', approveLevel: 0, shiftLabel: '白班', onDuty: true }
  const zhao = { operator: '赵审批', role: '审批人', org: '防火审批组', approveLevel: 1, shiftLabel: '白班', onDuty: true }
  const qian = { operator: '钱审批', role: '审批人', org: '防火审批组', approveLevel: 1, shiftLabel: '白班', onDuty: true }
  const sun = { operator: '孙总监', role: '审批人', org: '防火指挥部', approveLevel: 2, shiftLabel: '白班', onDuty: true }
  const zhou = { operator: '周值勤', role: '值勤员', org: '防火检查站', approveLevel: 0, shiftLabel: '白班 08:00-20:00', onDuty: true }
  const wu = { operator: '吴休班', role: '值勤员', org: '防火检查站', approveLevel: 0, shiftLabel: '夜班 20:00-08:00', onDuty: false }

  const find = (id) => svc.listEntries('burnpermit').items.find((r) => Number(r.id) === id)

  // 1. 申请单位归属：别单位不能提交我的草稿
  let r = svc.runAction('burnpermit', 1, '提交申请', wangHua)
  check('1 别单位提交草稿被拦截', !r.ok && r.message.includes('申请单位'), r.message)
  r = svc.runAction('burnpermit', 1, '提交申请', liMing)
  check('2 本单位提交草稿成功', r.ok && find(1).status === '待审批', r.message)

  // 2. 防火期升级：BURN-0001 生产用火但计划在 10 月，需 2 级，赵（1级）越权拦截
  r = svc.runAction('burnpermit', 1, '批准申请', zhao)
  check('3 防火期1级审批越权被拦截', !r.ok && r.message.includes('2级'), r.message)
  // 孙（2级）批准成功，且下发两条核查
  r = svc.runAction('burnpermit', 1, '批准申请', sun)
  check('4 林区级批准成功', r.ok && find(1).status === '已批准', r.message)
  let vers = svc.burnPermitVerifications(1)
  check('5 批准后检查站/巡护各一条核查', !!vers.checkpoint && !!vers.patrol && vers.checkpoint.status === '待核查', '')
  // 3. 重复批准只生效一次：已批准单再次批准被拦截，且不重复下发核查
  r = svc.runAction('burnpermit', 1, '批准申请', sun)
  check('6 重复批准被拦截、不重复生效', !r.ok && r.message.includes('只有「待审批」'), r.message)
  check('7 重复批准核查仍只有两条', svc.burnPermitVerifications(1) && svc.burnChecklist('checkpoint').filter((v) => v.permitId === 1).length === 1, '')

  // 4. 炼山造林固定 2 级：赵审批 BURN-0003 被拦截
  r = svc.runAction('burnpermit', 3, '批准申请', zhao)
  check('8 炼山造林1级越权拦截', !r.ok && r.message.includes('2级'), r.message)

  // 5. 跨单位：钱审批（只管南坡）裁北山 BURN-0002 被拦截
  r = svc.runAction('burnpermit', 2, '批准申请', qian)
  check('9 跨单位审批被拦截', !r.ok && r.message.includes('跨单位'), r.message)
  // 赵（北山 1级）、9月非防火期、CHEC-0001 正常 → 批准成功
  r = svc.runAction('burnpermit', 2, '批准申请', zhao)
  check('10 林场级正常批准', r.ok, r.message)

  // 6. 现场检查冲突：BURN-0004 关联 CHEC-0002（临时关闭），有权限的钱和孙都被拦，现场优先
  r = svc.runAction('burnpermit', 4, '批准申请', qian)
  check('11 有权限但现场临时关闭被拦', !r.ok && r.message.includes('现场检查站'), r.message)
  r = svc.runAction('burnpermit', 4, '批准申请', sun)
  check('12 高级别也绕不过现场冲突', !r.ok && r.message.includes('现场检查优先'), r.message)
  // 解除现场管控后钱可批准
  svc.runAction('checkpoint', 2, '安排换岗', zhou)
  r = svc.runAction('burnpermit', 4, '批准申请', qian)
  check('13 解除现场管控后可批准', r.ok && find(4).status === '已批准', r.message)

  // 7. 历史缺审批人按值勤班次兼容
  r = svc.runAction('burnpermit', 7, '批准申请', wu)
  check('14 休班值勤裁决历史单被拦截', !r.ok && r.message.includes('值勤班次'), r.message)
  r = svc.runAction('burnpermit', 7, '批准申请', zhou)
  check('15 当班值勤裁决历史单成功', r.ok && find(7).status === '已批准', r.message)

  // 8. 申请人无审批权
  r = svc.runAction('burnpermit', 3, '批准申请', liMing)
  check('16 申请人批准被拦截', !r.ok && r.message.includes('没有审批权限'), r.message)

  // 9. 驳回同样走鉴权；已驳回只读
  r = svc.runAction('burnpermit', 3, '驳回答复', wangHua)
  check('17 无权限驳回被拦截', !r.ok, r.message)
  r = svc.runAction('burnpermit', 3, '驳回答复', sun)
  check('18 2级驳回成功', r.ok && find(3).status === '已驳回', r.message)
  r = svc.runAction('burnpermit', 6, '提交申请', zhao)
  check('19 已驳回记录只读', !r.ok && r.message.includes('只读'), r.message)

  // 10. 双入口核查：先完成检查站核查，单仍已批准；检查站清单与巡护清单同步
  const cpKey = svc.burnPermitVerifications(1).checkpoint.key
  const ptKey = svc.burnPermitVerifications(1).patrol.key
  r = svc.finishBurnVerification(cpKey, liMing, '')
  check('20 申请人不能完成核查', !r.ok, r.message)
  r = svc.finishBurnVerification(cpKey, zhou, '通行核验通过')
  check('21 检查站入口完成核查', r.ok && find(1).status === '已批准', r.message)
  r = svc.finishBurnVerification(cpKey, zhou, '重复')
  check('22 核查不可重复完成', !r.ok, r.message)
  // 巡护入口此时应已看到检查站那条变已核查（同一存储），且自己的仍待核查
  const cpList = svc.burnChecklist('checkpoint').find((v) => v.key === cpKey)
  const ptList = svc.burnChecklist('patrol').find((v) => v.key === ptKey)
  check('23 检查站清单同步执行状态', cpList.status === '已核查' && cpList.checkedBy === '周值勤', '')
  check('24 其余入口（巡护）看到检查站已核、自己待核', ptList.status === '待核查', '')
  // 完成巡护核查 → 自动转已执行
  r = svc.finishBurnVerification(ptKey, zhou, '现场盯守到位')
  check('25 巡护核查完成', r.ok, r.message)
  check('26 两条核查闭环后自动转已执行', find(1).status === '已执行', r.message)
  check('27 巡护清单同步为已核查', svc.burnChecklist('patrol').find((v) => v.key === ptKey).status === '已核查', '')

  // 11. 已执行只读：任何动作都拦
  let blockedAll = true
  for (const action of ['提交申请', '撤回草稿', '批准申请', '驳回答复']) {
    const x = svc.runAction('burnpermit', 1, action, sun)
    if (x.ok) { blockedAll = false; break }
  }
  check('28 已执行记录所有动作只读', blockedAll, '')

  // 12. 撤回草稿：待申请 → 已撤回（作废）；待审批 → 退回待申请
  let created = svc.createBurnDraft({
    审批编号: 'BURN-0008', 申请单位: '北山林场', 用火类型: '生活用火', 用火地点: '北山临时点',
    计划时段: '2026-09-30 10:00-11:00', 关联检查站: 'CHEC-0001', 关联巡护任务: 'PATR-0001', 安全措施: '灭火器',
  }, liMing)
  check('29 申请人登记草稿成功', created.ok, created.message)
  r = svc.runAction('burnpermit', created.id, '撤回草稿', wangHua)
  check('30 别单位不能撤回', !r.ok, r.message)
  r = svc.runAction('burnpermit', created.id, '撤回草稿', liMing)
  check('31 本单位撤回未提交草稿=作废', r.ok && find(created.id).status === '已撤回', r.message)
  created = svc.createBurnDraft({
    审批编号: 'BURN-0009', 申请单位: '北山林场', 用火类型: '生活用火', 用火地点: '北山二号点',
    计划时段: '2026-09-29 10:00-11:00', 关联检查站: 'CHEC-0001', 关联巡护任务: 'PATR-0001', 安全措施: '灭火器',
  }, liMing)
  svc.runAction('burnpermit', created.id, '提交申请', liMing)
  r = svc.runAction('burnpermit', created.id, '撤回草稿', liMing)
  check('32 已提交申请撤回退回草稿', r.ok && find(created.id).status === '待申请', r.message)

  // 13. 非申请人不能登记草稿
  r = svc.createBurnDraft({
    审批编号: 'BURN-0010', 申请单位: '南坡林场', 用火类型: '生活用火', 用火地点: 'x',
    计划时段: '2026-09-29', 关联检查站: 'CHEC-0001', 关联巡护任务: 'PATR-0001', 安全措施: 'x',
  }, sun)
  check('33 审批人不能登记草稿', !r.ok, r.message)

  // 14. 历史已执行 BURN-0005 初始即带两条已核查（首屏同步）
  const v5 = svc.burnPermitVerifications(5)
  check('34 历史已执行单两条核查均已完成', v5.checkpoint?.status === '已核查' && v5.patrol?.status === '已核查', '')

  let pass = 0
  for (const item of result) {
    console.log((item.ok ? 'PASS' : 'FAIL') + ' | ' + item.name + (item.ok ? '' : ' :: ' + item.extra))
    if (item.ok) pass++
  }
  console.log(`\n${pass}/${result.length} passed`)
  fs.unlinkSync(tmp)
  fs.unlinkSync(src)
  process.exit(pass === result.length ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
