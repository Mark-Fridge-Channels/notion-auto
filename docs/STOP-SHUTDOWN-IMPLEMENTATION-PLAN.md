# Feature Implementation Plan

**Overall Progress:** `100%`

## TLDR
在 Dashboard 的停止和拉取重启流程中，停机前先做最佳努力 stop 点击；若点击成功则软等待 2 秒，再继续停机，且日志明确区分三种可验收分支。

## Critical Decisions
- Decision 1: 保持 best-effort，不设置硬门槛 - 不影响正常停机与拉取重启。
- Decision 2: 点击 stop 后软等待 2 秒 - 提高停机前 stop 生效稳定性，同时可控上限。
- Decision 3: 统一日志语义 - 明确“已点击 stop / 非生成态无需点击 / 页面不可用继续停机”。

## Tasks

- [x] 🟩 **Step 1: 统一停机前 stop 状态与日志（`src/index.ts`）**
  - [x] 🟩 细化停机前 stop 的分支结果
  - [x] 🟩 固化三类日志文案

- [x] 🟩 **Step 2: 点击 stop 后增加 2s 软等待（`src/index.ts`）**
  - [x] 🟩 仅点击成功时触发软等待
  - [x] 🟩 超时后继续停机

- [x] 🟩 **Step 3: 验证与收尾**
  - [x] 🟩 检查类型与基本 lint
  - [x] 🟩 更新文档进度为完成态
