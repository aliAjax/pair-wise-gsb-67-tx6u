export type InspectionStatus = '待检查' | '合格' | '不合格' | '待复验'
export type DefectStatus = '待分派' | '整改中' | '待联合复验' | '已关闭' | '带条件通过'
export type Party = '建设单位' | '设备厂家' | '运维单位'

export interface AcceptanceItem {
  id: string
  standard: string
  method: string
  condition: string
  status: InspectionStatus
  measured: string
  evidence: string
  version: number
}

export interface Certificate {
  id: string
  name: string
  issuer: string
  expiresAt: string
  version: number
  verified: boolean
}

export interface EquipmentNode {
  id: string
  parentId: string | null
  name: string
  type: '并网点' | '变压器' | '方阵' | '逆变器' | '汇流箱'
  code: string
  status: '待验收' | '验收中' | '已验收'
  items: AcceptanceItem[]
  certificates: Certificate[]
}

export interface PartyReply {
  party: Party
  owner: string
  content: string
  evidence: string
  repliedAt: string
}

export interface AcceptanceDefect {
  id: string
  equipmentId: string
  itemId: string
  title: string
  severity: '一般' | '重大'
  status: DefectStatus
  owner: string
  dueDate: string
  replies: PartyReply[]
  retests: Array<{ round: number; passed: boolean; result: string; tester: string; testedAt: string }>
  decisionNote: string
  version: number
}

export interface Plant {
  id: string
  name: string
  gridPoint: string
  capacity: string
  commissioningDate: string
  status: '验收中' | '待复核' | '已签署'
  version: number
  /** 最近一次签署时锁定的设备树版本；与当前 treeVersion 不一致表示交付包已失效 */
  signedTreeVersion: number | null
}

/** 单步挂接：把 equipmentId 连同其子树整体挂到 targetParentId 下，验收项与证书随节点归属 */
export interface TreeMove {
  equipmentId: string
  targetParentId: string | null
  fromParentId: string | null
}

export type TreeChangeStatus = '草稿' | '已应用' | '冲突草稿'

/** 可合并的设备树变更：一次窗口提交的整套挂接（可含多步），原子提交 */
export interface TreeChange {
  id: string
  label: string
  operator: string
  reason: string
  windowId: string
  baseTreeVersion: number
  status: TreeChangeStatus
  moves: TreeMove[]
  /** 本次变更触碰的节点（被迁移子树的全部节点）与目标父位 */
  touchedNodeIds: string[]
  occupiedParentIds: Array<string | null>
  appliedTreeVersion: number | null
  conflictWith: string | null
  conflictReason: string
  createdAt: string
  appliedAt: string | null
  /** 冲突时保留的提交前整树快照，用于核对与恢复，不写回活树 */
  treeSnapshotAtSubmit: EquipmentNode[] | null
}

export interface AuditEntry {
  id: string
  entityId: string
  action: string
  operator: string
  detail: string
  createdAt: string
}
