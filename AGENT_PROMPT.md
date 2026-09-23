# Codex Sleep State Sugar：给 Agent 的一键配置提示词

将下面整段提示词交给能够操作本机 Surge 的 Agent。`policy` 是可选变量：如果本机有住宅 IP 策略，就把住宅 IP 的策略名称填入该变量；如果没有住宅 IP 或变量留空，就沿用 Surge 当前规则。探针也可选用用户提供的独立 SOCKS5，但凭据只能保存在本机。不要把真实策略名写入公开仓库。

```text
请在这台 macOS 电脑上配置公开项目 Codex Sleep State Sugar。

目标：让 Surge 为 ChatGPT/Codex 的所有 Responses 模型自动采集合格的 292 字符、10 块 turn-state，按账号与实际模型隔离缓存，在 TTL 内跨新会话复用，并在 TTL 临近时自动续期；正式请求遇到 429 时，为客户端后续自动重试执行账号级指数退避；同时提供可查看当前状态和最近历史的 Surge 面板。

操作要求：
1. 使用这个 Surge 模块 URL 导入：
   surge:///install-module?url=https%3A%2F%2Fraw.githubusercontent.com%2Ftzf1003%2Fcsss%2Fmain%2Fcodex-state.sgmodule
2. 在 Surge 的模块设置中启用「Codex Sleep State Sugar」。
3. 确认 Surge 的增强模式、脚本、MITM 已启用，并确认 chatgpt.com 与 api.openai.com 的 MITM 证书可用。
4. 保持模块三处脚本参数为 `model=*`；请求脚本必须使用 `requires-body=true`，以便从 JSON 请求体识别实际模型。先确认是否有住宅 IP 策略：有则将住宅 IP 策略名 URL 编码后填入模块三处脚本参数的 `policy` 变量，并保持三处一致；没有住宅 IP 或变量置空/删除，则不要传入 `policy`，让 Surge 按当前规则选路。不要创建、猜测或输出任何账号、代理密码、订阅链接、Cookie、Authorization 或完整 turn-state。
5. 如果用户明确提供探针专用 SOCKS5 地址和凭据：可直连时，仅在本机把 `socks5, host, port, username, password, underlying-proxy=DIRECT` 写入 Surge 持久化键 `csss-probe-policy-descriptor-v1`；若服务要求先经过现有 Surge 策略，则在本机主配置的 `[Proxy]` 中创建命名 SOCKS5 策略并设置 `underlying-proxy=住宅IP策略名`，再把该命名策略写入同一个持久化键。未提供则跳过。采集使用轮换会话，代理用户名不要附加 `-sid-...-t-...`。该设置只影响 state 采集与续期探针。
6. 打开 macOS 菜单栏 Surge 图标 → 面板 →「Codex 292 状态」，确认面板可以显示当前是否会注入、TTL 和最近记录。
7. 只做一次最小化验证：检查模块是否启用、配置是否生效、面板是否可打开。除非用户明确要求，不要自动发送模型测试请求。

报告时只返回：模块启用结果、MITM/脚本/增强模式状态、面板显示内容和失败原因。所有敏感值只在本机使用，不要写入日志、截图、提交或聊天消息。
```
