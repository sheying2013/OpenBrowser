# 自动化模块

## 模块

| 文件 | 说明 |
|------|------|
| `local-api-server.js` | 本机 HTTP API（默认 41000-59999 动态随机端口，通过 `automation-info.json` 发现） |
| `rpa-engine.js` | CDP 步骤流 RPA |
| `rpa-store.js` | 计划/任务 JSON 存储 |
| `window-sync-bridge.js` | 窗口同步控制面 → `live-sync-v5` |
| `app-center.js` | 应用中心（团队 / 推荐 / 本地） |
| `mcp-server.js` | stdio MCP（给 Cursor/Claude） |
| `automation-selftest.js` | 自动化模块自测 |
| `mcp-control-selftest.js` | MCP 权限 / 指纹控制 / Local API 控制面自测 |
| `index.js` | 主进程挂载入口 |

## 验证

```bash
npm run selftest:automation
# 或
node automation/automation-selftest.js

# MCP 完整控制面（环境、指纹、代理、扩展、同步、RPA、权限策略）
npm run selftest:mcp
```

## 日志

RPA 任务启动、成功、失败会写入本机诊断日志，默认位置：

- Windows: `%APPDATA%\\openbrowser\\logs\\rpa-automation.log`
- macOS: `~/Library/Application Support/openbrowser/logs/rpa-automation.log`
- Linux: `~/.config/openbrowser/logs/rpa-automation.log`

查看最近记录：

```bash
npm run log:rpa
# 或
node scripts/read-rpa-log.js --tail 120
```

如果内核拒绝 CDP/RPA 自动化，任务结果和日志会明确写出原因，避免只看到 `Browser exited before CDP was ready`。

## 任务结果与容量控制

任务完成后，`POST /api/rpa/run` 的返回值和任务的 `process_result` 都包含：

| 字段 | 说明 |
|------|------|
| `variables` | 运行结束时的变量快照（`evaluate` / `getElement` 等步骤存入的值，自动限制单个字符串大小） |
| `exports` | 可选。`variableOperation(type=export)` 显式导出的字段集合 |
| `remarks` | `saveremark` 步骤收集的备注 |

历史任务查询：

```bash
# 任务列表（新到旧，支持 status / limit 过滤）
curl -s -H 'api-key: YOUR_API_KEY' "http://127.0.0.1:${PORT}/api/rpa/tasks?limit=20"

# 单个任务详情（含 process_result 与持久化日志）
curl -s -H 'api-key: YOUR_API_KEY' "http://127.0.0.1:${PORT}/api/rpa/tasks/TASK_ID"

# 删除单个任务记录
curl -s -X DELETE -H 'api-key: YOUR_API_KEY' "http://127.0.0.1:${PORT}/api/rpa/tasks/TASK_ID"
```

为避免 `rpa-store.json` 无限膨胀，任务记录有容量控制（可用环境变量调整）：

- `OPENBROWSER_RPA_TASK_HISTORY`：最多保留的已完结任务数（默认 100；`pending/running` 任务不会被淘汰）
- `OPENBROWSER_RPA_RESULT_CHAR_LIMIT`：结果中单个字符串的最大字符数（默认 20000；数组和对象结构保留）
- `OPENBROWSER_RPA_STORE_LIMIT_MB`：`rpa-store.json` 总大小上限（默认 50MB）。超限时依次清理旧的已完结任务、日志，再削减结果载荷；计划、模板和未完结任务不受影响

`screenshotPage` 截图会保存到 `rpa-output/`，并把文件路径写入结果变量。

## 启动与端口发现

随 OpenBrowser 主进程自动启动 Local API。默认在 `41000-59999` 范围内随机选择高位端口（避开 50325 等特征端口），并将实际端口写入 `userData/automation-info.json`。

读取实际端口示例：
```bash
# 从发现文件读取当前端口（macOS 为例）
PORT=$(jq -r '.port' "$HOME/Library/Application Support/OpenBrowser/automation-info.json")
```

环境变量：

- `OPENBROWSER_API_PORT`（可选；设置后严格固定端口，不走动态随机，便于既有脚本兼容）
- `OPENBROWSER_API_KEY`（可选；不设置时会生成并持久化到 `userData/local-api-key.txt`）
- `OPENBROWSER_API_KEY_FILE`（可选；独立 MCP 进程从该文件读取 key，适合不把 key 直接写进客户端配置）

## HTTP 示例

