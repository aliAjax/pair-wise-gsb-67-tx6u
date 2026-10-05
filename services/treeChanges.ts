import type { EquipmentNode, TreeChangeSet, TreeMove } from '../types/domain'
import { deepClone } from './clone'

export interface ValidationResult {
  ok: boolean
  message: string
}

/** 收集节点的全部后代（含自身），按深度优先顺序 */
export function collectSubtree(nodes: EquipmentNode[], rootId: string): EquipmentNode[] {
  const result: EquipmentNode[] = []
  const walk = (id: string) => {
    const node = nodes.find((item) => item.id === id)
    if (!node) return
    result.push(node)
    nodes.filter((item) => item.parentId === id).forEach((child) => walk(child.id))
  }
  walk(rootId)
  return result
}

/**
 * 从某节点向上追溯祖先链（含自身）。
 * chain 末尾 parentId 为 null 表示可达根；visited 中重复或找不到节点表示断链/成环。
 */
export function ancestorChain(nodes: EquipmentNode[], nodeId: string) {
  const chain: EquipmentNode[] = []
  const visited = new Set<string>()
  let current: string | null = nodeId
  while (current !== null) {
    if (visited.has(current)) return { chain, reachesRoot: false, reason: '祖先链出现环路' as const }
    visited.add(current)
    const node = nodes.find((item) => item.id === current)
    if (!node) return { chain, reachesRoot: false, reason: '父节点缺失' as const }
    chain.push(node)
    current = node.parentId
  }
  return { chain, reachesRoot: true, reason: null }
}

/** 收集节点的全部祖先 ID（含自身） */
export function collectAncestors(nodes: EquipmentNode[], nodeId: string): Set<string> {
  return new Set(ancestorChain(nodes, nodeId).chain.map((node) => node.id))
}

/** 校验单步迁移：同一设备只能有一个父节点；目标必须是方阵且不能在迁移子树内 */
export function validateMove(nodes: EquipmentNode[], move: TreeMove, existingNodeIds: string[] = []): ValidationResult {
  if (existingNodeIds.includes(move.nodeId)) return { ok: false, message: `设备${move.nodeName}在同一变更集中只能迁移一次（单父节点约束）` }
  const node = nodes.find((item) => item.id === move.nodeId)
  if (!node) return { ok: false, message: `设备${move.nodeName}(${move.nodeId})已不存在` }
  if (!move.toParentId) return { ok: false, message: `设备${move.nodeName}必须指定目标方阵` }
  if (move.toParentId === node.parentId) return { ok: false, message: `设备${move.nodeName}已在目标方阵下，无需迁移` }
  const target = nodes.find((item) => item.id === move.toParentId)
  if (!target) return { ok: false, message: `目标方阵(${move.toParentId})不存在` }
  if (target.type !== '方阵') return { ok: false, message: `验收拆分/改组只能挂接到方阵，${target.name}不是方阵` }
  if (node.type === '方阵') return { ok: false, message: `方阵${node.name}为顶层划分，不在本次改组范围内` }
  // 目标位于待迁移子树（含节点自身）时会形成环
  if (collectSubtree(nodes, node.id).some((item) => item.id === move.toParentId)) {
    return { ok: false, message: `不能把${node.name}挂接到它自己或其子节点下` }
  }
  if (!move.reason.trim()) return { ok: false, message: `设备${node.name}的迁移必须填写拆分/改组原因` }
  return { ok: true, message: '' }
}

/** 成套校验：先按给定顺序校验每一步，再在临时树上连续应用，保证整套变更可合并 */
export function validateChangeSet(nodes: EquipmentNode[], moves: TreeMove[]): ValidationResult {
  if (!moves.length) return { ok: false, message: '变更集为空，没有需要合并的迁移' }
  const working = deepClone(nodes)
  const touched: string[] = []
  for (const move of moves) {
    const result = validateMove(working, move, touched)
    if (!result.ok) return result
    const node = working.find((item) => item.id === move.nodeId)
    if (node) node.parentId = move.toParentId
    touched.push(move.nodeId)
  }
  const invariant = checkTreeInvariants(working)
  if (!invariant.ok) return invariant
  return { ok: true, message: '' }
}

/** 迁移后不变量：唯一根、无环、节点唯一、每个设备恰好一个父节点 */
export function checkTreeInvariants(nodes: EquipmentNode[]): ValidationResult {
  const ids = new Set<string>()
  for (const node of nodes) {
    if (ids.has(node.id)) return { ok: false, message: `设备${node.id}在树中重复出现` }
    ids.add(node.id)
  }
  const roots = nodes.filter((node) => node.parentId === null)
  if (roots.length !== 1) return { ok: false, message: `设备树必须恰好有一个根节点，当前为${roots.length}个` }
  for (const node of nodes) {
    if (node.parentId !== null && !ids.has(node.parentId)) return { ok: false, message: `设备${node.name}的父节点${node.parentId}不存在（孤儿节点）` }
    const trace = ancestorChain(nodes, node.id)
    if (!trace.reachesRoot) return { ok: false, message: `设备${node.name}${trace.reason === '祖先链出现环路' ? '的祖先链存在环路' : '无法追溯到有效父节点'}` }
    if (trace.chain[trace.chain.length - 1].id !== roots[0].id) return { ok: false, message: `设备${node.name}无法追溯到并网点根节点` }
  }
  return { ok: true, message: '' }
}

/** 把变更集应用到设备树（原地修改），返回受影响子树节点（含子孙） */
export function applyMoves(nodes: EquipmentNode[], moves: TreeMove[]): EquipmentNode[] {
  const affected = new Map<string, EquipmentNode>()
  for (const move of moves) {
    const subtree = collectSubtree(nodes, move.nodeId)
    subtree.forEach((node) => affected.set(node.id, node))
    const node = nodes.find((item) => item.id === move.nodeId)
    if (node) node.parentId = move.toParentId
  }
  return [...affected.values()]
}

export interface MoveImpact {
  node: EquipmentNode
  subtreeCount: number
  itemCount: number
  certificateCount: number
}

/** 预览一步迁移连同子节点带走的设备、验收项与证书数量 */
export function previewMoveImpact(nodes: EquipmentNode[], nodeId: string): MoveImpact | null {
  const subtree = collectSubtree(nodes, nodeId)
  const node = subtree[0]
  if (!node) return null
  return {
    node,
    subtreeCount: subtree.length,
    itemCount: subtree.reduce((sum, item) => sum + item.items.length, 0),
    certificateCount: subtree.reduce((sum, item) => sum + item.certificates.length, 0)
  }
}

/** 生成设备在当前树中的路径名，缺陷与审计按新树追查时使用 */
export function pathOf(nodes: EquipmentNode[], nodeId: string | null | undefined): string {
  if (!nodeId) return '—'
  const chain: string[] = []
  let current: string | null = nodeId
  const guard = new Set<string>()
  while (current && !guard.has(current)) {
    guard.add(current)
    const node = nodes.find((item) => item.id === current)
    if (!node) break
    chain.unshift(node.name)
    current = node.parentId
  }
  return chain.length ? chain.join(' / ') : '—'
}

export function describeChangeSet(change: TreeChangeSet): string {
  return change.moves.map((move) => `${move.nodeName}→${move.toParentId}`).join('，')
}
