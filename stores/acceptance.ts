import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { seedAudit, seedDefects, seedEquipment, seedPlant } from '../data/seed'
import { applyMoves, checkTreeInvariants, describeChangeSet, previewMoveImpact, validateChangeSet } from '../services/treeChanges'
import { deepClone } from '../services/clone'
import type { AcceptanceDefect, AcceptanceItem, AuditEntry, EquipmentNode, PartyReply, Plant, TreeChangeSet, TreeMove } from '../types/domain'

const STORAGE_KEY = 'gsb67:grid-acceptance'
const INITIAL_REVISION = 1
let idSeed = 30

// Nuxt 构建下 import.meta.client 为布尔字面量；Node 测试环境下按 localStorage 是否存在判定
const isClient = () => Boolean((import.meta as { client?: boolean }).client) || typeof localStorage !== 'undefined'

interface PersistedState {
  plant: Plant
  equipment: EquipmentNode[]
  defects: AcceptanceDefect[]
  audit: AuditEntry[]
  treeRevision: number
  changeSets: TreeChangeSet[]
}

export interface CommitTreeInput {
  moves: TreeMove[]
  windowName: string
  // 仅用于演示：强制让提交在写入阶段失败，验证回滚到迁移前
  forceWriteFailure?: boolean
}

export interface CommitResult {
  ok: boolean
  message: string
  changeSetId?: string
}

