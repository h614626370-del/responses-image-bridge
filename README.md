# Responses 生图中间服务

面向客户端只支持 Responses 流式生图、但需要把图生图直接送到图片模型的场景。
本项目独立于 sub2api，不修改原项目。

## 工作方式

```text
北熊或其他客户端
  POST /v1/responses
  model=gpt-5.5, stream=true
            |
            v
本服务：如果请求中带 Base64 原图，转换为 /v1/images/edits
  模型取 tools[].model=gpt-image-2；提示词和原图上传给图片接口
  没有原图时仍按旧路径将主控改为 gpt-5.6-luna，stream=false
  默认不设本地并发上限，由 sub2api 控制用户及账号并发
  等待期间每 5 秒向客户端发送 SSE 注释心跳
            |
            v
https://kkflow.org/v1/images/edits（图生图）
或 https://kkflow.org/v1/responses（其他生图）
            |
            v
本服务：将完整结果转换成 Responses SSE 事件
  output_item.done 中携带图片 result
  response.completed 中保留完整 output 与上游返回的 usage
```

**不是实时预览生成。** 等待期间只发 `: keep-alive` 注释，不伪造进度。
收到上游结果后才发送 `response.created`、`response.in_progress`、输出项事件及最终事件。
同一结果中的 response ID、item ID 保持一致，图片在完成项和最终快照中会重复出现，这是同一图片的两个协议位置。
直接图片接口不返回原生 Responses 快照；该路径的 Responses 事件和 ID 由中间服务合成。
客户端应按 item ID 去重。

## 当前验证范围

- Node.js 24.0.0 下的本地 HTTP/SSE 集成测试。
- 模拟 30 个客户端同时请求，验证排队、并发限制、30 次上游调用且无自动重试。
- 检查心跳在上游结果返回之前实际到达客户端。
- 覆盖同步/流式客户端、上游失败、超时、断开、过大请求及响应、鉴权、错误脱敏。
- 未取得北熊软件，**不能宣称已兼容北熊的真实解析器**。
- 2026-09-17 真实 Responses 路径测试先遇到不支持的 `background:false`（已修复），再遇到上游 HTTP 504（约 600 秒）；未获得真实图片。
- 图生图直连路径只通过本地模拟上游测试，未对 kkflow 发起收费联调。
- 官方协议依据：`https://developers.openai.com/api/docs/guides/tools-image-generation`。

## 环境

Node.js >= 22.15，建议 Node.js 24。无第三方运行依赖，不需要 npm install。
当前开发机器已安装 Node.js 24.0.0，不缺运行环境。

## 本机启动

在项目目录运行：

```powershell
npm start
```

默认监听 `127.0.0.1:8787`。健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/healthz
```

同机客户端配置：

| 字段 | 内容 |
|---|---|
| Base URL | `http://127.0.0.1:8787` |
| API Key | 原来在 kkflow 使用的 Key |
| 生图模型 | `gpt-image-2` |
| Responses 模式 | 勾选 |

也支持客户端使用带 `/v1` 的 Base URL。服务同时接受 `/v1/responses`、`/responses`。
内置 `/v1/models` 和 `/models` 是本服务的静态兼容列表，不是上游账号权限探测。

**127.0.0.1 只适用于软件与服务运行在同一台电脑。**
如果软件实际从云端发请求，或客户在另一台电脑上使用，必须部署到客户可访问的服务器。

## 配置

### 管理后台

打开 `http://127.0.0.1:8787/admin/`，使用首次启动生成的 `data/admin-token.txt` 中的口令登录。
也可通过 `MANAGEMENT_KEY` 指定至少 24 字符的独立管理口令。

- 请求日志：每 3 秒轮询执行中和最近 12 小时的全部记录，查看路径、图片模型、原图张数、阶段时间线、心跳、上游 HTTP 状态和 request ID；支持筛选和导出。
- 转发设置：主控模型、上游地址、并发、排队、总超时、心跳和管理凭据；保存后对新请求生效。
- 运维：暂停新请求、恢复接入、取消单条请求。暂停状态不跨重启保存。
- 账号诊断：配置 sub2api 管理站地址与管理员 Key 后，只读查询 OpenAI 账号、分组及关联用量。

**三种凭据请分清：** 管理口令登录本后台；sub2api 管理员 Key 访问只读管理接口；
用户自己的生图 Key 填在北熊中，由中间服务随请求透传给上游，无需在后台配置。
管理员 Key 不能替代生图 Key，不会用于生图调用。
诊断不会修改账号、替你指定命中账号，也不能仅靠账号列表证明它支持某个模型。
用量关联依赖上游返回的 request ID 与 sub2api 记录一致，未匹配不等于未扣费。

保存的界面配置优先于 `.env` 中的可编辑项。监听地址与端口仍由 `.env` 决定。
`DATA_DIR` 默认 `data`；配置中的密钥使用 AES-256-GCM 加密，解密主密钥为同目录 `master.key`。
这不是外部密钥保险库：拿到整个数据目录仍可解密，因此应限制目录权限，备份时一并保护。
密钥不会回显给网页；空白密码框保留原值，清除需勾选对应选项。
远程管理必须启用 HTTPS，建议设置 `COOKIE_SECURE=true` 并限制管理入口访问来源。

