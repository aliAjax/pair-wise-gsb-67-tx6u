import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import type { Pinia } from 'pinia'
import { useAcceptanceStore, type CommitTreeInput } from '../stores/acceptance'
import type { TreeMove } from '../types/domain'

const STORAGE_KEY = 'gsb67:grid-acceptance'

let passed = 0
const ok = (name: string, cond: boolean) => { assert.ok(cond, name); passed++; console.log('✔', name) }

type StorageListener = (event: { key: string; newValue: string | null }) => void

interface WindowHarness {
  pinia: Pinia
  listeners: StorageListener[]
  receive: (raw: string | null) => void
}

function createHarness(backend: Map<string, string> & { failNext?: boolean }): WindowHarness {
  const listeners: StorageListener[] = []
  ;(globalThis as any).localStorage = {
    getItem: (key: string) => backend.has(key) ? backend.get(key)! : null,
    setItem: (key: string, value: string) => {
      if (backend.failNext) { backend.failNext = false; throw new Error('disk full') }
      backend.set(key, value)
    }
  }
  ;(globalThis as any).window = { addEventListener: (_type: string, fn: StorageListener) => listeners.push(fn) }
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useAcceptanceStore()
  store.hydrate()
  return { pinia, listeners, receive(raw) { listeners.forEach((fn) => fn({ key: STORAGE_KEY, newValue: raw })) } }
}

function storeOf(harness: WindowHarness) {
  setActivePinia(harness.pinia)
  return useAcceptanceStore()
}

const moveInvToAr2 = (): TreeMove[] => [{ nodeId: 'EQ-INV11', nodeName: '1-1号逆变器', fromParentId: 'EQ-AR1', toParentId: 'EQ-AR2', reason: '验收拆分：1-1号逆变器划入2号方阵' }]
const moveCbToAr2 = (): TreeMove[] => [{ nodeId: 'EQ-CB111', nodeName: '1-1-1汇流箱', fromParentId: 'EQ-INV11', toParentId: 'EQ-AR2', reason: '汇流箱改组划入2号方阵' }]

// ---------- 场景1：两个窗口并发提交，先到挂接保留，后到整套留冲突草稿 ----------
{
  const backend = new Map<string, string>()
  const winA = createHarness(backend)
  const winB = createHarness(backend)
  const A = storeOf(winA)
  const B = storeOf(winB)
  ok('两窗口初始树版本均为V1', A.treeRevision === 1 && B.treeRevision === 1)

  const resultA = A.commitTreeMoves({ moves: moveInvToAr2(), windowName: '窗口A' })
  ok('窗口A提交成功', resultA.ok && A.treeRevision === 2)
  ok('A：逆变器挂到2号方阵（子节点随迁）', A.equipment.find((n) => n.id === 'EQ-INV11')!.parentId === 'EQ-AR2' && A.equipment.find((n) => n.id === 'EQ-CB111')!.parentId === 'EQ-INV11')
  ok('A：验收项与证书仍随设备节点（嵌入迁移不丢数据）', A.equipment.find((n) => n.id === 'EQ-INV11')!.items.length === 2 && A.equipment.find((n) => n.id === 'EQ-INV11')!.certificates.length === 1)

  // B 在收到 storage 事件之前提交（模拟几乎同时）：读到的共享树已是 V2
  const resultB = B.commitTreeMoves({ moves: moveCbToAr2(), windowName: '窗口B' } satisfies CommitTreeInput)
  ok('B：后到提交被拒绝并提示冲突草稿', !resultB.ok && resultB.message.includes('冲突草稿'))
  ok('B：先到窗口的挂接被保留（B树已采纳V2）', B.equipment.find((n) => n.id === 'EQ-INV11')!.parentId === 'EQ-AR2')
  ok('B：树版本推进到先到窗口的V2', B.treeRevision === 2)
  ok('B：冲突草稿恰好1套且为整套原始变更', B.conflictDrafts.length === 1 && B.conflictDrafts[0].moves[0].nodeId === 'EQ-CB111')
  ok('B：冲突草稿没有半步应用到树上', B.equipment.find((n) => n.id === 'EQ-CB111')!.parentId === 'EQ-INV11')
  ok('B：草稿记录落后基线V1', B.conflictDrafts[0].baseRevision === 1)

  // storage 事件到达：A 收到 B 写入的草稿
  winA.receive(backend.get(STORAGE_KEY)!)
  const A2 = storeOf(winA)
  ok('A：通过storage事件同步看到B的冲突草稿', A2.conflictDrafts.length === 1)

  // ---------- 场景2：冲突按新树重算合并 ----------
  const rebase = B.rebaseConflict(B.conflictDrafts[0].id)
  ok('B：汇流箱在V2新树下可合法重算', rebase.ok && B.treeRevision === 3)
  ok('B：重算后汇流箱直接挂2号方阵', B.equipment.find((n) => n.id === 'EQ-CB111')!.parentId === 'EQ-AR2')
  ok('B：草稿转为已合并', B.changeSets[0].status === '已合并' && B.conflictDrafts.length === 0)
}

