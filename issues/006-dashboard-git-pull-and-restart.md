# 006 - Dashboard 页面：Git Pull + 重启

**类型**: feature  
**优先级**: normal  
**预估**: medium

---

## TL;DR

在现有 Dashboard（端口 9000）上增加「拉取代码并重启」能力：页面上一个按钮/操作，触发当前机器执行 `git pull`，拉完后自动重启应用，方便多台已 clone 的电脑在代码更新到 GitHub 后一键同步并重启。

---

## 当前 vs 期望

| 当前 | 期望 |
|------|------|
| 代码推到 GitHub 后，每台机器需手动 SSH/登录执行 `git pull` 再重启 | 在 Dashboard 页点击「拉取并重启」，当前机器自动执行 git pull，成功后重启进程 |

---

## 涉及文件（建议）

- `src/server.ts` — 新增 API（如 `POST /api/pull-and-restart`），内部：执行 `git pull`（需 `child_process` 或 `execa`），成功后调现有重启逻辑（先 stop 再 start，或 process.exit + 外部进程管理重启）
- Dashboard 单页 HTML（在 `server.ts` 的 `getIndexHtml()` 内）— 增加「拉取并重启」按钮，调用新 API，并展示 pull 结果（成功/失败/冲突等）

---

## 实现要点

1. **安全**：API 仅 localhost（现有 server 已绑定 127.0.0.1），避免公网触发 pull+重启。
2. **执行目录**：`git pull` 应在项目根目录执行（如 `process.cwd()` 或 `import.meta.url` 解析出的项目根）。
3. **重启方式**：若当前用 `node` 直接跑，可 `runner.stop()` 后 `process.exit(0)`，由 systemd/supervisor/pm2 等拉起来；或项目内用 `child_process.spawn` 再起一个 node 进程后 exit。需与现有 `runner.start` 的语义统一（是否由 dashboard 子进程跑 runner）。
4. **输出反馈**：pull 的 stdout/stderr 可经 API 返回给前端，便于显示「已是最新」或「冲突/失败」信息。
5. **冲突处理**：pull 失败（如冲突）时不应重启，仅返回错误信息。

---

## 风险与备注

- **权限**：确保运行进程对项目目录有 git 写权限，且能执行 `git pull`（如已配置好 remote、无敏感 credential 弹窗）。
- **并发**：同一时间只允许一次 pull-and-restart，避免重复点击导致多次重启或 pull 冲突；可用简单锁或状态位。
- **多机**：每台机器只对自己的实例生效；若有多台，每台各自打开自己的 Dashboard 执行一次即可。
