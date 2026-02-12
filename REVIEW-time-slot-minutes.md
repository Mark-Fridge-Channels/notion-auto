# Code Review — 时间区间支持分钟（PLAN-013）

## ✅ Looks Good

- **schedule.ts**：类型清晰，无 `any`/`@ts-ignore`/`console.*`/TODO；`TimeSlot`、校验、归一化、`getIndustryForNow` 与现有风格一致。
- **错误与校验**：`validateTimeSlot` / `validateSchedule` 对 hour/minute 做完整校验；`loadSchedule` 对 ENOENT 有专门处理并回退默认配置。
- **安全与输入**：服务端通过 `mergeSchedule` + `validateSchedule` 校验 POST body；前端用 `escapeHtml`/`escapeAttr` 防止 XSS。
- **架构**：时间区间逻辑集中在 `schedule.ts`，Dashboard 仅做展示与收集，职责清晰。
- **向后兼容**：`normalizeTimeSlot` 对缺分钟补 0、`endHour=24` 转为 23:59，旧配置可正常加载。

## ⚠️ Issues Found（已修复）

- **[MEDIUM]** [[src/server.ts:456-459](src/server.ts)] — `syncTimeSlotsFromDOM` 中 `row.querySelector(...)` 可能为 `null`，直接访问 `.value` 会抛错（例如 DOM 被改或模板缺字段）。
  - **Fix:** 已改为使用可选链与默认值：`row.querySelector('[data-key="startHour"]')?.value ?? 0`（及 startMinute/endHour/endMinute 同理）。

- **[MEDIUM]** [[src/server.ts:664-667](src/server.ts)] — `collectSchedule` 中同样对四个时间输入直接取 `.value`，存在相同风险。
  - **Fix:** 已改为对四个 `querySelector` 使用 `?.value`，缺失时依赖后续 clamp 逻辑得到 0/23/59。

- **[LOW]** [[src/schedule.ts:227](src/schedule.ts)] — `normalizeTimeSlot` 在 `raw == null` 时返回 `industryId: ""`，会导致 `validateSchedule` 报「引用的行业不存在」。
  - **Fix:** 已改为返回 `{ ...def }`，保留默认 `industryId`，使合并后的结构仍可通过校验。

## 📊 Summary

- **Files reviewed:** 2（`src/schedule.ts`、`src/server.ts` 中时间区间相关逻辑及内联脚本）
- **Critical issues:** 0
- **Warnings (MEDIUM):** 2（均已修复）
- **Warnings (LOW):** 1（已修复）

上述问题已在本次 review 中完成修改。
