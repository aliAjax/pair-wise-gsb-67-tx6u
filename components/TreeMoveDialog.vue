<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import Textarea from 'primevue/textarea'
import Tag from 'primevue/tag'
import { useToast } from 'primevue/usetoast'
import { useAcceptanceStore } from '../stores/acceptance'
import { previewMoveImpact, validateChangeSet } from '../services/treeChanges'
import type { TreeMove } from '../types/domain'

const store = useAcceptanceStore()
const toast = useToast()
const visible = defineModel<boolean>('visible', { default: false })
const props = defineProps<{ initialNodeId?: string | null }>()

interface DraftMove { nodeId: string; toParentId: string; reason: string }

const windowName = ref(`窗口-${Math.floor(Math.random() * 900 + 100)}`)
const forceWriteFailure = ref(false)
const draftMoves = reactive<DraftMove[]>([])
const baseRevision = ref(store.treeRevision)

watch(visible, (value) => {
  if (value) {
    draftMoves.splice(0, draftMoves.length)
    if (props.initialNodeId && movableId(props.initialNodeId)) addMove(props.initialNodeId)
    baseRevision.value = store.treeRevision
  }
})

const arrayOptions = computed(() => store.equipment.filter((node) => node.type === '方阵').map((node) => ({ label: `${node.name}（${node.code}）`, value: node.id })))
const movableOptions = computed(() => store.equipment.filter((node) => node.type === '逆变器' || node.type === '汇流箱').map((node) => ({ label: `${node.name}（${node.code}）`, value: node.id })))

function movableId(id: string) {
  const node = store.equipment.find((item) => item.id === id)
  return !!node && (node.type === '逆变器' || node.type === '汇流箱')
}
function addMove(nodeId?: string) {
  draftMoves.push({ nodeId: nodeId ?? '', toParentId: '', reason: '' })
}
function removeMove(index: number) {
  draftMoves.splice(index, 1)
}
function impactOf(nodeId: string) {
  return nodeId ? previewMoveImpact(store.equipment, nodeId) : null
}
function nodeName(nodeId: string) {
  return store.equipment.find((node) => node.id === nodeId)?.name ?? '—'
}

// 在提交前给调用方一个可见的预校验结果（真正的权威校验在 store 合并时执行）
const draftError = computed(() => {
  const moves = buildMoves()
  if (!moves) return '请为每一步迁移选择设备与目标方阵'
  return ''
})

function buildMoves(): TreeMove[] | null {
  const result: TreeMove[] = []
  const used = new Set<string>()
  for (const draft of draftMoves) {
    if (!draft.nodeId || !draft.toParentId) return null
    if (used.has(draft.nodeId)) return null
    const node = store.equipment.find((item) => item.id === draft.nodeId)
    if (!node) return null
    result.push({ nodeId: draft.nodeId, nodeName: node.name, fromParentId: node.parentId, toParentId: draft.toParentId, reason: draft.reason })
  }
  return result
}

const validationMessage = computed(() => {
  const moves = buildMoves()
  if (!moves) return ''
  return validateChangeSet(store.equipment, moves).message
})

function submit() {
  const moves = buildMoves()
  if (!moves) {
    toast.add({ severity: 'error', summary: '变更集不完整', detail: draftError.value, life: 3000 })
    return
  }
  const result = store.commitTreeMoves({ moves, windowName: windowName.value, forceWriteFailure: forceWriteFailure.value })
  toast.add({ severity: result.ok ? 'success' : 'warn', summary: result.ok ? '设备树变更已合并' : '未合并', detail: result.message, life: 6000 })
  if (result.ok) visible.value = false
}
</script>

<template>
  <Dialog v-model:visible="visible" header="拆分方阵 / 改组：编制设备树变更" modal :style="{ width: '760px' }">
    <div class="composer">
      <p class="composer-note">本套变更以当前树 <b>V{{ baseRevision }}</b> 为基线，多步迁移成套合并：迁移连同全部子节点、验收项与证书挂到目标方阵。另一窗口先提交时，先到挂接保留，本套变更整体留为冲突草稿。</p>
      <div class="composer-meta">
        <label>提交窗口<InputText v-model="windowName" placeholder="例如：窗口A" style="width:180px" /></label>
        <label class="force-fail"><input v-model="forceWriteFailure" type="checkbox" /> 模拟写入失败（验证回滚到迁移前）</label>
      </div>
      <div v-for="(draft, index) in draftMoves" :key="index" class="draft-move">
        <div class="draft-grid">
          <label>迁移设备<Select v-model="draft.nodeId" :options="movableOptions" optionLabel="label" optionValue="value" filter placeholder="选择逆变器/汇流箱" /></label>
          <label>目标方阵<Select v-model="draft.toParentId" :options="arrayOptions" optionLabel="label" optionValue="value" placeholder="挂接到哪个方阵" /></label>
          <Button label="移除" severity="danger" outlined size="small" @click="removeMove(index)" />
        </div>
        <label class="reason-line">拆分/改组原因<InputText v-model="draft.reason" placeholder="例如：验收时按实际组串拆分1号方阵，该逆变器划入2号方阵" /></label>
        <div v-if="impactOf(draft.nodeId)" class="impact-line">
          <Tag value="连同迁移" severity="info" />
          <span>{{ nodeName(draft.nodeId) }} 子树共 {{ impactOf(draft.nodeId)?.subtreeCount }} 台设备、{{ impactOf(draft.nodeId)?.itemCount }} 项验收项、{{ impactOf(draft.nodeId)?.certificateCount }} 份证书</span>
        </div>
      </div>
      <p v-if="validationMessage" class="validation-error">预校验：{{ validationMessage }}</p>
      <Button label="增加一步迁移" text size="small" icon="pi pi-plus" @click="addMove()" />
    </div>
    <template #footer>
      <Button label="取消" severity="secondary" text @click="visible = false" />
      <Button label="成套提交并合并" :disabled="draftMoves.length === 0" @click="submit" />
    </template>
  </Dialog>
</template>
