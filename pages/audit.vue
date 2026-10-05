<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import InputText from 'primevue/inputtext'
import Tag from 'primevue/tag'
import { useToast } from 'primevue/usetoast'
import { useAcceptanceStore } from '../stores/acceptance'
import { pathOf } from '../services/treeChanges'
import ConflictPanel from '../components/ConflictPanel.vue'

const store = useAcceptanceStore()
const toast = useToast()
const keyword = ref('')
const conflictVisible = ref(false)
const rows = computed(() => store.audit.filter((item) => !keyword.value || `${item.entityId} ${item.action} ${item.operator} ${item.detail}`.includes(keyword.value)))
// 审计按新树追查：实体为设备节点时展示当前树路径，其余实体保持原编号
const entityLabel = (id: string) => (store.equipment.some((node) => node.id === id) ? pathOf(store.equipment, id) : id)
const sign = () => {
  const result = store.signOff()
  toast.add({ severity: result.ok ? 'success' : 'error', summary: result.ok ? '签署完成' : '完整性校验未通过', detail: result.message, life: 5000 })
}
const exportPackage = () => {
  const payload = { plant: store.plant, treeRevision: store.treeRevision, signedTreeRevision: store.plant.signedTreeRevision, deliveryInvalid: store.deliveryInvalid, changeSets: store.changeSets, equipment: store.equipment, defects: store.defects, audit: store.audit, preflight: store.preflight }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = '光伏并网验收交付包.json'; anchor.click(); URL.revokeObjectURL(url)
}
</script>

<template>
  <section class="page">
    <div v-if="store.deliveryInvalid" class="invalid-banner">
      <Tag value="已签署交付包失效" severity="danger" />
      <span>交付包锁定的设备树为 V{{ store.plant.signedTreeRevision }}，当前设备树为 V{{ store.treeRevision }}；验收项与证书已挂到目标方阵，缺陷与审计按新树追查，冲突草稿清空并重新通过完整性校验后才能重新签署。</span>
    </div>
    <div class="preflight-panel">
      <div>
        <span>并网前完整性校验</span>
        <strong>{{ store.preflight.allowed ? '全部条件满足' : `${store.preflight.blocking.length}项阻断` }}</strong>
        <p v-for="item in store.preflight.blocking" :key="item">{{ item }}</p>
      </div>
      <div class="sign-actions">
        <Button v-if="store.conflictDrafts.length" :label="`处理冲突草稿（${store.conflictDrafts.length}）`" severity="danger" outlined @click="conflictVisible = true" />
        <Button label="导出交付包" outlined @click="exportPackage" />
        <Button label="签署并锁定版本" @click="sign" />
      </div>
    </div>

    <div class="section-head"><div><h2>设备树变更（可合并）</h2><p>树版本 V{{ store.treeRevision }} · 已合并 {{ store.mergedChanges.length }} 套 · 冲突草稿 {{ store.conflictDrafts.length }} 套</p></div><Button v-if="store.conflictDrafts.length" label="打开冲突草稿" severity="danger" outlined @click="conflictVisible = true" /></div>
    <DataTable :value="store.changeSets" dataKey="id" size="small" class="changes-table">
      <Column field="id" header="变更集" />
      <Column field="windowName" header="提交窗口" />
      <Column header="版本跨度"><template #body="{ data }">V{{ data.baseRevision }} → {{ data.finalRevision ? `V${data.finalRevision}` : '—' }}</template></Column>
      <Column header="迁移步骤"><template #body="{ data }">{{ data.moves.length }} 步</template></Column>
      <Column header="内容"><template #body="{ data }"><span class="change-moves">{{ data.moves.map((m: any) => `${m.nodeName}→${m.toParentId}`).join('，') }}</span></template></Column>
      <Column header="状态"><template #body="{ data }"><Tag :value="data.status" :severity="data.status === '已合并' ? 'success' : 'danger'" /></template></Column>
      <Column header="冲突原因"><template #body="{ data }"><small>{{ data.conflictReason || '—' }}</small></template></Column>
    </DataTable>

    <div class="section-head" style="margin-top:22px"><div><h2>验收审计</h2><p>当前交付版本 V{{ store.plant.version }} · {{ store.plant.status }} · 实体按当前设备树 V{{ store.treeRevision }} 追查</p></div><InputText v-model="keyword" placeholder="搜索实体、动作或操作人" /></div>
    <DataTable :value="rows" dataKey="id" size="small">
      <Column field="createdAt" header="时间"><template #body="{ data }">{{ data.createdAt.replace('T', ' ').slice(0, 16) }}</template></Column>
      <Column header="实体（按新树）"><template #body="{ data }">{{ entityLabel(data.entityId) }}</template></Column>
      <Column field="action" header="动作"><template #body="{ data }"><Tag :value="data.action" :severity="data.action.includes('失效') || data.action.includes('冲突') ? 'danger' : data.action.includes('迁移') || data.action.includes('合并') ? 'info' : undefined" /></template></Column>
      <Column field="operator" header="操作人" />
      <Column field="detail" header="说明" />
    </DataTable>
    <ConflictPanel v-model:visible="conflictVisible" />
  </section>
</template>
