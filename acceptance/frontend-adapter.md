# D31 可选网页前端判卷（FE-01～FE-07）

对应 #218 与 [OpenAI-compatible 前端适配层图纸](../docs/design/openai-compatible-frontend-adapter.md)。
本页是人话清单，可执行版是同目录的 `frontend-adapter-checks.ts`；两边必须同步。

```bash
npm run acceptance:frontend-adapter
npm run acceptance:frontend-adapter:strict
```

报告模式在缺驱动时打印七盏红灯并退出 0；strict 模式只在七盏真绿时退出 0。
实现方在 `src/frontend-adapter-acceptance-driver.ts` 导出
`createFrontendAdapterDriver()`。驱动缺失是判卷先行的起点，不是实现失败；驱动存在却损坏必须
直接报错，不能伪装成「缺驱动」。

## PR1 交付边界

本轮只冻结：

- adapter 图纸；
- FE-01～FE-07 的 typed driver、可执行检查与 runner；
- 报告/strict npm 入口及判卷器自检。

本轮不新增网络监听、不改安装器、不创建生产 driver、不实现 `/webui`、不安装 Open WebUI，
所以七盏在真实仓库上应当保持未勾、runner 应报告 `0 / 7`。合成正对照只证明判卷器自身不矛盾，
不能拿来申绿。

## 七盏灯

- [ ] **FE-01 默认终端与旧配置处置**：安装器第 3 步默认落 `{ kind: "terminal" }`；
  「接自己的前端」必须显式选择并落 `openai-compatible` integration。旧草稿/快照里的
  `official-skin` 读取时返回稳定 `LEGACY_FRONTEND_UNSUPPORTED` 与可操作 remedy，原字节不改，
  不静默迁成 terminal 或 external。

- [ ] **FE-02 OpenAI-compatible 往返与唯一 writer**：普通与 `stream: true` 各完成一次合成往返；
  流式 chunks 能逐字重建同一完整回复。每个 user/assistant turn 在 canonical stream 恰好一份，
  全部事件来自绑定的唯一 writer；响应 `model` 与 stream id 由服务端绑定给出。

- [ ] **FE-03 不认前端历史**：请求携带伪造 system/user/assistant 前缀时，模型输入的历史与
  canonical stream 逐字一致，只额外接数组末尾的当前 user turn；伪造字节不进模型、不落账、
  不进可观察回执。

- [ ] **FE-04 一条主流**：用不同 `model`、`user`、metadata 与 frontend conversation id 发两次
  请求，仍落到同一 resident、scope 与 stream；不能出现第二条主流，也不能把客户端 model
  回显成真实路由。

- [ ] **FE-05 附件与选项/阻断不退化**：支持 capability 的 surface 收到结构化附件；generic
  surface 仍保留结构化附件/interaction，并得到 `degraded` / `blocked` 呈现回执。附件字节不进
  canonical 正文，interaction 选项不摊成 `[option]`、编号列表或可被普通 user 文本冒充的点击。
  住户的模型输入能读到本轮 surface capabilities，后续 canonical 读口能读到 blocked 回执。

- [ ] **FE-06 鉴权默认强制**：缺 token、错 token、loopback 缺 token 都返回 401 与稳定 code，
  且模型调用和 canonical 写入均为零；带正确 token 的 loopback 正对照可通过。日志和回执不含
  正确或错误 token 原文。

- [ ] **FE-07 `/webui` 按需安装**：未确认不安装；Docker/Python 均缺时只报缺项，不动系统；
  确认且环境满足后恰好走一次 `frontend` 插件安装闸，启动服务、返回本机 URL。Open WebUI 的
  合成请求复用 FE-02 同一 endpoint 与 canonical stream，不另开 auth/history/writer 后门。

## 判卷边界

- FE-02～FE-06 的公开 CI 只用合成住户、合成 token 与合成模型 transport；不需要真实 provider。
- FE-05 判的是结构、能力与回执，不判某个具体 UI 是否好看。Open WebUI Pipe 的真实点击体验
  留给功能 PR 的本机观察记录。
- FE-07 公开 CI 用安装替身证明确认、环境探测和插件闸；真实 Open WebUI 安装只在隔离本机做，
  不进公共 CI，也不能用「进程起来了」替代一次经同 endpoint 的真实往返。
- 施工席与独立验收席分开。合成判卷器自检、作者自测与正式落章是三件事。
