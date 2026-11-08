# dsh-plugin-gpustack

把 [GPUStack v2](https://gpustack.ai) 的 `/docs` 运维接口做成 DeepSeek Harness 的 Agent 工具。安装后，模型可以直接盘点集群、部署模型、看实例日志、等就绪、跑推理验收、查用量，也能通过通用请求覆盖其余 200+ 端点。

- API Key 只存在本机加密文件里（AES-256-GCM），**不进入工具参数、工具结果或会话记录**。
- 所有写操作受 `allowWrites` 开关控制；`delete` 需要显式 `confirm=true`。
- 每次调用都写一行审计日志（不含请求体与查询串）。

## 安装

插件是以 `dsh.bundle.patch` 声明的组合包（bundle），装进当前 profile 即可：

```powershell
# 从 npm 安装
dsh plugin --profile desktop add dsh-plugin-gpustack

# 或先从源码克隆，再按目录安装
git clone https://github.com/zh-Littlebird/dsh-plugin-gpustack
dsh plugin --profile desktop add ./dsh-plugin-gpustack
```

Agent 场景等价写法：调用 `plugin_manager` 的 `install_bundle`，`target` 传包名 `dsh-plugin-gpustack` 或本地目录绝对路径。

安装后 `gpustack_*` 工具在**下一个会话**（或工具表刷新后）可用；设置页与插件行配置页由客户端模块提供，重新加载页面后生效（通常插件状态刷新后即可看到）。重启 Harness 一定生效。

## 配置集群与凭据

**图形界面（推荐）**：打开「设置 → GPUStack」，或在「插件」页里打开 dsh-plugin-gpustack 的配置页。

- 填写集群地址（可粘贴 `/docs` 链接，会自动去掉后缀）与 API Key，点「保存」后立即生效，不需要重启。
- 「测试连接」分项显示 healthz/version、管理接口身份、推理接口模型数。
- 「操作权限」按类别开关，另有写操作总开关；可单独关掉删除、部署、通用接口写等。
- 可调整超时与组织 ID。
- 密钥只写入本机加密文件，保存后不再回显。

操作权限分类：

| 分类 | 控制的操作 |
|---|---|
| 部署模型 `deploy` | `gpustack_deploy_model` |
| 修改规格 `update` | `gpustack_update_model`（副本、启动参数、env、放置） |
| 重启与回滚 `restart` | `gpustack_model_action` 的 restart / rollback / preview-rollback |
| 删除资源 `delete` | `gpustack_model_action delete`，以及 `gpustack_request` 的 DELETE |
| 通用接口写操作 `raw` | `gpustack_request` 的 POST / PUT / PATCH |
| 推理调用 `inference` | `gpustack_chat`（真实 /v1 请求，占用 GPU） |

`allowWrites` 是写操作总开关：关闭后前五类全部拒绝（只读模式），`inference` 仍按自己的开关执行。

命令行等价操作（模型不参与、也看不到输入）：

```powershell
cd 'dsh-plugin-gpustack'
node scripts/dsh-gpustack.mjs setup --base-url http://192.0.2.10:31901
node scripts/dsh-gpustack.mjs set --api-key          # 隐藏输入，形如 gpustack_xxx
node scripts/dsh-gpustack.mjs status
node scripts/dsh-gpustack.mjs test                   # 直接探活 /healthz、/version、/v2/users/me
```

优先级：环境变量 > `site.json`（设置页/CLI 写入）> 插件配置（`cordis.patch.yml` 的部署默认值）。

| 变量 | 作用 |
|---|---|
| `GPUSTACK_BASE_URL` | 集群根地址，优先级最高（设置页会显示为不可编辑） |
| `GPUSTACK_API_KEY` | API Key，`secretsBackend=auto` 时优先于文件 |
| `DSH_GPUSTACK_DATA_DIR` | 覆盖数据目录（默认 `$DSH_HOME/gpustack`） |

数据文件：

| 文件 | 内容 |
|---|---|
| `site.json` | 集群地址、写总开关、分类权限、超时、组织 ID（非机密） |
| `credentials.json` + `master.key` | 加密后的 API Key |
| `audit.log` | 调用审计（tool/method/path/status/耗时） |

## 插件配置（cordis.patch.yml）

这些是部署默认值；设置页保存的值优先于它们。

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `''` | 集群根地址（设置页未配置时使用） |
| `apiKeyEnv` | `GPUSTACK_API_KEY` | 从哪个环境变量读 Key |
| `organizationId` | `''` | 非空时每个请求带 `x-organization-id`（跨组织操作） |
| `secretsBackend` | `auto` | `auto`/`env`/`file`/`none` |
| `timeoutMs` | `60000` | 单请求超时 |
| `maxResponseBytes` | `8388608` | 响应体上限，超出报错而不是截断成坏 JSON |
| `allowWrites` | `true` | 写操作总开关；关闭后五类写操作全部拒绝（只读模式） |
| `permissions` | 全部 `true` | 分类开关：`deploy`/`update`/`restart`/`delete`/`raw`/`inference`；设置页保存的值优先 |
| `audit` | `true` | 是否写审计日志 |
| `debug` | `false` | 打印脱敏后的请求行到 stderr |

## 工具

| 工具 | 覆盖的接口 | 用途 |
|---|---|---|
| `gpustack_config` | `site.json` | 查看/设置集群地址（不接收 Key） |
| `gpustack_test` | `/healthz` `/readyz` `/version` `/v2/users/me` `/v1/models` | 连通性与凭据自检，分项返回失败原因 |
| `gpustack_inventory` | `GET /v2/clusters` `/v2/workers` `/v2/gpu-devices` | 集群/节点/GPU 盘点与放置条件 |
| `gpustack_models` | `GET /v2/models`、`/{id}`、`/{id}/instances` | 模型列表或单个模型 + 实例详情 |
| `gpustack_deploy_model` | `POST /v2/models` | 部署（ModelCreate 常用字段 + `extra` 高级字段） |
| `gpustack_update_model` | `GET` + `PUT /v2/models/{id}`（+ `restart`） | 改副本/参数/env，报告真正变化的字段 |
| `gpustack_model_action` | `restart` / `rollback` / `rollback-preview` / `DELETE` | 重建、回滚、删除（删除必须 confirm） |
| `gpustack_logs` | `GET /v2/model-instances/{id}/logs` | 实例日志（text/plain，支持 previous/tail/分段） |
| `gpustack_wait_model` | `GET /v2/models/{id}` 轮询 | 等 running/error，超时返回 timedOut |
| `gpustack_chat` | `POST /v1/chat/completions` | 推理验收（OpenAI 兼容） |
| `gpustack_usage` | `GET /v2/usage/summary`、`/meta`，`POST /v2/usage/breakdown` | 用量汇总与明细 |
| `gpustack_request` | 任意端点 | 其余接口的通用通道（写操作需 confirm） |

注意：`gpustack_models` 的 `state` 参数是 `GET /v2/models` 的**就绪过滤**（`ready`/`not_ready`/`stopped`），不是响应里的模型状态字段；要按 `pending|partial|running|error` 筛选模型，用 `modelState`（在当前返回页内做客户端过滤）。

## 典型流程

**部署并验收**

1. `gpustack_inventory` — 确认 worker ready、卡型与余量。
2. `gpustack_deploy_model` — 提交 `name/source/backend/replicas/...`。
3. `gpustack_wait_model` — 等到 `state=running`（不要凭 200 报成功）。
4. `gpustack_chat` — 用模型名跑一次真实推理。
5. `gpustack_models modelId=<id>` — 核对实例落在预期 worker/GPU。

**排障**

1. `gpustack_models modelId=<id>` — 看 `state`、`state_message`、实例状态。
2. `gpustack_logs modelId=<id>` — 镜像/模型路径/OOM/参数问题的第一现场；重启过就加 `previous=true`。
3. 修复后 `gpustack_model_action action=restart`，再 `gpustack_wait_model`。

**改配置**

`gpustack_update_model` 只更新规格；改 `backendParameters`/`env`/镜像/PD 配置时必须 `restart=true`（或随后单独 restart），否则进程仍跑旧参数。`restart` 是整组重建且非幂等，`restarting_since` 未清空前再次调用返回 409。

## 安全边界

- Key 通过设置页 / 本地 CLI / 环境变量进入进程，工具参数里没有任何接收密钥的字段。
- 设置页的 `/gpustack-ui` 接口只接受本机回环请求；写请求还要求页面自定义头与同源 Origin，普通跨站请求无法调用。
- 请求强制同源（不允许 path 指向其他站点）、拒绝跟随重定向，避免 Key 被转发。
- 日志与响应中的 `gpustack_...` 形态字符串、`api_key`/`token`/`password` 等字段会被脱敏。
- `gpustack_request` 的管理写操作受分类权限（`raw` / `delete`）与 `confirm=true` 双重约束；`gpustack_model_action delete` 同样要求确认。
- 审计日志不记录请求体与查询串，避免 prompt、模型规格、token 落盘。

## 开发与测试

```powershell
cd 'dsh-plugin-gpustack'
node tests/run.mjs
```

测试用本地 mock GPUStack 覆盖：路径/URL 规范化、参数校验、12 个工具的注册与 schema、分类权限（关闭部署/删除/推理时工具被拒绝，其余放行）、集群盘点、模型列表/详情、部署、更新合并、重启/回滚/删除确认、text/plain 日志、等待就绪、推理、用量、通用请求、401 映射与脱敏；设置接口（state/保存/密钥写入/分类权限/连接测试/跨站拒绝）；客户端模块加载、两个插槽注册与首屏渲染。

## 限制

- 文件导入/导出（`/v2/models/export`、zip 下载）不在 typed 工具内，用 `gpustack_request` 或 curl 落盘。
- 压测（`POST /v2/benchmarks`）通过 `gpustack_request` 使用；创建前确认目标、时长与对线上流量的影响。
- 看板类端点（`/dashboard`）响应结构未在 openapi 声明，请用 `gpustack_request` 查看原始响应。
- 一个插件实例绑定一个集群（`baseUrl`）；需要多集群时切换 `baseUrl` 或部署多份配置。
- 设置页写入的是 `site.json`；`cordis.patch.yml` 里的同名值作为默认值，环境变量优先级最高。
