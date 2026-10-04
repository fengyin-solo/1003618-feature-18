// 用火审批分级权限与执行链路验证：用 esbuild 把 TS 域逻辑打包到临时文件后在 Node 跑。
// 运行：node scripts/verify-burnpermit.mjs
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const tmp = mkdtempSync(join(tmpdir(), 'burn-verify-'))
const entry = join(tmp, 'entry.js')

await build({
  stdin: {
    contents: `
      export * from './src/domain/identity.ts'
      export * from './src/domain/rules.ts'
      export * from './src/domain/workflow.ts'
      export { allRows, listRows, resetRows, saveRows } from './src/data/local-store.ts'
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
    sourcefile: 'virtual.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: entry,
  logLevel: 'silent',
})

const mod = await import(pathToFileURL(entry).href)
const {
  IDENTITY_PRESETS,
  setActorResolver,
  requiredLevel,
  inFirePreventionPeriod,
  runPermitAction,
  createDraft,
  verifyCheckpoint,
  verifyPatrol,
  hasSpawnedChecks,
  listRows,
  resetRows,
} = mod

let passed = 0
let failed = 0
function check(name, actual, expected) {
  const actualText = JSON.stringify(actual)
  const expectedText = JSON.stringify(expected)
  if (actualText === expectedText) {
    passed += 1
    console.log(`  ✅ ${name}`)
  } else {
    failed += 1
    console.log(`  ❌ ${name}\n      expected ${expectedText}\n      actual   ${actualText}`)
  }
}
function ok(name, result) {
  check(name, result.ok, true)
}
function bad(name, result, keyword) {
  if (!result.ok && (!keyword || result.message.includes(keyword))) {
    passed += 1
    console.log(`  ✅ ${name}（${result.message}）`)
  } else {
    failed += 1
    console.log(`  ❌ ${name} ->`, result)
  }
}
const actor = (i) => IDENTITY_PRESETS[i]
function use(i) {
  setActorResolver(() => IDENTITY_PRESETS[i])
}

// localStorage 垫片
class MemStore {
  constructor() { this.m = new Map() }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null }
  setItem(k, v) { this.m.set(k, String(v)) }
  removeItem(k) { this.m.delete(k) }
}
globalThis.window = {
  localStorage: new MemStore(),
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return true },
}
globalThis.Event = class { constructor(t) { this.type = t } }

resetRows('burnpermit')
resetRows('checkpoint')
resetRows('patrol')
resetRows('duty')

console.log('\n分级规则：')
check('防火期判定 2026-10-04 在防火期', inFirePreventionPeriod(new Date(2026, 9, 4)), true)
check('防火期判定 2026-07-12 非防火期', inFirePreventionPeriod(new Date(2026, 6, 12)), false)
const seed = listRows('burnpermit')
check('BURN-0001 防火期普通用火需二级', requiredLevel(seed[0]), 2)
check('BURN-0002 计划烧除需三级', requiredLevel(seed[1]), 3)
check('BURN-0003 烧荒烧炭需三级', requiredLevel(seed[2]), 3)
check('BURN-0004 非防火期低危用火需一级', requiredLevel(seed[3]), 1)

console.log('\n申请单位权限：')
use(0) // 王立军 · 青山林场
ok('本单位待审批可撤回', runPermitAction(1, '撤回草稿'))
bad('外单位审批单不能撤回', runPermitAction(2, '撤回草稿'), '只能撤回本单位')
check('撤回后回到待申请', listRows('burnpermit')[0].status, '待申请')
ok('本单位草稿可重新提交', runPermitAction(1, '提交申请'))
check('提交后回到待审批', listRows('burnpermit')[0].status, '待审批')
bad('申请单位不能批准', runPermitAction(1, '批准申请'), '无权审批')

console.log('\n越权审批拦截：')
use(2) // 赵德山 一级
bad('一级不能批防火期二级单', runPermitAction(1, '批准申请'), '越权审批已拦截')
use(1) // 李守林 申请人
bad('申请人身份不能批', runPermitAction(1, '批准申请'), '无权审批')
use(3) // 陈志刚 二级
bad('二级不能批高危三级单', runPermitAction(2, '批准申请'), '越权审批已拦截')

console.log('\n现场检查优先（安全措施冲突裁决）：')
use(4) // 刘总指挥 三级
bad('现场未通过，三级也不予批准', runPermitAction(3, '批准申请'), '现场检查未通过')
ok('现场未通过的单可驳回（裁决为退回整改）', runPermitAction(3, '驳回答复'))
check('驳回后状态已驳回', listRows('burnpermit')[2].status, '已驳回')

console.log('\n批准生效 + 执行核查下发 + 幂等：')
check('批准前没有核查记录', hasSpawnedChecks(1), false)
use(3) // 陈志刚 二级，批 BURN-0001（防火期二级，现场通过，审批人缺失）
const approve = runPermitAction(1, '批准申请')
ok('二级批准 BURN-0001', approve)
check('审批人按值勤班次补位为陈大山', listRows('burnpermit')[0]['审批人'], '陈大山')
check('批准后已生成核查', hasSpawnedChecks(1), true)
const linkedCheckpoint = listRows('checkpoint').filter((r) => r['来源审批单'] === 1)
const linkedPatrol = listRows('patrol').filter((r) => r['来源审批单'] === 1)
check('检查站下发 1 条', linkedCheckpoint.length, 1)
check('巡护任务下发 1 条', linkedPatrol.length, 1)
check('检查站核查待核查', linkedCheckpoint[0]['核查状态'], '待核查')
check('巡护核查待核查', linkedPatrol[0]['核查状态'], '待核查')
bad('重复批准只生效一次', runPermitAction(1, '批准申请'), '重复操作不生效')
bad('已批准不能驳回', runPermitAction(1, '驳回答复'), '重复操作不生效')
check('重复批准后检查站仍只有 1 条', listRows('checkpoint').filter((r) => r['来源审批单'] === 1).length, 1)

console.log('\n两处核查同步执行状态：')
check('单条核查通过后仍为已批准', listRows('burnpermit')[0].status, '已批准')
ok('检查站核查通过', verifyCheckpoint(linkedCheckpoint[0].id))
check('仅检查站通过，审批单仍已批准', listRows('burnpermit')[0].status, '已批准')
ok('巡护核查通过', verifyPatrol(linkedPatrol[0].id))
check('两条都通过，审批单转已执行', listRows('burnpermit')[0].status, '已执行')
bad('已执行只读：拒绝批准', runPermitAction(1, '批准申请'), '只读')
bad('已执行只读：拒绝撤回', runPermitAction(1, '撤回草稿'), '只读')
bad('检查站核查不能重复通过', verifyCheckpoint(linkedCheckpoint[0].id), '请勿重复')

console.log('\n草稿登记越权：')
use(3) // 审批人
bad('审批人不能登记草稿', createDraft({
  unit: '县森林防火指挥部', fireType: '林缘杂物焚烧', location: '某处', period: '2026-11-01 至 2026-11-01', safety: '', siteCheck: '待核查',
}), '只有申请单位身份')
use(0) // 王立军 青山林场
ok('申请人登记本单位草稿', createDraft({
  unit: '青山林场', fireType: '林缘杂物焚烧', location: '青山林场北沟', period: '2026-06-15 至 2026-06-15', safety: '灭火机一台', siteCheck: '通过',
}))
bad('不能替外单位登记', createDraft({
  unit: '红松岭林场', fireType: '林缘杂物焚烧', location: '某地', period: '2026-06-15 至 2026-06-15', safety: '', siteCheck: '待核查',
}), '本单位')

rmSync(tmp, { recursive: true, force: true })

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
