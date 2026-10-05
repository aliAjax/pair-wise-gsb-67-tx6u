import assert from 'node:assert/strict'
import { seedEquipment } from '../data/seed'
import { applyMoves, checkTreeInvariants, collectSubtree, pathOf, previewMoveImpact, validateChangeSet, validateMove } from '../services/treeChanges'
import { deepClone } from '../services/clone'
import type { EquipmentNode, TreeMove } from '../types/domain'

let passed = 0
const ok = (name: string, cond: boolean) => { assert.ok(cond, name); passed++; console.log('✔', name) }

// 1. 基本迁移：逆变器 EQ-INV11（含汇流箱子节点）从1号方阵迁到2号方阵
let nodes = deepClone(seedEquipment)
const move: TreeMove = { nodeId: 'EQ-INV11', nodeName: '1-1号逆变器', fromParentId: 'EQ-AR1', toParentId: 'EQ-AR2', reason: '拆分方阵' }
ok('基本迁移校验通过', validateMove(nodes, move).ok)
const impact = previewMoveImpact(nodes, 'EQ-INV11')!
ok('子树含逆变器+汇流箱共2台', impact.subtreeCount === 2)
ok('带走3项验收项(逆变器2+汇流箱1)', impact.itemCount === 3)
ok('带走1份证书', impact.certificateCount === 1)
const affected = applyMoves(nodes, [move])
ok('应用后逆变器父节点为2号方阵', nodes.find((n) => n.id === 'EQ-INV11')!.parentId === 'EQ-AR2')
ok('子节点汇流箱仍挂在逆变器下（连同子节点迁移）', nodes.find((n) => n.id === 'EQ-CB111')!.parentId === 'EQ-INV11')
ok('受影响集合含子孙节点', affected.map((n) => n.id).sort().join() === 'EQ-CB111,EQ-INV11')
ok('迁移后不变量通过', checkTreeInvariants(nodes).ok)
ok('新路径在2号方阵下', pathOf(nodes, 'EQ-INV11').includes('2号方阵'))
ok('旧路径不再包含逆变器', !pathOf(nodes, 'EQ-INV11').includes('1号方阵'))

// 2. 目标必须是方阵
ok('挂到变压器被拒', !validateMove(deepClone(seedEquipment), { ...move, toParentId: 'EQ-TR1' }).ok)
// 方阵本身不可迁移
ok('迁移方阵被拒', !validateMove(deepClone(seedEquipment), { nodeId: 'EQ-AR1', nodeName: '1号方阵', fromParentId: 'EQ-TR1', toParentId: 'EQ-GRID', reason: 'x' }).ok)
// 同位置迁移
ok('原地迁移被拒', !validateMove(deepClone(seedEquipment), { ...move, toParentId: 'EQ-AR1' }).ok)
// 缺原因
ok('缺少改组原因被拒', !validateMove(deepClone(seedEquipment), { ...move, reason: '  ' }).ok)
// 单父节点：同一变更集内重复迁移同一设备
ok('同一设备在变更集内迁移两次被拒', !validateChangeSet(deepClone(seedEquipment), [move, { ...move, toParentId: 'EQ-AR1' }]).ok)

// 3. 环检测：试图把汇流箱挂到... 先把逆变器挂到汇流箱下（目标非方阵先被拒），
//    构造临时坏树直接验证不变量
const cyclic: EquipmentNode[] = deepClone(seedEquipment)
cyclic.find((n) => n.id === 'EQ-GRID')!.parentId = 'EQ-CB111'
ok('成环树不变量失败', !checkTreeInvariants(cyclic).ok)
const orphan: EquipmentNode[] = deepClone(seedEquipment)
orphan.find((n) => n.id === 'EQ-CB111')!.parentId = 'EQ-NOPE'
ok('孤儿节点不变量失败', !checkTreeInvariants(orphan).ok)
const twoRoots: EquipmentNode[] = deepClone(seedEquipment)
twoRoots.find((n) => n.id === 'EQ-TR1')!.parentId = null
ok('两个根节点不变量失败', !checkTreeInvariants(twoRoots).ok)

// 4. 多步成套迁移：先把汇流箱挂到2号方阵（脱离逆变器），两步在一个工作树上连续应用
nodes = deepClone(seedEquipment)
const set: TreeMove[] = [
  { nodeId: 'EQ-CB111', nodeName: '1-1-1汇流箱', fromParentId: 'EQ-INV11', toParentId: 'EQ-AR2', reason: '汇流箱改划2号方阵' },
  { nodeId: 'EQ-INV11', nodeName: '1-1号逆变器', fromParentId: 'EQ-AR1', toParentId: 'EQ-AR2', reason: '逆变器改划2号方阵' }
]
ok('成套多步迁移校验通过', validateChangeSet(nodes, set).ok)
applyMoves(nodes, set)
ok('汇流箱直接挂2号方阵', nodes.find((n) => n.id === 'EQ-CB111')!.parentId === 'EQ-AR2')
ok('逆变器挂2号方阵', nodes.find((n) => n.id === 'EQ-INV11')!.parentId === 'EQ-AR2')
ok('成套迁移后不变量通过', checkTreeInvariants(nodes).ok)

// 5. collectSubtree 根节点覆盖整树
ok('从并网点收集到全部6个节点', collectSubtree(deepClone(seedEquipment), 'EQ-GRID').length === seedEquipment.length)

console.log(`\n全部 ${passed} 项纯逻辑测试通过`)
