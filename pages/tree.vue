<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import Button from 'primevue/button'
import Tree from 'primevue/tree'
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import Textarea from 'primevue/textarea'
import Tag from 'primevue/tag'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import { useToast } from 'primevue/usetoast'
import { useAcceptanceStore } from '../stores/acceptance'
import type { EquipmentNode, TreeMove } from '../types/domain'

interface TreeNode { key: string; label: string; data: EquipmentNode; children?: TreeNode[] }

const store = useAcceptanceStore()
const toast = useToast()

const treeNodes = computed<TreeNode[]>(() => {
  const byParent = new Map<string | null, EquipmentNode[]>()
  store.equipment.forEach((node) => {
    const list = byParent.get(node.parentId) ?? []
    list.push(node)
    byParent.set(node.parentId, list)
  })
  const build = (parentId: string | null): TreeNode[] => (byParent.get(parentId) ?? []).map((node) => ({
    key: node.id,
    label: `${node.name}（${node.code}）· ${node.items.length}验收项 / ${node.certificates.length}证书`,
    data: node,
    children: build(node.id)
  }))
  return build(null)
})

const parentOptions = computed(() => [
  { label: '根节点（并网点层级）', value: null },
  ...store.equipment.map((node) => ({ label: `${node.name} · ${node.type}（${node.id}）`, value: node.id }))
])

// —— 变更编排：一整套挂接可含多步，基线为打开页面时的树版本 ——
const draftMoves = ref<TreeMove[]>([])
const selectedMoveNode = ref<string | null>(null)
const selectedTarget = ref<string | null>(null)
const meta = reactive({ label: '', reason: '', operator: '验收负责人陆川', windowId: 'A' })
const baseVersion = ref(store.treeVersion)
const expandedKeys = ref<Record<string, boolean>>({ 'EQ-GRID': true, 'EQ-TR1': true })

const draftTouched = computed(() => Array.from(new Set(draftMoves.value.flatMap((move) => store.subtreeIds(store.equipment, move.equipmentId)))))
const draftValidation = computed(() => {
  if (!draftMoves.value.length) return ''
  return store.validateMoves(draftMoves.value.map((move) => ({ ...move })), store.equipment)
})

function addMove() {
  if (!selectedMoveNode.value) { toast.add({ severity: 'warn', summary: '请选择要迁移的设备', life: 2000 }); return }
  const node = store.equipment.find((item) => item.id === selectedMoveNode.value)
  if (!node) return
  if (draftMoves.value.some((move) => move.equipmentId === node.id)) { toast.add({ severity: 'warn', summary: `${node.name} 已在本套变更中`, detail: '同一设备只能有一个父节点', life: 2500 }); return }
  draftMoves.value.push({ equipmentId: node.id, fromParentId: node.parentId, targetParentId: selectedTarget.value })
  selectedMoveNode.value = null
  selectedTarget.value = null
}
function removeMove(index: number) { draftMoves.value.splice(index, 1) }
function nameOf(id: string | null) { return id === null ? '根节点' : store.equipment.find((node) => node.id === id)?.name ?? id }

function submit(staleBase = false) {
  if (!meta.label.trim() || !meta.reason.trim()) { toast.add({ severity: 'error', summary: '请填写变更名称与改组原因', life: 2500 }); return }
  if (draftValidation.value) { toast.add({ severity: 'error', summary: draftValidation.value, life: 3000 }); return }
  if (baseVersion.value !== store.treeVersion) baseVersion.value = store.treeVersion
  const result = store.submitTreeChange({
    label: meta.label, reason: meta.reason, operator: meta.operator, windowId: meta.windowId,
    baseTreeVersion: staleBase ? Math.max(0, store.treeVersion - 1) : baseVersion.value,
    moves: draftMoves.value.map((move) => ({ ...move, fromParentId: store.equipment.find((node) => node.id === move.equipmentId)?.parentId ?? null }))
  })
  toast.add({ severity: result.ok ? 'success' : 'error', summary: result.message, life: 4200 })
  if (result.ok) { draftMoves.value = []; meta.label = ''; meta.reason = ''; baseVersion.value = store.treeVersion }
}

function simulateConcurrent() {
  const result = store.simulateConcurrentWindows()
  toast.add({ severity: 'success', summary: '窗口A（先到）', detail: result.first, life: 3500 })
  setTimeout(() => toast.add({ severity: 'error', summary: '窗口B（后到，冲突草稿）', detail: result.second, life: 5000 }), 700)
  baseVersion.value = store.treeVersion
}
function simulatePersistFailure() {
  store.failNextPersist = true
  if (!draftMoves.value.length) {
    const inv = store.equipment.find((node) => node.id === 'EQ-INV21')
    if (inv) draftMoves.value = [{ equipmentId: inv.id, fromParentId: inv.parentId, targetParentId: 'EQ-AR1' }]
  }
  if (!meta.label) { meta.label = '写入失败演练'; meta.reason = '验证持久化异常时整套回滚' }
  submit()
}
function retry(id: string) {
  const result = store.retryConflictDraft(id)
  toast.add({ severity: result.ok ? 'success' : 'error', summary: result.message, life: 3500 })
}
function discard(id: string) { store.discardConflictDraft(id) }
function resetBase() { baseVersion.value = store.treeVersion }
</script>

