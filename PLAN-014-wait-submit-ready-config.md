# PLAN-014：发送后等待超时可配置（Dashboard + 分钟）

**目标**：将「发送后等待可发送状态」的超时从硬编码 3 分钟改为可配置，单位分钟，默认 5 分钟；Dashboard 全局设置可编辑；换模型前等待共用该配置。

**规格**：方案 B（存毫秒 `waitSubmitReadyMs`，UI 用分钟）；默认 5 分钟；最小 1 分钟、不设最大；< 1 分钟时校验报错「至少 1 分钟」。

---

## 进度

| 步骤 | 说明 | 状态 |
|------|------|------|
| 1 | schedule.ts：Schedule 类型 + getDefaultSchedule + mergeSchedule + validateSchedule | ✅ |
| 2 | index.ts：传入 waitSubmitReadyMs，typeAndSend / tryTypeAndSend 使用 timeoutMs | ✅ |
| 3 | model-picker.ts：switchToNextModel(page, timeoutMs?) | ✅ |
| 4 | server.ts：Dashboard 全局设置 + fillGlobal + collectSchedule + 校验 | ✅ |
| 5 | 跟踪文档更新 | ✅ |

**总体进度：100%**
