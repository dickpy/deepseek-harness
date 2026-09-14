/**
 * 企业客户端表面，node half。纯 UI 插件：空 apply 让插件出现在 Loader，
 * 浏览器 half 由 package.json 的 dsh.client 声明（exports["./client"]）发布。
 */

/** Host 插件位 —— 本表面无 host 侧行为。 */
export function apply(): void {}