`.env.example` 是无密钥模板。创建 `.env` 后 `npm start` 会自动读取；系统环境变量优先。
当前开发用 `.env` 不包含任何 API Key。

| 配置 | 默认值 | 用途 |
|---|---|---|
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `8787` | 端口 |
| `UPSTREAM_BASE_URL` | `https://kkflow.org` | 固定上游，不允许客户端选择上游地址 |
| `CONTROL_MODEL` | `gpt-5.6-luna` | 强制使用的顶层主控 |
| `DIRECT_EDITS` | `true` | 带原图的单轮请求转为图片编辑接口；后台可关闭 |
| `HEARTBEAT_MS` | `5000` | 客户端 SSE 心跳间隔 |
| `MAX_CONCURRENT` | 空 | 可选本地并发上限；留空交给 sub2api 控制 |
| `MAX_QUEUE` | `60` | 最大排队数，超出立即 HTTP 429 |
| `REQUEST_TIMEOUT_MS` | `900000` | 排队、上游等待和交付的总预算，15 分钟 |
| `MAX_BODY_BYTES` | `33554432` | 单个请求体限制，32 MiB |
| `MAX_RESPONSE_BYTES` | `67108864` | 单个上游结果限制，64 MiB |
| `SSE_DONE_SENTINEL` | `false` | 额外附加 `data: [DONE]`，仅用于确有需求的客户端 |

要保留 30 个实际上游并发，可设 `MAX_CONCURRENT=30`。
默认留空，不在中间服务额外排队；只有填写本地并发上限时，本地排队设置才生效。
留空不是自动读取用户额度。当前 sub2api 的 `/v1/usage` 不返回用户并发上限。
用户在其他客户端产生的请求也会占用 sub2api 并发，仍以上游实际调度为准。
本地不限制会增加中间服务内存压力；共享部署时可按机器容量设置总保护上限。
排队请求也保持心跳，但队列会增加总体等待时间；超出总预算会失败。

### 鉴权方式

**仅支持透传客户端 Key。**
客户端填写自己的上游 Key，服务仅从请求头取 Key 并转交固定上游，不保存到磁盘。

每个请求都使用该客户端传入的 `Authorization: Bearer ...`，不同用户的 Key 不会替换为共享 Key。
Key 的有效性、余额、分组及用户并发由 sub2api 校验；中间服务仅检查 Bearer 格式。
不支持固定上游 Key 或独立客户访问 Key，旧环境变量不再生效，旧持久化凭据会在启动时移除。
远程部署可设 `HOST=0.0.0.0`，必须通过 HTTPS 保护传输，建议限制访问来源并设置入口速率限制。
无效 Key 也会占用中间服务连接资源；本服务不含客户余额、配额或计费功能。

## 请求改写边界

- 仅处理包含原生 `tools[].type="image_generation"` 的 Responses 请求。
- 默认对一条用户消息中含 Base64 PNG/JPEG/WebP 原图的图生图请求调用 `/v1/images/edits`，每张原图最多 20 MiB，最多八张，只生成一张。
- 图生图路径使用 `tools[0].model` 指定的图片模型（如 `gpt-image-2`），主控模型不参与本服务这一步；支持提示词、instructions、常见图片选项和内嵌 Base64 mask。
- `file_id`、远程图片 URL、多轮会话、其他消息类型或多个工具不能安全转换，直接返回 HTTP 400；不会在后台悄悄降级为文本生图。
- sub2api 自身对部分账号或端点错误可能将图片请求内部回退为 Responses；本服务不能保证远端内部绝不使用主控，需要部署端确认。
- 强制修改顶层 `model`、`stream=false`，移除可选的 `background` 字段；不支持后台异步任务。
- 移除只用于流式的 `stream_options` 和生图工具的 `partial_images`。
- 上一条的 Responses 改写仅适用于没有原图或关闭图生图直连的请求；直连路径会重组请求与合成响应，不能原样透传。
- 不支持 Images API、Chat Completions、WebSocket、后台异步轮询、文件上传等额外端点。
- 不自动插入生图工具，也不把顶层图片模型推测为另一种客户端格式。
- 不自动把 Base64 图片公开上传为 URL；若客户端只接收图片 URL，需要另外适配。
- 主控替换会影响此前会话续接的兼容性；优先使用独立单轮生图请求。
- `stream=false` 客户端也受主控改写，但收到普通 JSON，不发送心跳。

## 出错与超时

开始 SSE 前的鉴权、格式和排队容量错误，返回普通 HTTP 4xx。
SSE 开始后 HTTP 状态已经是 200，上游错误通过 `response.failed` 返回。
上游 `response.incomplete` 保留为 incomplete，不伪装成功。
上游宣称 completed 却没有图片时，返回 `image_missing`。
意外返回 SSE、HTML 或非 Responses JSON 时，返回明确协议错误，不将它们误判为图片。

