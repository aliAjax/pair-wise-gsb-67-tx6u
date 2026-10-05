<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import { useAcceptanceStore } from '../stores/acceptance'
import type { EquipmentNode } from '../types/domain'

const store = useAcceptanceStore()
const route = useRoute()
const emit = defineEmits<{ (e: 'move', nodeId: string): void; (e: 'show-conflicts'): void }>()

interface FlatRow { node: EquipmentNode; depth: number }

const rows = computed<FlatRow[]>(() => {
  const result: FlatRow[] = []
  const walk = (parentId: string | null, depth: number) => {
    store.equipment.filter((node) => node.parentId === parentId).forEach((node) => {
      result.push({ node, depth })
      walk(node.id, depth + 1)
    })
  }
  walk(null, 0)
  return result
})

const movable = (node: EquipmentNode) => node.type === '逆变器' || node.type === '汇流箱'
const severityOf = (node: EquipmentNode) => node.status === '已验收' ? 'success' : node.status === '验收中' ? 'warn' : 'secondary'
</script>

<template>
  <div class="tree-panel">
    <div class="tree-panel-head">
      <div><strong>设备树</strong><small>当前版本 V{{ store.treeRevision }}</small></div>
      <Button v-if="store.conflictDrafts.length" label="冲突草稿" size="small" severity="danger" outlined @click="emit('show-conflicts')">
        <template #icon><span class="conflict-count">{{ store.conflictDrafts.length }}</span></template>
      </Button>
    </div>
    <div class="tree-rows">
      <div v-for="row of rows" :key="row.node.id" class="tree-row" :class="{ active: route.params.id === row.node.id }" :style="{ paddingLeft: `${10 + row.depth * 16}px` }">
        <span class="tree-dot" :data-type="row.node.type" />
        <Tag :value="row.node.type" :severity="severityOf(row.node)" style="min-width:56px" />
        <a class="tree-name" @click="navigateTo(`/equipment/${row.node.id}`)">{{ row.node.name }}</a>
        <small>{{ row.node.items.length }}项 / {{ row.node.certificates.length }}证</small>
        <Button v-if="movable(row.node)" label="迁移" text size="small" @click="emit('move', row.node.id)" />
      </div>
    </div>
    <p class="tree-hint">拆分方阵或改组时，逆变器、汇流箱连同其下级子节点、验收项与证书一并迁移；方阵仅作为目标挂接点。</p>
  </div>
</template>
