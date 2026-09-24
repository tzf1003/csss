# Codex Sleep State Sugar：给 Agent 的一键配置提示词

将下面整段提示词交给能够操作本机 Surge 的 Agent。住宅 IP 只用于隐藏质量探针；正式 Codex 请求继续走当前 Surge 规则。代理凭据只能保存在本机，不要把真实策略名或凭据写入公开仓库。

```text
请在这台 macOS 电脑上配置公开项目 Codex Sleep State Sugar。

目标：让 Surge 为 ChatGPT/Codex 的 Responses 模型运行隐藏质量探针。探针固定询问“最新的 iPhone 型号是什么”，只接受回答 iPhone 17 且同时返回有效 state 的结果；iPhone 16、iPhone 15、无法判定、超时或缺少 state 均拒绝。合格 state 按账号与实际模型隔离缓存，在 TTL 内跨新会话复用，并在临近 1 分钟时续期。默认每批最多轮换 3 个住宅 IP，单次等待 25 秒。正式请求遇到 429 时，对客户端后续自动重试执行账号级指数退避。Surge 面板必须区分“已验证并注入”和“未验证放行”。

操作要求：
1. 使用这个 Surge 模块 URL 导入：
   surge:///install-module?url=https%3A%2F%2Fraw.githubusercontent.com%2Ftzf1003%2Fcsss%2Fmain%2Fcodex-state.sgmodule
2. 在 Surge 的模块设置中启用「Codex Sleep State Sugar」。
3. 确认 Surge 的增强模式、脚本、MITM 已启用，并确认 chatgpt.com 与 api.openai.com 的 MITM 证书可用。
4. 保持模块参数为 `model=*`、`ttl=300`、`renew=60`、`timeout=25`、`probe_attempts=3`；请求脚本必须使用 `requires-body=true`，以便识别实际模型。不要让不同模型共享 state。
5. 如果本机已有住宅 IP 策略，把策略名 URL 编码后填入 `codex-state-request` 的 `policy` 参数；变量为空时探针走当前规则。该参数只影响隐藏探针，不改变正式 Codex 请求的选路。
6. 如果用户明确提供探针专用 SOCKS5：可直连时，仅在本机把 `socks5, host, port, username, password, underlying-proxy=DIRECT` 写入 Surge 持久化键 `csss-probe-policy-descriptor-v1`；若服务要求先经过现有 Surge 策略，则在本机主配置的 `[Proxy]` 中创建命名 SOCKS5 策略并设置 `underlying-proxy=住宅IP策略名`，再把该命名策略写入同一个键。未提供则跳过。对于 1024Proxy，把控制台生成的用户名原样保存，不要手工附加 `-sid-...-t-...`；脚本会为每次探针生成新会话。
7. 打开 macOS 菜单栏 Surge 图标 → 面板 →「Codex State 状态」，确认面板能显示探针 HTTP 状态、iPhone 档位、state 长度、出口类型、TTL 和注入记录。
8. 只做一次最小化验证：检查模块是否启用、配置是否生效、面板是否可打开。除非用户明确要求，不要自动发送模型请求。若用户要求实测，必须分别报告隐藏探针结果与界面正式回答；界面回答 iPhone 17 不能替代“探针通过并注入”的流量证据。

报告时只返回：模块启用结果、MITM/脚本/增强模式状态、住宅探针是否生效、面板显示内容、是否真正注入，以及失败原因。不要输出账号、代理密码、订阅链接、Cookie、Authorization、完整 turn-state 或本机敏感路径。
```