**HTTP 200 不等于生图成功。** 需要检查 `response.completed` 和图片结果。

没有自动重试，避免重复生图与重复费用。客户端断开会取消上游连接，但不能保证上游停止执行或不计费。
服务重启不恢复在途请求，不保存可恢复的任务或图片，只保留已结束请求的诊断元数据。不要在正在生成时随意重启。
上游自己的 504 超时仍然生效；客户端总时限、客户端只按数据事件重置的时限也不能由注释心跳保证绕过。
如果北熊不识别注释心跳，或要求在固定时间内收到图片/部分图片，仍需客户实测调整。

## 测试

```powershell
npm test
```

默认测试只连接本地模拟上游，不消耗 API 余额。

可选真实联调脚本模拟客户端发送 `gpt-5.5 + stream=true`，等待中间服务返回图片：

```powershell
$env:SMOKE_API_KEY = 'your-client-key'
npm run smoke -- --live
```

图生图联调需另外指定本机原图路径：

```powershell
$env:SMOKE_IMAGE_PATH = 'C:\path\to\source.png'
$env:SMOKE_PROMPT = '保留主体，修改背景'
npm run smoke -- --live
```

**这条命令会生成一张收费图片。** 不带 `--live` 不发送请求。
`SMOKE_API_KEY` 必须填写用户实际可用的生图 Key。
结果保存到 `output/smoke-*/`。不要把客户的原图、完整请求或真实密钥提交到仓库。

## Linux / Docker 部署

从 GitHub 仓库拉取、首次启动、HTTPS 入口、更新及备份的完整操作见
[`deploy/DEPLOY.md`](deploy/DEPLOY.md)。服务器执行 `sh deploy/start.sh`：
首次创建 `.env` 后检查配置，再次执行即可构建并等待容器健康。

```sh
docker compose up -d --build
docker compose logs -f
```

先在 `.env` 中配置 `HOST=0.0.0.0`，客户端填写自己的上游生图 Key。
Compose 默认仅将端口映射到宿主机回环地址，公网接入应由 HTTPS 反向代理完成。
生图与管理员接口均直接连接目标服务器，不提供出站网络代理配置。
如修改内部 `PORT`，需同步修改端口映射。
Compose 使用 `bridge-data` 数据卷保存设置、管理口令与请求记录。
首次部署可在服务器通过 `docker compose exec bridge cat /app/data/admin-token.txt` 读取管理口令。
删除该卷将丢失设置和历史；Docker 配置尚未在本机实际构建验证。

`deploy/nginx.conf.example` 是现有 HTTPS 站点内的 location 配置片段。
要求关闭响应缓冲并合理设置读超时。TLS、域名、证书和防火墙由部署环境提供。
默认不启用跨域 CORS；浏览器前端应通过同源反向代理访问。

## 运维与隐私

`data/requests.json` 仅保留最近 12 小时的请求诊断元数据，进程每分钟清理过期记录。
管理后台支持删除单条已结束记录或清空全部已结束记录；正在执行和排队的请求必须先取消，不能直接删除。
每条记录包含本服务 request ID、路径、状态、模型、原图数量、图片数量、阶段时间、心跳次数、上游 HTTP 状态与 request ID、耗时，以及少量程序生成的安全错误说明。
默认只保存有界的脱敏请求格式。启用 `RAW_REQUEST_LOGGING=true` 或后台的“保存完整原始请求”后，服务会把实际收到的请求头和 JSON 原文写入独立文件，并可在请求详情中查看。
原始记录包含 Authorization、完整提示词、图片 URL、签名参数和 Base64 图片内容，属于高敏感数据；仍按 12 小时清理，并在删除日志时同步删除。
图生图输入既可使用 PNG、JPEG、WebP 的 Base64 data URL，也可使用公网 HTTPS 图片 URL。远程图片由中间服务下载并校验后，以二进制 multipart 文件提交给图片编辑接口；私网、环回、保留地址、压缩响应、超过 20 MiB 的图片和超过三次的重定向会被拒绝。
`X-Bridge-Request-Id` 可用于客户报错时定位日志。
默认模式不持久化图片；启用完整原始请求记录后，JSON 中的 Base64 图片会随原始请求保存最多 12 小时。处理期间的大图片和请求仍会占用内存，高并发、大图片和大队列会增加内存占用。
请使用 HTTPS；不要将带密钥的 HTTP 请求穿过不可信网络。

## 客户验收清单

1. 客户勾选 Responses，将 Base URL 指向中间服务。
2. 单张文字生图成功，且只显示一张，不重复计数。
3. 单张以图生图成功，原图正确传递。
4. 连续等待数分钟不会因心跳兼容问题断开。
5. 真实上游错误能在软件中显示，而非无限转圈。
6. 小批量任务成功后再调整并发。

目前以上北熊软件内的步骤均为待验收，不是已通过项。
