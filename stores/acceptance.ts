import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { seedAudit, seedDefects, seedEquipment, seedPlant } from '../data/seed'
import type { AcceptanceDefect, AcceptanceItem, AuditEntry, EquipmentNode, PartyReply, Plant, TreeChange, TreeMove } from '../types/domain'

const STORAGE_KEY = 'gsb67:grid-acceptance'
let idSeed = 30

/** 响应式 Proxy 不能直接 structuredClone，快照统一走 JSON 深拷贝 */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

interface SubmitInput {
  label: string
  operator: string
  reason: string
  windowId: string
  baseTreeVersion: number
  moves: TreeMove[]
}

export const useAcceptanceStore = defineStore('acceptance', () => {
  const plant = ref<Plant>(structuredClone(seedPlant))
  const equipment = ref<EquipmentNode[]>(structuredClone(seedEquipment))
  const defects = ref<AcceptanceDefect[]>(structuredClone(seedDefects))
  const audit = ref<AuditEntry[]>(structuredClone(seedAudit))
  const treeVersion = ref(1)
  const treeChanges = ref<TreeChange[]>([])
  const selectedEquipmentId = ref(equipment.value[0].id)
  const keyword = ref('')
  const hydrated = ref(false)
  /** 演示用：置位后下一次 persist 必然失败，用于验证写入失败后的整树恢复 */
  const failNextPersist = ref(false)

  const selectedEquipment = computed(() => equipment.value.find((item) => item.id === selectedEquipmentId.value))
  const conflictDrafts = computed(() => treeChanges.value.filter((item) => item.status === '冲突草稿'))
  const packageInvalidated = computed(() => plant.value.signedTreeVersion !== null && plant.value.signedTreeVersion !== treeVersion.value)

  const stats = computed(() => {
    const items = equipment.value.flatMap((item) => item.items)
    return {
      total: items.length,
      passed: items.filter((item) => item.status === '合格').length,
      failed: items.filter((item) => item.status === '不合格' || item.status === '待复验').length,
      openDefects: defects.value.filter((item) => !['已关闭', '带条件通过'].includes(item.status)).length
    }
  })
  const preflight = computed(() => {
    const blocking: string[] = []
    const items = equipment.value.flatMap((item) => item.items)
    if (items.some((item) => item.status === '待检查')) blocking.push('仍有验收项未检查')
    if (items.some((item) => item.status === '不合格' || item.status === '待复验')) blocking.push('存在不合格或待复验项')
    if (defects.value.some((item) => !['已关闭', '带条件通过'].includes(item.status))) blocking.push('存在未闭环缺陷')
    if (equipment.value.flatMap((item) => item.certificates).some((item) => !item.verified)) blocking.push('存在未核验证书')
    const expired = equipment.value.flatMap((item) => item.certificates).some((item) => item.expiresAt < plant.value.commissioningDate)
    if (expired) blocking.push('证书在并网日期前失效')
    if (conflictDrafts.value.length) blocking.push('存在未清空的设备树冲突草稿，清空后才能重新签署')
    // 已签署包失效不是完整性阻断：它正是本次签署要消除的状态（签署后 signedTreeVersion 刷新到当前树版本）
    return { allowed: blocking.length === 0, blocking }
  })

  function hydrate() {
    if (!import.meta.client || hydrated.value) return
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const stored = JSON.parse(raw)
        plant.value = stored.plant
        equipment.value = stored.equipment
        defects.value = stored.defects
        audit.value = stored.audit
        treeVersion.value = stored.treeVersion ?? 1
        treeChanges.value = stored.treeChanges ?? []
        if (plant.value.signedTreeVersion === undefined) plant.value.signedTreeVersion = null
      }
    } catch {
      // Seed data is kept when browser storage is corrupt.
    }
    hydrated.value = true
  }

  function persist() {
    if (!import.meta.client) return
    const payload = JSON.stringify({ plant: plant.value, equipment: equipment.value, defects: defects.value, audit: audit.value, treeVersion: treeVersion.value, treeChanges: treeChanges.value })
    if (failNextPersist.value) {
      failNextPersist.value = false
      throw new Error('模拟持久化失败：localStorage 写入被拒绝')
    }
    localStorage.setItem(STORAGE_KEY, payload)
  }

  /** 在指定树上收集 nodeId 的全部后代（含自身） */
  function subtreeIds(nodes: EquipmentNode[], nodeId: string): string[] {
    const result = [nodeId]
    for (const parent of result) {
      nodes.forEach((node) => { if (node.parentId === parent && !result.includes(node.id)) result.push(node.id) })
    }
    return result
  }

  /** 按当前（新）设备树追查设备的完整路径 */
  function pathOf(equipmentId: string): string[] {
    const path: string[] = []
    let current = equipment.value.find((node) => node.id === equipmentId)
    let guard = 0
    while (current && guard < 20) {
      path.unshift(current.name)
      current = current.parentId ? equipment.value.find((node) => node.id === current!.parentId) : undefined
      guard += 1
    }
    return path
  }

  /** 校验一整套挂接：同一设备只能出现一次、目标存在、不得形成环 */
  function validateMoves(moves: TreeMove[], nodes: EquipmentNode[]) {
    if (!moves.length) return '变更集为空，没有需要挂接的设备'
    const seen = new Set<string>()
    for (const move of moves) {
      const node = nodes.find((item) => item.id === move.equipmentId)
      if (!node) return `设备 ${move.equipmentId} 不存在`
      if (seen.has(move.equipmentId)) return `设备 ${node.name} 在同一变更集中只能有一个父节点`
      seen.add(move.equipmentId)
      if (move.targetParentId !== null) {
        const target = nodes.find((item) => item.id === move.targetParentId)
        if (!target) return `目标父节点 ${move.targetParentId} 不存在`
        if (target.id === move.equipmentId) return `不能把 ${node.name} 挂接到自身`
        if (subtreeIds(nodes, move.equipmentId).includes(target.id)) return `不能把 ${node.name} 挂接到自己的子节点 ${target.name}`
      }
    }
    // 同一棵子树的节点不能分别挂接（否则破坏“整套迁移”语义）
    for (let i = 0; i < moves.length; i += 1) {
      for (let j = i + 1; j < moves.length; j += 1) {
        const a = subtreeIds(nodes, moves[i].equipmentId)
        if (a.includes(moves[j].equipmentId)) {
          return `设备 ${moves[j].equipmentId} 已包含在 ${moves[i].equipmentId} 的子树迁移中，不能重复挂接`
        }
      }
    }
    return ''
  }

  /** 与基线之后已应用的变更做触碰集比对；返回冲突原因，空串表示可合并 */
  function conflictReason(change: SubmitInput, touched: string[]): string {
    if (change.baseTreeVersion > treeVersion.value) return `基线版本V${change.baseTreeVersion}高于当前树版本V${treeVersion.value}`
    const concurrent = treeChanges.value.filter((item) => item.status === '已应用' && (item.appliedTreeVersion ?? 0) > change.baseTreeVersion)
    for (const applied of concurrent) {
      const overlap = applied.touchedNodeIds.filter((id) => touched.includes(id))
      if (overlap.length) {
        const names = overlap.map((id) => equipment.value.find((node) => node.id === id)?.name ?? id).join('、')
        return `窗口${applied.windowId}的变更 ${applied.label} 已先行挂接（${names}），同一设备只能保留一个父节点`
      }
      // 本变更的目标父位落在对方迁走的子树内，合并会改变先到变更的结构
      const movedAway = applied.moves.filter((move) => touched.includes(move.equipmentId))
      if (movedAway.length) return `变更依赖窗口${applied.windowId}已迁移的节点，需按新树重新定位`
    }
    return ''
  }

  function buildChange(input: SubmitInput, status: TreeChange['status'], snapshot: EquipmentNode[], reason: string, conflictWith: string | null): TreeChange {
    const touched = Array.from(new Set(input.moves.flatMap((move) => subtreeIds(snapshot, move.equipmentId))))
    return {
      id: `TC-${Date.now()}-${idSeed++}`,
      label: input.label,
      operator: input.operator,
      reason: input.reason,
      windowId: input.windowId,
      baseTreeVersion: input.baseTreeVersion,
      status,
      moves: input.moves.map((move) => ({ ...move })),
      touchedNodeIds: touched,
      occupiedParentIds: Array.from(new Set(input.moves.map((move) => move.targetParentId))),
      appliedTreeVersion: status === '已应用' ? treeVersion.value : null,
      conflictWith,
      conflictReason: reason,
      createdAt: new Date().toISOString(),
      appliedAt: status === '已应用' ? new Date().toISOString() : null,
      treeSnapshotAtSubmit: status === '冲突草稿' ? deepClone(snapshot) : null
    }
  }

  /**
   * 原子提交一整套设备树变更：
   * - 校验通过且无并发触碰冲突 → 整体应用，迁移连同子节点、验收项与证书
   * - 冲突 → 活树不变，整套变更留为冲突草稿（保留提交时快照）
   * - 持久化失败 → 恢复到迁移前，调用方按失败处理
   */
  function submitTreeChange(input: SubmitInput): { ok: boolean; message: string; changeId?: string } {
    const validationError = validateMoves(input.moves, equipment.value)
    if (validationError) return { ok: false, message: validationError }

    const preSnapshot = deepClone(equipment.value)
    const touched = Array.from(new Set(input.moves.flatMap((move) => subtreeIds(preSnapshot, move.equipmentId))))
    const conflict = conflictReason(input, touched)
    if (conflict) {
      const draft = buildChange(input, '冲突草稿', preSnapshot, conflict, treeChanges.value.find((item) => item.status === '已应用' && (item.appliedTreeVersion ?? 0) > input.baseTreeVersion)?.id ?? null)
      treeChanges.value.unshift(draft)
      try { persist() } catch { treeChanges.value.shift() }
      return { ok: false, message: `变更存在冲突，已整套留为冲突草稿：${conflict}`, changeId: draft.id }
    }

    // 应用挂接：只重写迁移根的 parentId，子节点相对关系不变，验收项/证书随节点整体归属目标方阵
    input.moves.forEach((move) => {
      const node = equipment.value.find((item) => item.id === move.equipmentId)
      if (node) node.parentId = move.targetParentId
    })
    treeVersion.value += 1

    const wasSigned = plant.value.status === '已签署'
    if (wasSigned) {
      plant.value.status = '待复核'
      plant.value.version += 1
    }

    const applied = buildChange(input, '已应用', preSnapshot, '', null)
    treeChanges.value.unshift(applied)

    const moveText = input.moves.map((move) => {
      const name = preSnapshot.find((node) => node.id === move.equipmentId)?.name
      const targetName = move.targetParentId ? preSnapshot.find((node) => node.id === move.targetParentId)?.name : '根节点'
      return `${name}（含子树、验收项与证书）→ ${targetName}`
    }).join('；')

    log('TREE', '设备树变更挂接', input.operator, `${input.label}：${moveText}；树版本V${treeVersion.value}`)
    if (wasSigned) log(plant.value.id, '交付包失效', input.operator, `设备树变更后V${plant.value.signedTreeVersion}签署包失效，按新树V${treeVersion.value}追查并需重新签署`)

    try {
      persist()
    } catch (error) {
      // 写入失败：回滚 parentId、树版本、签署状态、变更记录与审计，恢复到迁移前
      equipment.value = preSnapshot
      treeVersion.value -= 1
      treeChanges.value.shift()
      audit.value.splice(0, wasSigned ? 2 : 1)
      if (wasSigned) {
        plant.value.status = '已签署'
        plant.value.version -= 1
      }
      return { ok: false, message: `写入失败，已恢复到迁移前：${(error as Error).message}` }
    }

    return { ok: true, message: `变更已合并，设备树升级至V${treeVersion.value}`, changeId: applied.id }
  }

  /** 冲突草稿按当前新树重算：无冲突则整套补挂，仍冲突则继续保留草稿 */
  function retryConflictDraft(changeId: string): { ok: boolean; message: string } {
    const draft = treeChanges.value.find((item) => item.id === changeId)
    if (!draft || draft.status !== '冲突草稿') return { ok: false, message: '冲突草稿不存在' }
    const rebase: SubmitInput = {
      label: `${draft.label}（冲突后重提）`,
      operator: draft.operator,
      reason: draft.reason,
      windowId: draft.windowId,
      baseTreeVersion: treeVersion.value,
      moves: draft.moves.map((move) => ({
        equipmentId: move.equipmentId,
        fromParentId: equipment.value.find((node) => node.id === move.equipmentId)?.parentId ?? null,
        targetParentId: move.targetParentId
      }))
    }
    if (!rebase.moves.every((move) => equipment.value.some((node) => node.id === move.equipmentId))) {
      return { ok: false, message: '草稿涉及设备已不存在，不能重提，请放弃后重新编排' }
    }
    const result = submitTreeChange(rebase)
    if (result.ok) {
      draft.status = '已应用'
      draft.conflictReason = ''
      draft.treeSnapshotAtSubmit = null
      persist()
    }
    return result
  }

  /** 放弃冲突草稿；冲突清空是重新签署的前置条件 */
  function discardConflictDraft(changeId: string) {
    const index = treeChanges.value.findIndex((item) => item.id === changeId && item.status === '冲突草稿')
    if (index < 0) return
    const [draft] = treeChanges.value.splice(index, 1)
    log('TREE', '清空冲突草稿', draft.operator, `${draft.label}：${draft.conflictReason}`)
    persist()
  }

  /** 演示“两个窗口同时提交”：同一基线上编排两套触碰同一子树的挂接 */
  function simulateConcurrentWindows(): { first: string; second: string } {
    const inv = equipment.value.find((node) => node.id === 'EQ-INV11')
    if (!inv) throw new Error('演示数据缺失')
    const base = treeVersion.value
    const windowA: SubmitInput = {
      label: '窗口A：1-1逆变器改挂2号方阵', operator: '窗口A-建设单位', reason: '方阵拆分验收，按实际组串归属调整', windowId: 'A',
      baseTreeVersion: base,
      moves: [{ equipmentId: 'EQ-INV11', fromParentId: inv.parentId, targetParentId: 'EQ-AR2' }]
    }
    const first = submitTreeChange(windowA)
    const windowB: SubmitInput = {
      label: '窗口B：1-1逆变器改挂1号方阵并改组', operator: '窗口B-运维单位', reason: '另一窗口未刷新树即提交改组', windowId: 'B',
      baseTreeVersion: base,
      moves: [{ equipmentId: 'EQ-INV11', fromParentId: inv.parentId, targetParentId: 'EQ-AR1' }]
    }
    const second = submitTreeChange(windowB)
    return { first: first.message, second: second.message }
  }

  function updateItem(equipmentId: string, itemId: string, patch: Partial<AcceptanceItem>) {
    const item = equipment.value.find((node) => node.id === equipmentId)?.items.find((value) => value.id === itemId)
    if (!item) return
    Object.assign(item, patch, { version: item.version + 1 })
    log(equipmentId, '更新验收项', '当前用户', `${item.id}状态更新为${item.status}（新树路径：${pathOf(equipmentId).join(' / ')}）`)
    persist()
  }

  function assignDefect(id: string, owner: string) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return
    defect.owner = owner
    defect.status = '整改中'
    defect.version += 1
    log(id, '分派缺陷', '验收负责人', `责任方调整为${owner}（按新树追查：${pathOf(defect.equipmentId).join(' / ')}）`)
    persist()
  }

  function addReply(id: string, reply: PartyReply) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect || !reply.content || !reply.evidence) return { ok: false, message: '回复内容和证据均不能为空' }
    defect.replies.unshift(reply)
    defect.status = '待联合复验'
    defect.version += 1
    log(id, `${reply.party}提交处理说明`, reply.owner, `${reply.content}（设备路径：${pathOf(defect.equipmentId).join(' / ')}）`)
    persist()
    return { ok: true, message: '已提交处理说明并进入联合复验' }
  }

  function addRetest(id: string, result: string, passed: boolean) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return
    defect.retests.unshift({ round: defect.retests.length + 1, passed, result, tester: '联合验收组', testedAt: new Date().toISOString() })
    defect.status = passed ? '已关闭' : '整改中'
    defect.version += 1
    log(id, '执行联合复验', '联合验收组', `${result}（按新树追查：${pathOf(defect.equipmentId).join(' / ')}）`)
    persist()
  }

  function decideDefect(id: string, status: '已关闭' | '带条件通过' | '整改中', note: string) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    if (status === '已关闭' && !defect.retests.some((item) => item.passed)) return { ok: false, message: '没有合格复验记录，不能关闭' }
    if (status === '带条件通过' && !note.trim()) return { ok: false, message: '带条件通过必须说明限制条件' }
    defect.status = status
    defect.decisionNote = note
    defect.version += 1
    log(id, `验收决定：${status}`, '验收负责人', `${note || '完成整改闭环'}（设备路径：${pathOf(defect.equipmentId).join(' / ')}）`)
    persist()
    return { ok: true, message: `缺陷已更新为${status}` }
  }

  function signOff() {
    if (!preflight.value.allowed) return { ok: false, message: preflight.value.blocking.join('；') }
    plant.value.status = '已签署'
    plant.value.version += 1
    plant.value.signedTreeVersion = treeVersion.value
    equipment.value.forEach((node) => { node.status = '已验收' })
    log(plant.value.id, '签署交付版本', '验收负责人陆川', `锁定V${plant.value.version}并生成交付包，设备树基线V${treeVersion.value}`)
    persist()
    return { ok: true, message: '签署完成，交付版本已锁定' }
  }

  function reset() {
    plant.value = structuredClone(seedPlant)
    equipment.value = structuredClone(seedEquipment)
    defects.value = structuredClone(seedDefects)
    audit.value = structuredClone(seedAudit)
    treeVersion.value = 1
    treeChanges.value = []
    persist()
  }

  function log(entityId: string, action: string, operator: string, detail: string) {
    audit.value.unshift({ id: `AUD-${Date.now()}-${idSeed++}`, entityId, action, operator, detail, createdAt: new Date().toISOString() })
  }

  return {
    plant, equipment, defects, audit, treeVersion, treeChanges, selectedEquipmentId, keyword, hydrated, failNextPersist,
    selectedEquipment, conflictDrafts, packageInvalidated, stats, preflight,
    hydrate, persist, subtreeIds, pathOf, validateMoves, submitTreeChange, retryConflictDraft, discardConflictDraft, simulateConcurrentWindows,
    updateItem, assignDefect, addReply, addRetest, decideDefect, signOff, reset
  }
})
