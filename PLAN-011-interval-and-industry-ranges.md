# Feature Implementation Plan — 区间配置（间隔 / 新会话 N / 换模型 M）

**Overall Progress:** `100%`

## TLDR

将「对话结束检查间隔」「每 N 次新会话」「每 M 次换模型」从单值改为 [min, max] 区间；运行时每次发送后从间隔区间随机 sleep，每次**开新会话**时从行业 N/M 区间随机取值并按**会话内次数**判断是否 new chat / 换模型。失败重试触发的 New chat 不算开新会话；N 支持随机到 0（本会话不主动新建）。

## Critical Decisions

- **开新会话**仅指：进入/切换行业后的 New chat、按 currentN 主动点的 New chat；失败重试的 clickNewAIChat / reopen 不重置 sessionRuns、不重抽 N/M。
- **N 支持随机到 0**：currentN === 0 时本会话不按次数主动新建会话；判断用 `currentN > 0 && sessionRuns % currentN === 0`。
- **向后兼容**：读取时若仅有旧单数字段则转为 min=max=该值；写入统一用区间字段。

## Tasks

- [x] 🟩 **Step 1: Schedule 类型与校验（schedule.ts）**
  - [x] 🟩 Schedule 增加 `intervalMinMs`、`intervalMaxMs`（去掉或兼容 `intervalMs`）；ScheduleIndustry 增加 `newChatEveryRunsMin/Max`、`modelSwitchIntervalMin/Max`（兼容旧单数字段）
  - [x] 🟩 校验：interval 区间为正数且 min≤max；行业 N、M 为非负整数且 min≤max
  - [x] 🟩 `getDefaultSchedule()`、`mergeSchedule()` 使用区间；merge 时若仅有旧单值则设 min=max=原值
  - [x] 🟩 `validateSchedule` / `validateIndustry` 校验新区间

- [x] 🟩 **Step 2: 主流程区间与会话逻辑（index.ts）**
  - [x] 🟩 新增闭区间随机整数 helper（[min, max] 含两端），用于间隔与 N/M
  - [x] 🟩 引入 `sessionRuns`、`currentN`、`currentM`；在「进入行业后 clickNewAIChat」与「切换行业后 clickNewAIChat」处初始化并从行业区间随机 currentN、currentM
  - [x] 🟩 每轮执行前：若 `currentN > 0 && sessionRuns > 0 && sessionRuns % currentN === 0` 则 clickNewAIChat，并重置 sessionRuns、重抽 currentN/currentM；若 `currentM > 0 && sessionRuns % currentM === 0` 则 switchToNextModel（失败重试路径不重置、不重抽）
  - [x] 🟩 每轮成功执行后 sessionRuns++；发送完成后 sleep 从 `[intervalMinMs, intervalMaxMs]` 随机取毫秒

- [x] 🟩 **Step 3: Dashboard 表单与 API（server.ts）**
  - [x] 🟩 全局设置：单输入「每隔多少秒 check」改为「最小」「最大」两输入；fillGlobal / collectSchedule 读写 intervalMinMs/intervalMaxMs（或等价秒数）
  - [x] 🟩 行业弹窗：每 N 次新会话、每 M 次换模型各改为两个输入；openEditModal 回填、saveEditModal 收集并写入新区间字段
  - [x] 🟩 新建行业默认：N 区间 1~1，M 区间 0~0

- [x] 🟩 **Step 4: 示例与文档**
  - [x] 🟩 `schedule.example.json` 改为区间字段示例
  - [x] 🟩 `README.md` 中 schedule 配置说明改为区间描述（若存在）
