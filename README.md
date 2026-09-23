# Codex Sleep State Sugar

这是一个 Surge Mac 模块和 JavaScript 脚本，用于观察并管理 Codex Responses 请求中的 turn-state：

- 从成功的 HTTP 200 Responses 响应中校验并采集 292 字符、10 块的 state。
- 按账号与实际请求模型隔离缓存，在后续同模型请求中复用。
- TTL 默认 60 分钟，剩余 10 分钟时提前续期；单次探针失败会进入冷却，避免循环请求。
- 连续两次观察到上游 state 与注入值不一致时，强制下一次请求重新采集。
- 遇到正式请求 429 时补齐 `Retry-After`，并对客户端后续自动重试执行 2、4、8、16、32、60 秒的账号级退避。
- Surge 原生面板显示当前是否会注入、TTL、最近探针、注入次数和最近 6 条记录。
- 捕获成功时发送本地 Surge 通知。

项目只处理本机 Surge 流量，不上传账号信息、请求正文、提示词、回答或完整 state。缓存由 Surge 的脚本持久化存储管理。

## 一键导入

点击下面的链接，或将链接复制到浏览器地址栏：

[一键导入 Surge 模块](surge:///install-module?url=https%3A%2F%2Fraw.githubusercontent.com%2Ftzf1003%2Fcsss%2Fmain%2Fcodex-state.sgmodule)

直接导入地址：

```text
https://raw.githubusercontent.com/tzf1003/csss/main/codex-state.sgmodule
```

导入后在 Surge 的「模块 → 未分类」中启用 `Codex Sleep State Sugar`。模块使用 GitHub Raw 地址加载脚本，并每天检查一次脚本更新。

模块默认使用 `model=*` 处理所有匹配 Responses 接口的模型。脚本从请求头或 JSON 请求体读取实际模型，并为每个“账号 + 模型”建立独立缓存；不同模型之间不会混用 state。若只想处理单个模型，可把三处 `model=*` 改成对应模型 ID。

## 效果示例

### 降智检测效果

下面的截图展示了一个新会话中的检测场景：左侧是 Codex 的生成过程，右侧是生成结果预览。它用于观察多轮新会话是否出现模型质量或路由变化。

![降智检测效果](docs/assets/downgrade-detection.png)

### Surge 面板预览

面板会直观显示当前请求是否会注入 292、缓存 TTL、距离续期时间、累计注入次数，以及最近的探针和注入记录。

![Surge 面板预览](docs/assets/surge-panel-preview.png)

### WebSocket 握手中断提示

启用 `force_http=1` 后，脚本会在 WebSocket 请求阶段中止握手，等待 Codex 回退到 HTTP Responses/SSE 路径。这个切换过程中，Codex 可能显示下面的提示：

![WebSocket 握手中断提示](docs/assets/websocket-handshake-error.png)

`stream disconnected before completion` / `WebSocket protocol error: Handshake not finished` 是切换到 HTTP fallback 时可能出现的连接提示，本身不代表 292 采集失败。请以 Surge 面板中的探针状态、HTTP 200、state 长度和注入记录为准。

## 完整配置教程

### 1. 准备 Surge

使用 Surge Mac，并确保当前配置本来就能访问 ChatGPT/Codex。先确认：

1. Surge 已打开并正在接管流量。
2. 「增强模式」已开启。
3. 「脚本」已开启。
4. 「MITM」已开启，并已为 `chatgpt.com`、`api.openai.com` 安装并信任 Surge 证书。
5. 现有规则能把 Codex 请求送到可用出口。

模块默认不写入任何私人节点名，也不覆盖你的代理规则。它会沿用 Surge 当前规则选择出口。

### 2. 导入并启用

打开一键链接后，进入 Surge「设置 → 模块 → 未分类」，选中 `Codex Sleep State Sugar`，勾选「启用」并应用。

如果网络无法访问 GitHub Raw，可以下载 `codex-state.js` 到本地，并把三处 `script-path` 改成本地绝对路径。

### 3. 住宅 IP 策略（可选）

`policy` 是可选变量：如果你有住宅 IP 策略，可以把住宅 IP 的策略名称填入三处 `argument=`；如果没有住宅 IP，或把变量留空/删除，则探针和 Codex 请求会沿用 Surge 当前规则选路。

```text
policy=YOUR_RESIDENTIAL_IP_POLICY
```

例如策略名含空格时，使用 `%20`；三处 `argument=` 应保持一致。不要把代理账号、密码、订阅 URL 或节点 URI 提交到 GitHub。

### 4. 探针专用 SOCKS5（可选）

获取 1024Proxy：

- [1024Proxy 邀请链接](https://api.1024proxy.com/share/qu34nfxgf)
- [1024Proxy 账密认证说明](https://help.1024proxy.com/1024/1024proxy/unlimited-residential-traffic-port/username-and-password-authentication)

在 1024Proxy 控制台选择 SOCKS5、地区和会话类型后生成代理。控制台通常会给出类似下面的 cURL 命令：

```bash
curl --socks5 HOST:PORT -U "USERNAME-region-US:PASSWORD" https://ipinfo.io
```

其中 `HOST`、`PORT`、`USERNAME-region-US`、`PASSWORD` 分别对应 Surge 描述符中的四个字段。先运行该命令；能够返回出口 IP 后，再转换为：

```text
socks5, HOST, PORT, USERNAME-region-US, PASSWORD, underlying-proxy=DIRECT
```

如果控制台提供的是 `socks5://USERNAME:PASSWORD@HOST:PORT` 链接，同样按用户名、密码、主机和端口四部分填入。`-region-US` 用于选择美国出口；其他地区替换为相应的两位国家代码。

如果只希望采集和续期 state 的探针走独立 SOCKS5，可在 Surge 脚本编辑器中执行下面的本机配置；普通 Codex 请求仍按原规则选路：

```js
$persistentStore.write(
  "socks5, proxy.example, 1080, username, password, underlying-proxy=DIRECT",
  "csss-probe-policy-descriptor-v1"
);
$done({});
```

`underlying-proxy=DIRECT` 仅指定如何连接 SOCKS5 服务器，探针访问 OpenAI 时仍从该 SOCKS5 出口发出。脚本也会为未指定上游的 SOCKS5 描述符自动补上该参数。凭据只应保存在本机，不要写入模块、仓库、Issue 或日志。置空该存储键即可恢复到 `policy` 参数或 Surge 当前规则。

如果 SOCKS5 服务要求先经过现有 Surge 策略才能连接，请在本机主配置的 `[Proxy]` 中创建命名链式策略，再把策略名写入同一个持久化键：

```ini
[Proxy]
CSSS-Probe-SOCKS = socks5, proxy.example, 1080, username, password, underlying-proxy=YOUR_ENTRY_POLICY
```

```js
$persistentStore.write("CSSS-Probe-SOCKS", "csss-probe-policy-descriptor-v1");
$done({});
```

Surge 模块不能修改 `[Proxy]`，因此命名策略必须保存在本机主配置中。探针会优先使用持久化键指定的命名策略。

原始 SOCKS5 描述符是 1024Proxy 的推荐方式。脚本会为每次探针创建新的临时 Surge 策略；当主机是 `*.1024proxy.io` 时，还会自动替换或补充唯一的 `sid`（1 分钟会话），避免 HTTP/2 连接池反复使用同一出口。请把控制台生成的用户名原样填入，脚本只在运行时生成临时副本，不会改写持久化凭据。

其他代理服务如果也需要轮询多个命名策略，可使用 `|` 分隔策略名：

```javascript
$persistentStore.write(
  "CSSS-Probe-Session-01|CSSS-Probe-Session-02|CSSS-Probe-Session-03",
  "csss-probe-policy-descriptor-v1"
);
$done();
```

脚本每次探针会选择列表中的下一个策略。每个策略名最长 128 字符，完整列表最长 2048 字符；这些命名策略仍需预先存在于本机主配置中。

### 5. 打开状态面板

在 macOS 菜单栏点击 Surge 图标，打开「面板 → Codex 292 状态」。面板含义如下：

| 面板标题 | 含义 |
| --- | --- |
| `等待采集` | 当前没有可复用的合格 state；下一条匹配请求会先尝试采集 |
| `正在复用` | 当前请求会注入缓存中的 292；面板会显示 TTL 和续期时间 |
| `正在采集` | 探针正在运行，当前请求暂不使用旧值 |

最近记录会标注探针结果、请求是否注入、响应 state 长度和会话尾部标识。记录不保存提示词、回答或完整 token。

### 6. 验证流程

建议先打开面板，再在 Codex 中新建会话发送一条普通短消息。随后刷新面板：

1. 首次没有缓存时，状态应变为「正在采集」或显示探针结果。
2. 成功采集后，状态应显示「正在复用」和剩余 TTL。
3. 再开一个新会话，面板历史应出现「已注入 292」。
4. TTL 接近续期阈值时，下一条请求会先探测新值。

面板状态是流量处理的证据；模型回答内容可以作为你自己的业务验收信号，但不能单凭回答文本证明服务端内部路由实现。

## 工作原理

请求脚本只匹配 Responses HTTP/SSE 接口。脚本会识别当前请求的实际模型；该模型没有可用 state 时，使用当前请求的认证头并以同一个模型发起一次短探针。探针响应必须是 HTTP 200、完整 SSE，并通过 state 封装和 10 块校验，才会写入该账号与模型对应的 Surge 持久化缓存。

后续匹配请求会在发送前把缓存值写入 `x-codex-turn-state`。响应脚本会再次观察上游 state：若连续两次与注入值不一致，就让下一条请求重新采集。探针收到结构有效但长度不合格的 state（例如 312）后，30 秒后的下一条匹配请求即可再次采集；401、403、429 和网络失败仍按各自状态进入退避，不会自动重放正式生成请求。

正式生成请求返回 429 时，脚本会记录账号级退避状态，并把指数退避时间写入 `Retry-After`。Codex 客户端发起下一次自动重试后，请求脚本会先等待剩余退避时间再放行，并跳过额外探针，避免插件放大限流。默认从 2 秒开始，最高 60 秒，可用 `retry_base` 和 `retry_max` 调整。

Surge 的响应脚本拿不到原请求正文；强行由脚本重放必须暂存提示词并缓冲完整 SSE 响应，会破坏正常流式输出。因此本模块不会自行复制正式生成请求，而是调度 Codex 客户端原有的自动重试。若服务端持续限流直到客户端重试次数耗尽，最终 429 仍会显示；需要完全透明的无限重放时，应使用能够流式代理请求体和响应体的本地反向代理，而不是 Surge JavaScript 模块。

兼容范围是经 Surge 捕获、使用 Responses 接口且请求中能识别模型 ID 的模型。某个模型只有返回符合 292/10 块校验的 state 后才会进入复用；其他模型的缓存不会被借用。这套机制只能保持请求参数的一致性，不能保证模型质量、账号额度、服务端路由或任何特定回答。292/10 块是经验校验规则，不是 OpenAI 公布的质量指标。

## 常见问题

### 面板一直是「等待采集」

检查脚本、MITM、证书和 Responses 请求是否经过 Surge；确认请求体可被脚本读取且包含模型 ID。首次探针可能因网络、429、账号状态或上游响应形状不合格而失败。

### 出现 429

面板会显示账号级退避时间和连续次数。脚本会尊重服务端 `Retry-After`，没有该响应头时按 2、4、8、16、32、60 秒退避，并挂起 Codex 客户端的下一次自动重试；成功响应后自动清零。持续性的额度或服务端限流仍可能在客户端重试耗尽后显示 429。

### 只想关闭注入

在 Surge 模块设置中停用模块即可；也可以只关闭脚本，保留普通代理规则。

### 如何清除缓存

在 Surge 的脚本持久化存储中删除 `codex-turn-state-v5`，或在脚本编辑器中清空对应存储后重新加载模块。删除前请确认你没有其他脚本共用该键名。

## 给 Agent 的一键配置提示词

完整可复制提示词见 [AGENT_PROMPT.md](AGENT_PROMPT.md)。它要求 Agent 自动导入模块、检查增强模式/脚本/MITM、打开面板并汇报结果，同时禁止输出账号、订阅、Cookie、Authorization 和完整 state。

## 安全与隐私

公开仓库不包含节点名称、代理地址、账号 ID、Authorization、Cookie、订阅 URL、脚本持久化数据或本机路径。使用者应把策略名和代理凭据留在本地 Surge 配置中。请不要在 Issue、截图或日志中粘贴完整请求头、订阅链接或 turn-state。

## 引用与致谢

- [Surge Information Panel 文档](https://manual.nssurge.com/tools/panel.html)
- [Surge Generic Script 文档](https://manual.nssurge.com/scripting/generic.html)
- [Surge Scripting API](https://manual.nssurge.com/scripting/api.html)
- [292 State 研究文章](https://blog.caowo.de/posts/chatgpt-codex-292-state-anti-degradation-2026/)
- [gylive/ccodex-sleep-state](https://github.com/gylive/ccodex-sleep-state)：感谢其对 state 生命周期、探针、TTL 和诊断体验的公开讨论；本仓库是独立的 Surge 脚本实现。

本项目与 OpenAI、Surge、上述作者或仓库没有隶属关系。

## 许可证

MIT，见 [LICENSE](LICENSE)。

## 本地自检

需要 Node.js 18 或更高版本：

```sh
node test-codex-state.js
```
