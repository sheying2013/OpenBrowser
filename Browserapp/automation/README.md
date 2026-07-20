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
| `index.js` | 主进程挂载入口 |

## 验证

```bash
npm run selftest:automation
# 或
node automation/automation-selftest.js
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

## 启动

随 OpenBrowser 主进程自动启动 Local API。

环境变量：

- `OPENBROWSER_API_PORT`（默认 `50325`）
- `OPENBROWSER_API_KEY`（可选；设置后请求需带 `api-key` 头）

## HTTP 示例

```bash
# 版本
curl -s http://127.0.0.1:50325/api/getVersion

# 环境列表
curl -s http://127.0.0.1:50325/api/v1/user/list

# 启动环境
curl -s -X POST http://127.0.0.1:50325/api/v1/browser/start \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"PROFILE_ID"}'

# 窗口同步（第一个为主控）
curl -s -X POST http://127.0.0.1:50325/api/sync/start \
  -H 'Content-Type: application/json' \
  -d '{"profile_ids":["A","B","C"],"operate":"click,move,scroll,keyboard"}'

# RPA 步骤
curl -s -X POST http://127.0.0.1:50325/api/rpa/run \
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
OPENBROWSER_API_PORT=50325 node automation/mcp-server.js
```

Cursor 配置示例见 `mcp-server.js` 文件头注释。