<template>
  <section class="page">
    <div class="section-head">
      <div><span>设备树变更 V{{ store.treeVersion }}<template v-if="store.plant.signedTreeVersion !== null"> · 签署基线 V{{ store.plant.signedTreeVersion }}</template></span><h2>设备树调整（可合并变更）</h2><p>迁移连同子节点、验收项与证书整体挂到目标方阵；同一设备只能有一个父节点，整套变更原子提交。</p></div>
      <div class="tree-actions">
        <Button label="演练：两个窗口同时提交" severity="secondary" outlined @click="simulateConcurrent" />
        <Button label="演练：写入失败回滚" severity="danger" outlined @click="simulatePersistFailure" />
      </div>
    </div>

    <div v-if="store.packageInvalidated" class="invalidate-band">设备树已由 V{{ store.plant.signedTreeVersion }} 变更为 V{{ store.treeVersion }}，已签署交付包失效；缺陷与审计按新树追查，冲突清空且重新签署前不可导出锁定版本。</div>

    <div class="tree-layout">
      <div class="tree-view-panel">
        <h3>当前设备树（验收项 / 证书随节点归属）</h3>
        <Tree :value="treeNodes" v-model:expandedKeys="expandedKeys" selectionMode="single" :metaKeySelection="false" :selectionKeys="(selectedMoveNode ?? undefined) as any" @update:selectionKeys="(key: any) => (selectedMoveNode = (key ?? null))" />
        <p class="tree-hint">单击节点选为迁移对象，其子树将整套迁移。</p>
      </div>

      <div class="change-composer">
        <h3>编排整套变更</h3>
        <label class="field">变更名称<InputText v-model="meta.label" placeholder="如：方阵拆分后逆变器改组" /></label>
        <label class="field">改组原因<Textarea v-model="meta.reason" rows="2" /></label>
        <div class="field-row">
          <label class="field">提交窗口<Select v-model="meta.windowId" :options="['A', 'B']" /></label>
          <label class="field">操作人<InputText v-model="meta.operator" /></label>
        </div>
        <div class="move-picker">
          <label class="field">目标父节点<Select v-model="selectedTarget" :options="parentOptions" filter /></label>
          <Button label="加入挂接" @click="addMove" />
        </div>
        <Tag v-if="selectedMoveNode" :value="`已选迁移对象：${nameOf(selectedMoveNode)}`" severity="warn" />
        <div v-if="draftMoves.length" class="move-list">
          <div v-for="(move, index) in draftMoves" :key="move.equipmentId" class="move-row">
            <strong>{{ nameOf(move.equipmentId) }}</strong>
            <span>{{ nameOf(move.fromParentId) }} → {{ nameOf(move.targetParentId) }}</span>
            <small>含子树 {{ store.subtreeIds(store.equipment, move.equipmentId).length }} 节点</small>
            <Button icon="pi pi-times" text severity="danger" @click="removeMove(index)" />
          </div>
          <p v-if="draftTouched.length" class="touch-note">触碰节点：{{ draftTouched.map(nameOf).join('、') }}（{{ draftTouched.length }}）</p>
        </div>
        <p v-if="draftValidation" class="invalid-hint">{{ draftValidation }}</p>
        <div class="base-line">基线树版本：V{{ baseVersion }} <Button v-if="baseVersion !== store.treeVersion" label="刷新基线" text size="small" @click="resetBase" /></div>
        <div class="composer-footer">
          <Button label="提交整套变更" :disabled="!!draftValidation || !draftMoves.length" @click="submit()" />
          <Button label="模拟过期基线提交" severity="secondary" outlined :disabled="!!draftValidation || !draftMoves.length" @click="submit(true)" />
        </div>
      </div>
    </div>

    <div v-if="store.conflictDrafts.length" class="conflict-panel">
      <h3>冲突草稿（{{ store.conflictDrafts.length }}）— 先到挂接已保留，后到整套未写入活树</h3>
      <p class="conflict-rule">冲突清空后才能重新签署交付包。可按当前新树重算挂接，或放弃后重新编排。</p>
      <DataTable :value="store.conflictDrafts" dataKey="id" size="small">
        <Column field="windowId" header="窗口" style="width:70px" />
        <Column field="label" header="变更" />
        <Column header="挂接内容"><template #body="{ data }"><span v-for="move in data.moves" :key="move.equipmentId">{{ nameOf(move.equipmentId) }} → {{ nameOf(move.targetParentId) }}；</span></template></Column>
        <Column field="baseTreeVersion" header="基线" style="width:70px"><template #body="{ data }">V{{ data.baseTreeVersion }}</template></Column>
        <Column header="冲突原因"><template #body="{ data }"><Tag :value="data.conflictReason" severity="danger" /></template></Column>
        <Column header="操作" style="width:200px"><template #body="{ data }"><Button label="按新树重提" size="small" @click="retry(data.id)" /><Button label="放弃清空" size="small" text severity="danger" @click="discard(data.id)" /></template></Column>
      </DataTable>
    </div>

    <div class="history-panel">
      <h3>变更记录</h3>
      <DataTable :value="store.treeChanges" dataKey="id" size="small">
        <Column field="createdAt" header="时间"><template #body="{ data }">{{ data.createdAt.replace('T', ' ').slice(0, 16) }}</template></Column>
        <Column field="windowId" header="窗口" style="width:60px" />
        <Column field="label" header="变更" />
        <Column field="operator" header="操作人" />
        <Column field="baseTreeVersion" header="基线→应用" style="width:110px"><template #body="{ data }">V{{ data.baseTreeVersion }} → <template v-if="data.appliedTreeVersion">V{{ data.appliedTreeVersion }}</template><template v-else>—</template></template></Column>
        <Column header="状态"><template #body="{ data }"><Tag :value="data.status" :severity="data.status === '已应用' ? 'success' : 'danger'" /></template></Column>
      </DataTable>
    </div>
  </section>
</template>
