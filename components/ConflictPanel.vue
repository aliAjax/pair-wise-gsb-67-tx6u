<script setup lang="ts">
import { computed } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Tag from 'primevue/tag'
import { useToast } from 'primevue/usetoast'
import { useAcceptanceStore } from '../stores/acceptance'
import { pathOf } from '../services/treeChanges'
import type { TreeChangeSet } from '../types/domain'

const visible = defineModel<boolean>('visible', { default: false })
const store = useAcceptanceStore()
const toast = useToast()

function nodeName(id: string) {
  return store.equipment.find((node) => node.id === id)?.name ?? `${id}（已不在树中）`
}
function targetPath(change: TreeChangeSet, parentId: string) {
  const exists = store.equipment.some((node) => node.id === parentId)
  return exists ? pathOf(store.equipment, parentId) : `目标 ${parentId} 在新树中不存在`
}

function rebase(change: TreeChangeSet) {
  const result = store.rebaseConflict(change.id)
  toast.add({ severity: result.ok ? 'success' : 'warn', summary: result.ok ? '冲突已重算合并' : '仍无法合并', detail: result.message, life: 5000 })
}
function discard(change: TreeChangeSet) {
  const result = store.discardConflict(change.id)
  toast.add({ severity: result.ok ? 'success' : 'error', summary: '冲突草稿', detail: result.message, life: 3500 })
}
</script>

<template>
  <Dialog v-model:visible="visible" header="设备树冲突草稿（清空后才能重新签署）" modal :style="{ width: '780px' }">
    <p v-if="!store.conflictDrafts.length" class="conflict-empty">当前没有冲突草稿。</p>
    <article v-for="change in store.conflictDrafts" :key="change.id" class="conflict-card">
      <div class="conflict-head">
        <div><Tag value="冲突草稿" severity="danger" /><strong>{{ change.id }}</strong><small>{{ change.windowName }} · 基线 V{{ change.baseRevision }} · 当前树 V{{ store.treeRevision }}</small></div>
        <small>{{ change.createdAt.replace('T', ' ').slice(0, 16) }}</small>
      </div>
      <p class="conflict-reason">{{ change.conflictReason }}</p>
      <ul class="conflict-moves">
        <li v-for="(move, index) in change.moves" :key="`${move.nodeId}-${index}`">
          <Tag :value="nodeName(move.nodeId)" severity="secondary" />
          <span class="move-arrow">由 {{ nodeName(move.fromParentId ?? '') }} 挂到 → {{ targetPath(change, move.toParentId) }}</span>
          <small>原因：{{ move.reason }}</small>
        </li>
      </ul>
      <div class="conflict-actions">
        <Button label="按新树重算合并" size="small" @click="rebase(change)" />
        <Button label="清空（放弃整套变更）" size="small" severity="danger" outlined @click="discard(change)" />
      </div>
      <p v-if="change.resolvedNote" class="conflict-resolved">{{ change.resolvedNote }}</p>
    </article>
  </Dialog>
</template>
