# Codex / CC Switch 过滤层

在 Windows 上为 Codex 和 CC Switch 增加一层本地 Responses 代理，清理历史推理密文和部分绑定上游资源的记录，减少切换上游后出现的解密失败或资源归属错误。v4 支持限流自动等待重试，最多 50 次。

```text
Codex → 过滤层（默认 18181）→ CC Switch（默认 15721）→ 上游模型
```

本项目不附带 Node.js，无额外 npm 依赖。

[下载最新版](https://github.com/YuHaiA/codex-ccswitch-filter/releases/latest)：下载 `codex-filter-v4.zip`，完整解压后双击启动。仓库名称为 `codex-ccswitch-filter`。

## 运行条件

- Windows 10 / 11。
- Node.js 24 或更高版本。
- 已安装并能正常使用 Codex。
- 已安装 CC Switch，并开启本地代理和 Codex 接管。

启动脚本会自动查找兼容的 Node.js，通常无需修改程序或填写安装路径。具体顺序见下方。

## 快速开始

1. 下载并完整解压发布包，或下载仓库源码。
2. 双击 `检查运行环境.cmd`，处理显示的注意项。
3. 完全退出 Codex。
4. 双击 `打开控制面板.vbs`，浏览器会打开本机控制页面。
5. 点击“启动过滤”，等状态变为“过滤中”，再重新打开 Codex。
6. 发送消息，确认控制页中的“已过滤请求”数字增加。

控制面板默认位于 `http://127.0.0.1:18180/`。页面打不开时，用 `打开控制面板.cmd` 查看错误。不要从 Codex 内置终端启动后台服务，以免服务随客户端退出。

停止使用时，在控制页面点击“停止全部服务”，恢复原来的 CC Switch 地址并关闭过滤层与控制面板，然后重新打开 Codex。CC Switch 本身不会关闭。

更新程序或改外层目录名之前先停止全部服务，之后从新目录重新启动。程序内部文件名之间存在引用，请保留。

## 如何自动找到 Node.js

双击 `打开控制面板.vbs` 或 `.cmd` 后，入口会调用同目录的 `ccswitch-filter.ps1`，依次检查：

1. 环境变量 `CCSWITCH_FILTER_NODE` 指定的 `node.exe` 完整路径（如果已设置）。
2. 当前进程 PATH 中能通过 `node` 命令找到的 Node.js；有多个时依次检查。
3. 当前用户下的以下候选路径：

```text
%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe
%LOCALAPPDATA%\Programs\Codex\resources\node.exe
%LOCALAPPDATA%\Programs\Codex\resources\app\node.exe
```

`%USERPROFILE%` 和 `%LOCALAPPDATA%` 会根据对方电脑当前用户自动展开，不是固定为作者电脑的路径。这些只是候选位置，不保证每种 Codex 安装方式都自带 Node。

脚本执行候选程序的 `--version`，选择第一个主版本号达到 24 的 Node.js。不存在的路径和低于 24 的版本会跳过。找到后使用这个 `node.exe` 的完整路径启动控制面板；在页面点击“启动过滤”后，过滤服务也使用同一个 Node。无需 `npm install`。

双击 `检查运行环境.cmd` 可看到实际找到的 Node.js 路径与版本。若找不到兼容版本，启动入口会提示安装 Node.js 24+ 或设置 `CCSWITCH_FILTER_NODE`。

### 已安装 Node，但没有自动找到

脚本查找上述位置，不会扫描整台电脑。便携版 Node 放在其他目录、未加入 PATH，或安装后启动入口尚未拿到新的环境变量时，可能找不到。

可以先在解压目录打开 PowerShell，使用以下命令指定路径并启动（示例路径请换成自己的）：

```powershell
$env:CCSWITCH_FILTER_NODE = 'D:\tools\nodejs\node.exe'
powershell -NoProfile -ExecutionPolicy Bypass -File .\ccswitch-filter.ps1 Panel
```

这次设置只对当前 PowerShell 及其启动的子进程生效。要长期双击使用，可在 Windows 的“编辑账户的环境变量”中新增用户变量 `CCSWITCH_FILTER_NODE`，值为 `node.exe` 的完整路径，不加外层引号。保存后，启动入口需要从更新后的环境启动；注销并重新登录 Windows 可使后续双击操作拿到新变量。

## 过滤行为

- 删除 Responses 请求 `input` 中的历史 `reasoning` 项。
- 从 `include` 中移除 `reasoning.encrypted_content`，设置 `store: false`。
- 清理普通消息、函数调用和自定义工具记录的顶层历史 `id`；保留工具配对需要的 `call_id`、工具参数与结果、消息 `phase`、嵌套文件引用。
- 删除绑定服务器资源的历史 `web_search_call` 记录，保留使用搜索结果生成的回答消息。
- 保留当前请求的 `reasoning.effort`、普通消息、图片和工具配对。
- 支持 JSON、gzip、deflate、br、zstd 请求，重新计算请求长度。
- 转发 Responses HTTP / SSE；不修改模型响应里的推理内容。

过滤会丢弃前轮内部推理状态，可能影响复杂长任务的连续表现。它不能保证解决所有上游错误。

## 限流等待重试

- 所有经本过滤层的 Responses 模型使用相同规则，模型名和 Azure 区域名不参与限流判断。
- 识别 Responses HTTP 429，以及包含限流提示的 HTTP / JSON 错误，包括代理包装成 502 的顶层 `message`、`code` 和嵌套错误。正常模型输出提到“限流”不会触发重试。
- 流式请求在实际输出或工具事件之前检查限流；支持 `response.created` / `response.in_progress` 后的错误，以及 gzip、deflate、br、zstd 压缩 SSE。等待流首结果时发送保活信号，不因旧的五秒检查窗口到期而漏判。
- 每个请求最多自动重试 50 次，加上初次请求共最多 51 次。
- 优先使用 `Retry-After`、`retry-after-ms`、`x-ms-retry-after-ms` 或额度为零时的 `x-ratelimit-reset-*` 等等待提示。
- 没有可用提示时，按约 5、10、20、40、60 秒逐步退避，并加入少量随机间隔。持续限流可能等待约 47 分钟或更久。
- 流式等待期间发送 SSE 注释保活；在 Codex 点停止或断开连接会取消等待及后续重试。
- 在实际输出之前缓冲空的创建 / 进行中元数据，限流重试时丢弃失败尝试的元数据，不向客户端混入不同响应 ID。看到输出、推理、工具或未知事件后立即转发，不再重放请求。余额不足、鉴权失败、普通网络断开与普通 5xx 不自动重试。

重试只能等待上游额度恢复，无法提高账号或 Azure 资源配额。耗尽次数后保留最后一次错误。可在状态中查看 `rateLimitMaxRetries` 与 `stats.rateLimitRetries`、`pendingRateLimitRetries`、`rateLimitRecoveries`、`rateLimitExhausted`。

这些计数属于过滤层。Codex 显示的 `Reconnecting 2/5` 等属于客户端自己的重连，不代表过滤层已经执行 50 次重试；是否进入本工具的重试，以计数和 `rate-limit-retry` 日志为准。仅支持本页说明的 Responses HTTP / SSE，不覆盖绕过本工具的请求或其他 API 路由。

## 接管边界

- 不支持 Responses WebSocket；握手会返回 426。
- 拒绝 compaction、`item_reference`、`previous_response_id`、`conversation` 等无法安全重新提交的上下文引用。长聊天应先生成任务摘要，再新建聊天继续。
- 默认读取 `CODEX_HOME/config.toml`；未设置 `CODEX_HOME` 时读取当前用户的 `.codex/config.toml`。
- 仅编辑顶层 `model_provider` 指向的常规单行 `base_url`。自定义 profile、命令行覆盖或其他配置来源可能绕过过滤层，以请求统计是否增加为准。
- CC Switch 关闭接管或切换到外部直连时，过滤层会待命，不强行覆盖外部地址。重新接管后，等待“过滤中”再重启 Codex。
- 停止时只恢复本工具写入的精确地址，不覆盖后来修改的其他设置。
- 重启电脑或强制结束服务后，先重新启动过滤层恢复监听，或执行停止操作恢复地址。不要先删除 `.runtime/routes.json`。

## 命令行与自定义配置

在解压目录打开 PowerShell；`node` 命令需要可从 PATH 找到 Node.js 24+。

```powershell
node .\filter.cjs start
node .\filter.cjs status
node .\filter.cjs stop
```

也可使用自动查找 Node 的包装入口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\ccswitch-filter.ps1 Start
powershell -NoProfile -ExecutionPolicy Bypass -File .\ccswitch-filter.ps1 Status
powershell -NoProfile -ExecutionPolicy Bypass -File .\ccswitch-filter.ps1 StopAll
```

自定义配置示例：

```powershell
node .\filter.cjs start --port 18181 --upstream http://127.0.0.1:15721
node .\filter.cjs start --config "D:\custom-codex\config.toml" --runtime "D:\custom-filter-runtime"
```

指定自定义 runtime 后，`status` / `stop` 必须使用同一个 `--runtime`。变更配置路径或端口前先停止。

## 本地测试

```powershell
node --test .\filter.test.cjs .\rate-limit.test.cjs
```

或者使用自动查找 Node 的入口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\ccswitch-filter.ps1 Test
```

测试使用临时配置和本机模拟上游，不调用收费模型。覆盖过滤、工具配对、压缩请求、SSE、取消、错误透传、配置恢复与重复启停，以及第 50 次重试成功、重试耗尽、不重放已经开始的流。

## 文件与运行数据

- `filter.cjs`：服务启动、停止和状态入口。
- `proxy.cjs` / `rate-limit.cjs`：请求过滤、转发和限流重试。
- `config.cjs`：配置读取、地址接管与恢复。
- `panel.cjs` / `panel.html`：本机控制页面。
- `filter.test.cjs` / `rate-limit.test.cjs`：本地测试。

运行数据保存在 `.runtime/`，其中包括日志、进程信息、控制令牌和地址恢复记录，不应上传或分发。`.gitignore` 已排除这些目录、Node 和压缩包；手动网页上传或重新打包时也要自行排除。

工具不修改 CC Switch 数据库、API Key 或 Codex 历史文件。日志不记录请求正文和鉴权头。发布版本不含账号、配置文件或 Node.js。