```bash
# 版本
curl -s -H 'api-key: YOUR_API_KEY' "http://127.0.0.1:${PORT}/api/getVersion"

# 环境列表
curl -s -H 'api-key: YOUR_API_KEY' "http://127.0.0.1:${PORT}/api/v1/user/list"

# 启动环境
curl -s -X POST "http://127.0.0.1:${PORT}/api/v1/browser/start" \
  -H 'api-key: YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"PROFILE_ID"}'

# 窗口同步（第一个为主控）
curl -s -X POST "http://127.0.0.1:${PORT}/api/sync/start" \
  -H 'api-key: YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"profile_ids":["A","B","C"],"operate":"click,move,scroll,keyboard"}'

# 新建环境（MCP/API 的 snake_case 字段会映射到引擎结构）
curl -s -X POST "http://127.0.0.1:${PORT}/api/v1/user/create" \
  -H 'api-key: YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "profile_id":"demo-001",
    "name":"Demo",
    "proxy":"Direct",
    "start_url":"https://example.com",
    "user_agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "resolution":"1920x1080",
    "timezone":"Asia/Shanghai",
    "hardware_concurrency":8,
    "fingerprint":{"os":"Windows 11","canvasId":4242}
  }'

# 更新环境
curl -s -X POST "http://127.0.0.1:${PORT}/api/v2/browser-profile/update" \
  -H 'api-key: YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"profile_id":"demo-001","start_url":"https://openai.com","fingerprint":{"os":"macOS"}}'

# 复制环境（不复制 Cookie/凭据/出口检测/指纹身份）
curl -s -X POST "http://127.0.0.1:${PORT}/api/v2/browser-profile/duplicate" \
  -H 'api-key: YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"source_profile_id":"demo-001","name":"Demo Copy"}'

# 检测并持久化环境出口 IP / 国家 / 时区
curl -s -X POST "http://127.0.0.1:${PORT}/api/proxy/check-profile" \
  -H 'api-key: YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"profile_id":"demo-001"}'

# RPA 步骤
curl -s -X POST "http://127.0.0.1:${PORT}/api/rpa/run" \
  -H 'api-key: YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "profile_id":"A",
    "steps":[
      {"type":"goto","url":"https://example.com"},
      {"type":"wait","ms":800},
      {"type":"click","selector":"a"},
      {"type":"type","selector":"input","text":"hello","human":true}
    ]
  }'
```

## MCP

```bash
# 自动读取发现文件
OPENBROWSER_API_KEY_FILE=/path/to/local-api-key.txt node automation/mcp-server.js
# 或显式指定端口
OPENBROWSER_API_PORT=45000 OPENBROWSER_API_KEY_FILE=/path/to/local-api-key.txt node automation/mcp-server.js
```

`OPENBROWSER_API_KEY_FILE` 使用 OpenBrowser API & MCP 页面显示的本机 key 文件路径；也可以把 `OPENBROWSER_API_KEY=YOUR_API_KEY` 直接写入客户端环境。Cursor 配置示例见 `mcp-server.js` 文件头注释。

MCP 提供 45+ 个工具，覆盖：

- 系统：状态、API Key 校验、MCP 权限策略、隔离审计
- 环境：创建 / 更新 / 删除 / 复制 / 启动 / 停止 / 批量停止 / 代理检测
- 指纹：读取、覆盖、重置、每次启动重新生成
- 代理库：列表 / 创建 / 批量导入 / 更新 / 删除 / 测试
- 扩展：列表 / 分配
- 窗口同步：设置 / 状态 / 启动 / 停止 / 重启 / 排列
- RPA：计划 / 任务 / 模板 / 运行 / 停止 / 结果查询 / 历史清理
- 应用中心：列表

### 权限控制

每个工具标注最低权限等级，`tools/list` 和 `tools/call` 都会执行检查：

| 等级 | 可操作内容 |
|------|-----------|
| `admin` | 全部工具，含修改 MCP 权限策略 |
| `manage` | 环境 CRUD、指纹覆盖、代理库、扩展、RPA 计划/模板、同步设置 |
| `run` | 启动/停止环境、窗口同步、RPA 执行、代理测试、扩展分配 |
| `read` | 列表、状态、指纹读取、隔离审计 |

启动 MCP 时可限制权限：