// ---------- 场景3：写入失败恢复到迁移前 ----------
{
  const backend: Map<string, string> & { failNext?: boolean } = new Map()
  backend.failNext = true
  const win = createHarness(backend)
  const store = storeOf(win)
  const result = store.commitTreeMoves({ moves: moveInvToAr2(), windowName: '窗口A', forceWriteFailure: true })
  ok('写入失败时提交返回失败', !result.ok)
  ok('失败消息声明已恢复迁移前', result.message.includes('恢复到迁移前'))
  ok('设备树恢复：逆变器仍在1号方阵', store.equipment.find((n) => n.id === 'EQ-INV11')!.parentId === 'EQ-AR1')
  ok('树版本未推进', store.treeRevision === 1)
  ok('失败不残留变更集', store.changeSets.length === 0)
}

// ---------- 场景4：设备树变化后交付包失效，冲突清空后才能重签 ----------
function makeSignable(store: ReturnType<typeof storeOf>) {
  store.equipment.forEach((node) => node.items.forEach((item) => { item.status = '合格' }))
  store.defects.forEach((defect) => { defect.status = '已关闭' })
}

{
  const backend = new Map<string, string>()
  const win = createHarness(backend)
  const store = storeOf(win)
  makeSignable(store)
  const signed = store.signOff()
  ok('完整性满足时首次签署成功', signed.ok && store.plant.signedTreeRevision === 1 && store.plant.status === '已签署')

  const moved = store.commitTreeMoves({ moves: moveInvToAr2(), windowName: '窗口A' })
  ok('签署后迁移仍可合并', moved.ok && store.treeRevision === 2)
  ok('已签署交付包失效（状态标记为作废）', store.deliveryInvalid && store.plant.status === '已签署' && store.plant.signedTreeRevision === 1)

  // 无冲突且其余条件仍满足：可重新签署并锁定新树版本
  const resigned = store.signOff()
  ok('失效后可重新签署', resigned.ok && store.plant.signedTreeRevision === 2 && !store.deliveryInvalid)
}

// ---------- 场景5：冲突草稿存在时签署被阻断，清空后解除 ----------
{
  const backend = new Map<string, string>()
  const winA = createHarness(backend)
  const winB = createHarness(backend)
  const A = storeOf(winA)
  const B = storeOf(winB)
  A.commitTreeMoves({ moves: moveInvToAr2(), windowName: '窗口A' })
  B.commitTreeMoves({ moves: moveCbToAr2(), windowName: '窗口B' })
  makeSignable(B)
  const blocked = B.signOff()
  ok('冲突草稿存在时签署被阻断', !blocked.ok && blocked.message.includes('冲突草稿'))
  ok('preflight首条阻断为冲突清空提示', B.preflight.blocking[0].includes('清空后才能重新签署'))

  const discarded = B.discardConflict(B.conflictDrafts[0].id)
  ok('冲突草稿可清空', discarded.ok && B.conflictDrafts.length === 0)
  const afterClear = B.signOff()
  ok('清空冲突后签署成功', afterClear.ok && B.plant.signedTreeRevision === 2)
}

// ---------- 场景6：缺陷与审计按新树追查 ----------
{
  const backend = new Map<string, string>()
  const win = createHarness(backend)
  const store = storeOf(win)
  store.commitTreeMoves({ moves: moveInvToAr2(), windowName: '窗口A' })
  const defectAudit = store.audit.find((entry) => entry.entityId === 'EQ-INV11')
  ok('审计记录挂在稳定设备ID上', !!defectAudit && defectAudit.action === '设备迁移挂接')
  const defect = store.defects.find((d) => d.equipmentId === 'EQ-INV11')
  ok('缺陷仍指向同一设备ID（随新树追查，不残留旧方阵）', !!defect)
}

console.log(`\n全部 ${passed} 项 store 集成测试通过`)