export const useAcceptanceStore = defineStore('acceptance', () => {
  const plant = ref<Plant>(deepClone(seedPlant))
  const equipment = ref<EquipmentNode[]>(deepClone(seedEquipment))
  const defects = ref<AcceptanceDefect[]>(deepClone(seedDefects))
  const audit = ref<AuditEntry[]>(deepClone(seedAudit))
  const treeRevision = ref(INITIAL_REVISION)
  const changeSets = ref<TreeChangeSet[]>([])
  const selectedEquipmentId = ref(equipment.value[0].id)
  const keyword = ref('')
  const hydrated = ref(false)

  const conflictDrafts = computed(() => changeSets.value.filter((item) => item.status === '冲突草稿'))
  const mergedChanges = computed(() => changeSets.value.filter((item) => item.status === '已合并'))
  // 已签署交付包锁定的树版本与当前树不一致，即设备树调整后交付包失效（状态仍为已签署但已作废）
  const deliveryInvalid = computed(() => plant.value.signedTreeRevision !== null && plant.value.signedTreeRevision !== treeRevision.value)

  const selectedEquipment = computed(() => equipment.value.find((item) => item.id === selectedEquipmentId.value))
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
    if (conflictDrafts.value.length) blocking.push(`存在${conflictDrafts.value.length}套设备树冲突草稿，清空后才能重新签署`)
    if (items.some((item) => item.status === '待检查')) blocking.push('仍有验收项未检查')
    if (items.some((item) => item.status === '不合格' || item.status === '待复验')) blocking.push('存在不合格或待复验项')
    if (defects.value.some((item) => !['已关闭', '带条件通过'].includes(item.status))) blocking.push('存在未闭环缺陷')
    if (equipment.value.flatMap((item) => item.certificates).some((item) => !item.verified)) blocking.push('存在未核验证书')
    const expired = equipment.value.flatMap((item) => item.certificates).some((item) => item.expiresAt < plant.value.commissioningDate)
    if (expired) blocking.push('证书在并网日期前失效')
    return { allowed: blocking.length === 0, blocking }
  })

  function readPersisted(): PersistedState | null {
    if (!isClient()) return null
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? JSON.parse(raw) as PersistedState : null
    } catch {
      return null
    }
  }

  function adoptState(stored: Partial<PersistedState>) {
    if (stored.plant) plant.value = { ...stored.plant, signedTreeRevision: stored.plant.signedTreeRevision ?? null }
    if (stored.equipment) equipment.value = stored.equipment
    if (stored.defects) defects.value = stored.defects
    if (stored.audit) audit.value = stored.audit
    if (typeof stored.treeRevision === 'number') treeRevision.value = stored.treeRevision
    changeSets.value = stored.changeSets ?? []
  }

  function snapshot(): PersistedState {
    return {
      plant: deepClone(plant.value),
      equipment: deepClone(equipment.value),
      defects: deepClone(defects.value),
      audit: deepClone(audit.value),
      treeRevision: treeRevision.value,
      changeSets: deepClone(changeSets.value)
    }
  }

  function hydrate() {
    if (!isClient() || hydrated.value) return
    const stored = readPersisted()
    if (stored) adoptState(stored)
    hydrated.value = true
    // 另一窗口提交时，本窗口通过 storage 事件实时采纳先到窗口的挂接结果
    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return
      try {
        adoptState(JSON.parse(event.newValue) as PersistedState)
      } catch {
        // 共享存储内容损坏时保留本窗口内存状态
      }
    })
  }

  function persist() {
    if (!isClient()) return
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      plant: plant.value,
      equipment: equipment.value,
      defects: defects.value,
      audit: audit.value,
      treeRevision: treeRevision.value,
      changeSets: changeSets.value
    } satisfies PersistedState))
  }

  function log(entityId: string, action: string, operator: string, detail: string) {
    audit.value.unshift({ id: `AUD-${Date.now()}-${idSeed++}`, entityId, action, operator, detail, createdAt: new Date().toISOString() })
  }

  /**
   * 合并提交一套设备树变更。
   * 先重读共享存储做并发判定：先到窗口的挂接保留，后到的整套变更原样留为冲突草稿；
   * 迁移阶段采用“快照→应用→不变量校验→写入”，任一步失败恢复到迁移前。
   */
  function commitTreeMoves(input: CommitTreeInput): CommitResult {
    if (!isClient()) return { ok: false, message: '仅浏览器端可提交设备树变更' }
    const startedAt = new Date().toISOString()
    const changeId = `TC-${Date.now()}-${idSeed++}`
    const windowName = input.windowName.trim() || '验收窗口'
    const baseRevision = treeRevision.value

    const structural = validateChangeSet(equipment.value, input.moves)
    if (!structural.ok) return { ok: false, message: structural.message }

    const remote = readPersisted()
    const remoteRevision = remote?.treeRevision ?? baseRevision

    // 共享树已被其他窗口推进：先到挂接保留，本套变更整体留冲突草稿（不做半步应用）
    if (remote && remoteRevision !== baseRevision) {
      const preConflict = snapshot()
      adoptState(remote)
      const draft: TreeChangeSet = {
        id: changeId, windowName, baseRevision, finalRevision: null, status: '冲突草稿',
        moves: deepClone(input.moves),
        conflictReason: `本窗口基线为V${baseRevision}，共享设备树已由先到窗口推进到V${remoteRevision}；先到挂接已保留，本套变更需按新树重算或清空`,
        resolvedNote: '', createdAt: startedAt, mergedAt: null
      }
      const recheck = validateChangeSet(equipment.value, draft.moves)
      if (!recheck.ok) draft.conflictReason += `；按新树校验：${recheck.message}`
      changeSets.value.unshift(draft)
      log(draft.id, '设备树变更并发冲突', windowName, `基线V${baseRevision}落后于V${remoteRevision}，整套变更留冲突草稿：${describeChangeSet(draft)}`)
      try {
        persist()
      } catch {
        adoptState(preConflict)
        return { ok: false, message: '冲突草稿写入失败，已恢复到迁移前状态' }
      }
      return { ok: false, message: `另一窗口已先提交（V${remoteRevision}），先到挂接保留；本套变更已整体留为冲突草稿`, changeSetId: draft.id }
    }

    // 同版本下也以共享存储为准，避免覆盖其他窗口对缺陷/审计的写入
    if (remote) adoptState(remote)
    const preMigration = snapshot()

    try {
      const details = input.moves.map((move) => {
        const impact = previewMoveImpact(equipment.value, move.nodeId)
        const fromName = equipment.value.find((node) => node.id === move.fromParentId)?.name ?? '原挂接点'
        const toName = equipment.value.find((node) => node.id === move.toParentId)?.name ?? move.toParentId
        const node = equipment.value.find((item) => item.id === move.nodeId)
        if (!node) throw new Error(`待迁移设备${move.nodeName}不存在`)
        node.parentId = move.toParentId
        return { move, impact, fromName, toName }
      })

      const invariant = checkTreeInvariants(equipment.value)
      if (!invariant.ok) throw new Error(invariant.message)
      if (input.forceWriteFailure) throw new Error('存储写入失败（演示）')

      const finalRevision = treeRevision.value + 1
      treeRevision.value = finalRevision
      const change: TreeChangeSet = {
        id: changeId, windowName, baseRevision, finalRevision, status: '已合并',
        moves: deepClone(input.moves), conflictReason: '', resolvedNote: '',
        createdAt: startedAt, mergedAt: new Date().toISOString()
      }
      changeSets.value.unshift(change)

      const signedRevision = plant.value.signedTreeRevision
      details.forEach(({ move, impact, fromName, toName }) => {
        log(move.nodeId, '设备迁移挂接', windowName,
          `${move.nodeName}由${fromName}迁移至${toName}（连同子树${impact?.subtreeCount ?? 0}台、验收项${impact?.itemCount ?? 0}项、证书${impact?.certificateCount ?? 0}份）；原因：${move.reason}`)
      })
      log(change.id, '设备树变更合并', windowName, `V${baseRevision}→V${finalRevision}，${details.length}步迁移成套合并：${describeChangeSet(change)}`)
      if (signedRevision !== null && signedRevision !== finalRevision) {
        log(plant.value.id, '交付包失效', windowName, `已签署交付包锁定设备树V${signedRevision}，设备树已变更到V${finalRevision}，冲突清空并重新校验前不得签署`)
      }
      persist()
      const invalidated = signedRevision !== null && signedRevision !== finalRevision
      return {
        ok: true,
        changeSetId: change.id,
        message: invalidated
          ? `设备树变更已合并到V${finalRevision}；已签署交付包随新树失效，缺陷与审计改按新树追查，冲突清空后方可重新签署`
          : `设备树变更已成套合并到V${finalRevision}`
      }
    } catch (error) {
      adoptState(preMigration)
      return { ok: false, message: `合并失败，设备树已恢复到迁移前：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** 按当前新树重算冲突草稿；新树下仍不成立则保留草稿并更新原因，失败同样回滚 */
  function rebaseConflict(changeSetId: string): CommitResult {
    const exists = changeSets.value.some((item) => item.id === changeSetId && item.status === '冲突草稿')
    if (!exists) return { ok: false, message: '冲突草稿不存在或已清空' }
    // 先采纳共享存储中的最新状态，再定位草稿，避免持有被替换掉的旧对象引用
    const remote = readPersisted()
    if (remote) adoptState(remote)
    const draft = changeSets.value.find((item) => item.id === changeSetId && item.status === '冲突草稿')
    if (!draft) return { ok: false, message: '冲突草稿已被其他窗口清空' }
    const preMigration = snapshot()

    const validation = validateChangeSet(equipment.value, draft.moves)
    if (!validation.ok) {
      draft.conflictReason = `按V${treeRevision.value}新树重算失败：${validation.message}`
      persist()
      return { ok: false, message: `按新树仍无法合并：${validation.message}` }
    }

    try {
      const baseRevision = treeRevision.value
      const affected = applyMoves(equipment.value, draft.moves)
      const invariant = checkTreeInvariants(equipment.value)
      if (!invariant.ok) throw new Error(invariant.message)

      const finalRevision = treeRevision.value + 1
      treeRevision.value = finalRevision
      draft.status = '已合并'
      draft.finalRevision = finalRevision
      draft.mergedAt = new Date().toISOString()
      draft.resolvedNote = `按V${baseRevision}新树重算后合并为V${finalRevision}`

      affected.forEach((node) => log(node.id, '冲突草稿重算合并', draft.windowName, `设备${node.name}在冲突清空后挂接到新父节点${node.parentId}`))
      log(draft.id, '冲突草稿合并', draft.windowName, `V${baseRevision}→V${finalRevision}：${describeChangeSet(draft)}`)
      const signedRevision = plant.value.signedTreeRevision
      if (signedRevision !== null && signedRevision !== finalRevision) {
        log(plant.value.id, '交付包失效', draft.windowName, `重算合并使设备树变更到V${finalRevision}，已签署交付包（V${signedRevision}）失效`)
      }
      persist()
      return { ok: true, changeSetId: draft.id, message: `冲突草稿已按新树重算并合并到V${finalRevision}` }
    } catch (error) {
      adoptState(preMigration)
      return { ok: false, message: `重算失败，已恢复到操作前：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** 清空（放弃）冲突草稿；清空后签署阻断解除 */
  function discardConflict(changeSetId: string): CommitResult {
    const index = changeSets.value.findIndex((item) => item.id === changeSetId && item.status === '冲突草稿')
    if (index < 0) return { ok: false, message: '冲突草稿不存在或已清空' }
    const [draft] = changeSets.value.splice(index, 1)
    log(draft.id, '冲突草稿清空', draft.windowName, `放弃V${draft.baseRevision}基线的整套变更：${describeChangeSet(draft)}`)
    persist()
    return { ok: true, message: '冲突草稿已清空，满足条件后可重新签署' }
  }

  function updateItem(equipmentId: string, itemId: string, patch: Partial<AcceptanceItem>) {
    const item = equipment.value.find((node) => node.id === equipmentId)?.items.find((value) => value.id === itemId)
    if (!item) return
    Object.assign(item, patch, { version: item.version + 1 })
    log(equipmentId, '更新验收项', '当前用户', `${item.id}状态更新为${item.status}`)
    persist()
  }

  function assignDefect(id: string, owner: string) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return
    defect.owner = owner
    defect.status = '整改中'
    defect.version += 1
    log(id, '分派缺陷', '验收负责人', `责任方调整为${owner}`)
    persist()
  }

  function addReply(id: string, reply: PartyReply) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect || !reply.content || !reply.evidence) return { ok: false, message: '回复内容和证据均不能为空' }
    defect.replies.unshift(reply)
    defect.status = '待联合复验'
    defect.version += 1
    log(id, `${reply.party}提交处理说明`, reply.owner, reply.content)
    persist()
    return { ok: true, message: '已提交处理说明并进入联合复验' }
  }

  function addRetest(id: string, result: string, passed: boolean) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return
    defect.retests.unshift({ round: defect.retests.length + 1, passed, result, tester: '联合验收组', testedAt: new Date().toISOString() })
    defect.status = passed ? '已关闭' : '整改中'
    defect.version += 1
    log(id, '执行联合复验', '联合验收组', result)
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
    log(id, `验收决定：${status}`, '验收负责人', note || '完成整改闭环')
    persist()
    return { ok: true, message: `缺陷已更新为${status}` }
  }

  function signOff() {
    if (conflictDrafts.value.length) return { ok: false, message: `仍有${conflictDrafts.value.length}套设备树冲突草稿，清空后才能重新签署` }
    if (!preflight.value.allowed) return { ok: false, message: preflight.value.blocking.join('；') }
    plant.value.status = '已签署'
    plant.value.version += 1
    plant.value.signedTreeRevision = treeRevision.value
    equipment.value.forEach((node) => { node.status = '已验收' })
    log(plant.value.id, '签署交付版本', '验收负责人陆川', `锁定V${plant.value.version}与设备树V${treeRevision.value}并生成交付包`)
    persist()
    return { ok: true, message: '签署完成，交付版本已锁定' }
  }

  function reset() {
    plant.value = deepClone(seedPlant)
    equipment.value = deepClone(seedEquipment)
    defects.value = deepClone(seedDefects)
    audit.value = deepClone(seedAudit)
    treeRevision.value = INITIAL_REVISION
    changeSets.value = []
    persist()
  }

  return {
    plant, equipment, defects, audit, treeRevision, changeSets, conflictDrafts, mergedChanges, deliveryInvalid,
    selectedEquipmentId, keyword, hydrated, selectedEquipment, stats, preflight,
    hydrate, persist, commitTreeMoves, rebaseConflict, discardConflict,
    updateItem, assignDefect, addReply, addRetest, decideDefect, signOff, reset, log
  }
})
