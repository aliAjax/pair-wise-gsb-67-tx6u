/**
 * 深拷贝领域数据。
 * 设备树/缺陷/审计均为纯 JSON 类型（日期以 ISO 字符串存储），用 JSON 拷贝可同时
 * 兼容浏览器中的 Vue 响应式 Proxy 与 Node 测试环境，避免 structuredClone 对 Proxy 抛 DataCloneError。
 */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
