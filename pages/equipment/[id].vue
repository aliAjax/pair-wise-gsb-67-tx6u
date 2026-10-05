<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import Textarea from 'primevue/textarea'
import { useToast } from 'primevue/usetoast'
import { useAcceptanceStore } from '../../stores/acceptance'
import { pathOf } from '../../services/treeChanges'
import EquipmentTreePanel from '../../components/EquipmentTreePanel.vue'
import TreeMoveDialog from '../../components/TreeMoveDialog.vue'
import ConflictPanel from '../../components/ConflictPanel.vue'
import type { AcceptanceItem } from '../../types/domain'

const route = useRoute()
const store = useAcceptanceStore()
const toast = useToast()
const node = computed(() => store.equipment.find((item) => item.id === route.params.id))
const nodePath = computed(() => node.value ? pathOf(store.equipment, node.value.parentId) : '')
const siblings = computed(() => node.value ? store.equipment.filter((value) => value.parentId === node.value!.parentId) : [])
const visible = ref(false)
const moveVisible = ref(false)
const conflictVisible = ref(false)
const initialNodeId = ref<string | null>(null)
const editable = ref<Partial<AcceptanceItem>>({})

function openItem(item: AcceptanceItem) { editable.value = structuredClone(item); visible.value = true }
function save() {
  if (!node.value || !editable.value.id) return
  store.updateItem(node.value.id, editable.value.id, editable.value)
  visible.value = false
}
function openMove(nodeId?: string) {
  initialNodeId.value = nodeId ?? null
  moveVisible.value = true
}
function showConflicts() { conflictVisible.value = true }
function remindSigned() {
  toast.add({ severity: 'warn', summary: '交付包已失效', detail: '设备树调整后已签署交付包失效，缺陷与审计按新树追查，冲突清空并重新校验后才能签署。', life: 5000 })
}
</script>

<template>
  <section v-if="node" class="page equipment-layout">
    <aside class="equipment-aside">
      <EquipmentTreePanel @move="openMove" @show-conflicts="showConflicts" />
    </aside>
    <div class="equipment-main">
      <div v-if="store.deliveryInvalid" class="invalid-banner" @click="remindSigned">
        <Tag value="交付包失效" severity="danger" />
        <span>设备树已从签署时的 V{{ store.plant.signedTreeRevision }} 调整到 V{{ store.treeRevision }}；验收项与证书已随设备挂到新方阵，缺陷与审计按新树追查，冲突清空后才能重新签署。</span>
      </div>
      <div class="section-head">
        <div><span>{{ node.id }} · {{ node.code }} · 设备树 V{{ store.treeRevision }}</span><h2>{{ node.name }}</h2><p>{{ node.type }} · 所在路径 {{ nodePath }} · 当前状态 {{ node.status }}</p></div>
        <div class="head-actions">
          <Button v-if="node.type === '逆变器' || node.type === '汇流箱'" label="迁移本设备" outlined @click="openMove(node.id)" />
          <Button label="改组设备树" severity="secondary" outlined @click="openMove()" />
          <Button v-if="store.conflictDrafts.length" :label="`冲突草稿 ${store.conflictDrafts.length}`" severity="danger" outlined @click="showConflicts" />
          <Tag :value="node.status" :severity="node.status === '已验收' ? 'success' : 'warn'" />
        </div>
      </div>
      <div class="equipment-path"><span v-for="item in siblings" :key="item.id" @click="navigateTo(`/equipment/${item.id}`)">{{ item.name }}</span></div>
      <DataTable :value="node.items" dataKey="id" size="small">
        <Column field="id" header="编号" style="width:100px" />
        <Column field="standard" header="验收标准" />
        <Column field="method" header="测试方法" />
        <Column field="condition" header="测试条件" />
        <Column field="measured" header="实测结果" />
        <Column field="evidence" header="测试证据" />
        <Column header="状态"><template #body="{ data }"><Tag :value="data.status" :severity="data.status === '合格' ? 'success' : data.status === '不合格' ? 'danger' : 'warn'" /></template></Column>
        <Column header="版本"><template #body="{ data }">V{{ data.version }}</template></Column>
        <Column header=""><template #body="{ data }"><Button label="录入/复核" text @click="openItem(data)" /></template></Column>
      </DataTable>
      <div class="certificate-panel">
        <h3>证书与测试附件（随设备节点挂接，迁移时一并移动）</h3>
        <div v-for="certificate in node.certificates" :key="certificate.id" class="certificate-item"><Tag :value="certificate.verified ? '已核验' : '待核验'" :severity="certificate.verified ? 'success' : 'danger'" /><strong>{{ certificate.name }}</strong><span>{{ certificate.issuer }}</span><span>有效期至 {{ certificate.expiresAt }}</span><small>V{{ certificate.version }}</small></div>
        <p v-if="!node.certificates.length">当前设备节点暂无证书附件。</p>
      </div>
    </div>
    <Dialog v-model:visible="visible" header="录入验收项" modal :style="{ width: '620px' }">
      <div class="edit-grid">
        <label>状态<Select v-model="editable.status" :options="['待检查', '合格', '不合格', '待复验']" /></label>
        <label>实测结果<InputText v-model="editable.measured" /></label>
        <label>测试证据<InputText v-model="editable.evidence" /></label>
        <label>测试条件<Textarea v-model="editable.condition" rows="3" /></label>
      </div>
      <template #footer><Button label="取消" severity="secondary" text @click="visible = false" /><Button label="保存并递增版本" @click="save" /></template>
    </Dialog>
    <TreeMoveDialog v-model:visible="moveVisible" :initial-node-id="initialNodeId" />
    <ConflictPanel v-model:visible="conflictVisible" />
  </section>
  <section v-else class="page">未找到设备节点（设备树改组后请从左侧树重新选择）</section>
</template>
