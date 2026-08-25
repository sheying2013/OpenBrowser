# 自动化模块

## 模块

| 文件 | 说明 |
|------|------|
| `local-api-server.js` | 本机 HTTP API（默认 `127.0.0.1:50325`） |
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
curl -s -H 'api-key: YOUR_API_KEY' 'http://127.0.0.1:50325/api/rpa/tasks?limit=20'

# 单个任务详情（含 process_result 与持久化日志）
curl -s -H 'api-key: YOUR_API_KEY' http://127.0.0.1:50325/api/rpa/tasks/TASK_ID

# 删除单个任务记录
curl -s -X DELETE -H 'api-key: YOUR_API_KEY' http://127.0.0.1:50325/api/rpa/tasks/TASK_ID
```

为避免 `rpa-store.json` 无限膨胀，任务记录有容量控制（可用环境变量调整）：

- `OPENBROWSER_RPA_TASK_HISTORY`：最多保留的已完结任务数（默认 100；`pending/running` 任务不会被淘汰）
- `OPENBROWSER_RPA_RESULT_CHAR_LIMIT`：结果中单个字符串的最大字符数（默认 20000；数组和对象结构保留）
- `OPENBROWSER_RPA_STORE_LIMIT_MB`：`rpa-store.json` 总大小上限（默认 50MB）。超限时依次清理旧的已完结任务、日志，再削减结果载荷；计划、模板和未完结任务不受影响

`screenshotPage` 截图会保存到 `rpa-output/`，并把文件路径写入结果变量。

## 启动

随 OpenBrowser 主进程自动启动 Local API。

环境变量：

- `OPENBROWSER_API_PORT`（默认 `50325`）
- `OPENBROWSER_API_KEY`（可选；不设置时会在本次启动中自动生成，请以 UI 的 API & MCP 页面显示为准）

## HTTP 示例

```bash
# 版本
curl -s -H 'api-key: YOUR_API_KEY' http://127.0.0.1:50325/api/getVersion

# 环境列表
curl -s -H 'api-key: YOUR_API_KEY' http://127.0.0.1:50325/api/v1/user/list

# 启动环境
curl -s -X POST http://127.0.0.1:50325/api/v1/browser/start \
  -H 'api-key: YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"PROFILE_ID"}'

# 窗口同步（第一个为主控）
curl -s -X POST http://127.0.0.1:50325/api/sync/start \
  -H 'api-key: YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"profile_ids":["A","B","C"],"operate":"click,move,scroll,keyboard"}'

# 新建环境（MCP/API 的 snake_case 字段会映射到引擎结构）
curl -s -X POST http://127.0.0.1:50325/api/v1/user/create \
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
curl -s -X POST http://127.0.0.1:50325/api/v2/browser-profile/update \
  -H 'api-key: YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"profile_id":"demo-001","start_url":"https://openai.com","fingerprint":{"os":"macOS"}}'

# 复制环境（不复制 Cookie/凭据/出口检测/指纹身份）
curl -s -X POST http://127.0.0.1:50325/api/v2/browser-profile/duplicate \
  -H 'api-key: YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"source_profile_id":"demo-001","name":"Demo Copy"}'

# 检测并持久化环境出口 IP / 国家 / 时区
curl -s -X POST http://127.0.0.1:50325/api/proxy/check-profile \
  -H 'api-key: YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"profile_id":"demo-001"}'

# RPA 步骤
curl -s -X POST http://127.0.0.1:50325/api/rpa/run \
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
OPENBROWSER_API_PORT=50325 OPENBROWSER_API_KEY=YOUR_API_KEY node automation/mcp-server.js
```

`YOUR_API_KEY` 从 UI 的 API & MCP 页面复制；Cursor 配置示例见 `mcp-server.js` 文件头注释。

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
OPENBROWSER_MCP_MODE=read OPENBROWSER_API_PORT=50325 OPENBROWSER_API_KEY=YOUR_API_KEY node automation/mcp-server.js

# 黑名单：禁用指定工具
OPENBROWSER_MCP_TOOL_BLACKLIST='["create_profile","rpa_run_steps"]' node automation/mcp-server.js

# 白名单：只保留指定工具
OPENBROWSER_MCP_TOOL_WHITELIST='["list_profiles","start_profile","stop_profile"]' node automation/mcp-server.js
```

运行时可通过 `mcp_update_policy`（仅 `admin` 模式）调整当前进程的策略；持久策略请写入 MCP 客户端的环境变量。

### MCP 错误提示

Local API 返回 401 时，MCP 会明确提示 `Set OPENBROWSER_API_KEY to the key shown on the OpenBrowser API & MCP page`，避免把 401 静默包装成其他错误。