```bash
# 只读模式：只暴露 list/status/fingerprint 等查询工具
OPENBROWSER_MCP_MODE=read OPENBROWSER_API_KEY=YOUR_API_KEY node automation/mcp-server.js

# 黑名单：禁用指定工具
OPENBROWSER_MCP_TOOL_BLACKLIST='["create_profile","rpa_run_steps"]' node automation/mcp-server.js

# 白名单：只保留指定工具
OPENBROWSER_MCP_TOOL_WHITELIST='["list_profiles","start_profile","stop_profile"]' node automation/mcp-server.js
```

运行时可通过 `mcp_update_policy`（仅 `admin` 模式）调整当前进程的策略；持久策略请写入 MCP 客户端的环境变量。

### MCP 错误提示

Local API 返回 401 时，MCP 会明确提示设置 `OPENBROWSER_API_KEY` 或 `OPENBROWSER_API_KEY_FILE`，避免把 401 静默包装成其他错误。

---

## 内核版本跟踪流水线 (Kernel Version Drift Monitor)

依据架构规划（DEV-REPORT-2026-11 F11），OpenBrowser 建立了自动化内核版本漂移监控体系，并接入 GitHub Actions 定时巡检。

### 1. 流水线定位与运行行为

- **工作流文件**：`.github/workflows/kernel-track.yml`
- **调度策略**：每日运行一次（UTC 03:00 / 北京时间 11:00）+ `workflow_dispatch` 手动触发。
- **运行环境**：Ubuntu Latest, Node.js 20。
- **执行命令**：`node scripts/kernel-track.mjs --ci [--baseline <path>]`
- **最小必要权限**：`contents: read`、`issues: write`。
- **多源监控矩阵**：
  - Google Chrome for Testing (CfT) 官方四渠道（Stable/Beta/Dev/Canary）；
  - ChromiumDash 跨平台稳定渠道（Windows / Mac / Linux）；
  - Wayfern 供应商版本镜像源。
- **防频蔽与容灾**：单次请求超时上限 8000ms，失败自动执行 3 次指数退避重试（1s、2s 间隔）。
- **CI 缓存隔离**：CI 环境自动改用 OS 临时目录缓存（`os.tmpdir()`），严格禁止向代码仓库提交缓存文件、内核二进制或种子文件。

### 2. 基线对比机制 (Baseline Drift)

- **基线存储**：`kernels/meta/kernel-track-baseline.json`
- **判定逻辑**：
  - 抓取远端各渠道最新版本后，与基线中记录的 `benchmark` 及 `local` 版本逐项比对；
  - 若官方 Chrome Stable 或 Wayfern 出现新版本里程碑，标记为 `hasDrift = true` 并输出变更明细；
  - 若所有版本与基线记录一致，标记为 `hasDrift = false`。

### 3. GitHub Issue 自动化管理

- **静默机制**：**无新版本差异时完全静默**，不发起任何 issue 变更，工作流仅输出 Step Summary 并上传报告构件。
- **差异响应**：当检测到版本漂移（或手动调度时开启 `force_alert`）时，通过 GitHub CLI (`gh`) 自动化处置：
  - **固定标题**：`[Kernel Tracker] Chromium Upstream Version Drift Alert`
  - **幂等性维护**：先检索当前仓库中标题相同的处于 `open` 状态的 Issue。若已存在，通过 `gh issue edit` 刷新正文报告并追加时间戳跟进评论；若不存在，则通过 `gh issue create` 创建新 Issue，杜绝重复开单刷屏。
- **Issue 报告内容**：
  1. 检测时间、官方最新 Stable 版本号、主干 Milestone 及本地代码常量；
  2. 基线对比变更详情表格（组件名、基线版本、当前版本、里程碑差值）；
  3. 各平台内核 Seed 与官方最新版本的差距矩阵与风险等级（HIGH / MEDIUM / LOW）；
  4. 人工门禁升级原则与行动指引（严禁无人值守替换内核，需评估 Hook、指纹区间及 CDP 兼容性）。

### 4. 本地执行与回归验证

```bash
# 本地常规巡检（人类可读输出）
npm run track:kernel

# 输出结构化 JSON
node scripts/kernel-track.mjs --json

# 模拟 CI 模式运行（输出到 reports/kernel-track/latest.json）
node scripts/kernel-track.mjs --ci --baseline kernels/meta/kernel-track-baseline.json

# 运行完整内核跟踪流水线自测（31 项回归断言）
npm run selftest:kerneltrack
```
