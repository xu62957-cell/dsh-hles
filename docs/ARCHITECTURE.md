# HLES 3.0 架构与环境分析

本文记录 DSH 环境实测结果、插件实现映射、以及"哪些接口真的可用、哪些绕过了"。
所有接口都来自运行时探测（`cordis_inspect_*`）与已安装包的类型声明，没有虚构。

## 1. DSH 环境（实测）

| 项目 | 值 | 来源 |
|---|---|---|
| DSH 版本 | `0.2.0-rc.2` | `/opt/dsh/node_modules/@deepseek-ai/dsh/package.json` |
| Profile | `web`（`$DSH_PROFILE_DIR=/root/.dsh/profiles/web`） | 运行时环境变量 |
| Node | v22.23.2（`node:sqlite` 可用，FTS5 可用，`TextDecoder('gb18030')` 可用） | `node -e` 探测 |
| 插件模型 | Cordis：`export function apply(ctx, config)` + `export const inject` + 可选 `Config`（Schemastery） | `references/host-plugin.md` |
| 注册资源 | `ctx.effect(() => disposer)`；`ctx.on(event, fn)` 返回 disposer | Cordis 运行时 |
| 可用服务 | `tools` / `systemPrompt` / `timer` / `web` / `agents` / `fs` / `sessions` 等 | `cordis_inspect_query Service` |
| 可用事件 | `session/event`（逐条会话事件）、`agent/turn-stopping`、`system-prompt/assemble` 等 | `cordis_inspect_query Event` |
| Web 抓取 | `ctx.web.fetch({ url }) -> { statusCode, body: { kind, content }, truncated }` | Service `web` 契约 |
| 搜索 | `ctx.web.search({ query, maxResults })` | 同上 |
| 提示词注入点 | `ctx.systemPrompt.context({ name, order, text })`，`text` 可为函数，每步重新求值；空串自动过滤 | Service `systemPrompt` 契约 + `renderContextSections` 源码 |
| 工具注册 | `ctx.tools.register({ name, description, parameters, output, execute })` | Service `tools` 契约 |
| 定时器 | `ctx.get('timer').interval(fn, ms)` 返回 disposer | Service `timer` 契约 |
| 会话结构 | `session/event` 携带 `event.type = user/message \| assistant/message \| turn/end`，消息体为 `{ content: ContentBlock[] }` | Event `session/event` |

### 网络实测（2026-11-21）

- 直连 `fetch` 可用；部分站点（BBC、Guardian、Hacker News 主站、Wikipedia、Reddit）DNS 被投毒到 Facebook IP，连接超时。已从源注册表剔除。
- 可达源 60+（中英文 RSS 与入口页），覆盖科学/历史/文学/艺术/音乐/影视/游戏/编程/设计/建筑/摄影/手作/美食/体育/教育/哲学/心理/气候/天文等。
- `ctx.web.fetch` 与直连双通道：直连失败时回退到宿主 Web 提供方，反之亦然。

## 2. 模块映射

```
index.js
  ├─ Store             lib/db.js        SQLite（WAL）+ 全部数据访问
  ├─ Fetcher           lib/fetcher.js   robots 预检 → 同主机限速 → 直连 → web 兜底
  │    └─ RobotsPolicy lib/robots.js    最长匹配 + Crawl-delay + 24h 缓存
  ├─ Explorer          lib/explore.js   三通道调度、反茧房权重、链接/订阅/讨论处理、日记
  │    ├─ parse.js                        HTML/RSS/HN 讨论 JSON
  │    ├─ analyze.js                      站点类型、要点、知识候选、存疑点
  │    ├─ language.js                     特征 + 规律归纳（相对基线显著才收）
  │    └─ injection.js                    高危页面隔离
  ├─ Learner           lib/learn.js      显式反馈识别 + 每轮 7 项自评
  ├─ ExperienceInjector lib/prompt.js    经验 → 运行时上下文（600 字上限，TTL 缓存）
  └─ schedule.js                         定时探索（DB 持久化开关，运行期可改）
```

## 3. 数据流

### 探索周期

```
chooseChannel()  ── 负反馈控制器：目标比例 50/30/20，向实际比例修正
      │
      ├─ random   : frontier 权重 = 优先级 × 反茧房系数（近期同域↓、久未访问↑）
      ├─ extension: 上一页链接，同站加权，anchor 质量加权
      └─ interest : 阶段性兴趣 → 队列匹配 →（可选）搜索兜底
      ↓
Fetcher.get(url)  → robots → 限速 → 抓取（≤1.5MB，≤20s，最多 4 次跳转）
      ↓
parse：订阅源 → 条目入队 / 讨论 JSON → 评论语料 / HTML → 正文+链接
      ↓
injection.scan → 高危则整页隔离（不入库、不采样）
      ↓
analyzePage：站点类型 / 文体 / 结构 / 要点 / 知识候选 / 存疑 / 可延伸方向
      ↓
extractPatterns：句长节奏、语气词、连接词、限定、对话、情绪、社群用语、
                 互动、反问、人称、标点、讲解方式、文体、开场（门槛：显著且可引用）
      ↓
Store：visits / lang_pattern(去重累加) / knowledge(未验证→双源验证) |
       frontier(链接入队) / interests(衰减) / diary(周期结束)
```

### 回答生成

```
systemPrompt.assemble
  → ctx.systemPrompt.context('hles:language-experience')
      → ExperienceInjector.build({ sessionId, lang })
          → topPatterns(minHits≥2, confidence≥0.45, 按语种过滤)
          → activePrefs(global + 本会话)
          → ≤600 字文本（无经验则返回 ''，宿主自动过滤）
```

### 反馈闭环

```
session/event: user/message     → detectFeedback() → user_pref（会话级/全局）
session/event: assistant/message → 缓冲本轮回答
session/event: turn/end          → assessText() → evals（7 项 + 命中项）
                                   （准确性返回 null，不伪造）
```

## 4. 安全模型

1. 只抓 http(s)、拒绝内网/本机/带凭据 URL。
2. robots.txt 预检（最长匹配、Allow 优先、Crawl-delay），缓存 24h。
3. 单主机最小间隔（默认 2.5s），单页上限 1.5MB，超时 20s，跳转上限 4。
4. 不带 cookie、不带授权头、不提交表单、不执行页面脚本。
5. 网页文本只进入统计器；从不进入系统提示，也从不触发工具调用。
6. 注入扫描 14 条规则，高危即整页隔离，只记规则名。
7. 语言样本 ≤150 字、知识陈述 ≤500 字、偏好证据 ≤300 字，不保存整篇。

## 5. 接口限制与替代方案

| 限制 | 实测表现 | 采用的替代 |
|---|---|---|
| 没有"随机网页"官方接口 | `ctx.web` 只有 search/fetch | 自建源注册表 + 链接队列 + 订阅源，不依赖搜索引擎 |
| Host 进程无法感知"当前会话 scope"在 assemble 阶段 | `AssembleContext` 只有 `scope/signal` | 用 `ctx.get('agents').currentInitiator()` 取当前会话；取不到就只注入通用经验 |
| 模块缓存 | 修改已加载插件的 JS 需要新模块 URL 或宿主重启 | `scripts/deploy.mjs` 生成新包名/新真实目录的运行时副本，热装即生效 |
| 无独立设置页 | 本版本只做 Host 侧 | 全部操作通过 3 个工具 + 运行期调度开关完成 |
| 无浏览器渲染 | JS 渲染页面正文为空 | 标记 `thin` 跳过，不做重型依赖 |
| DNS 拦截站点 | 连接超时 | 从注册表剔除；失败率记入 `sources` 表 |

## 6. 性能与资源

- 单页处理完立即释放正文；不保留页面缓存。
- 数据库 WAL、`journal_size_limit=8MB`；队列/日志/访问记录按上限裁剪。
- 堆内存超过 `memory.maxHeapMB`（默认 260MB）主动结束当前周期。
- 每轮结束 `decayInterests` + `prune`。
- 实测：连续 25 页（每页 27KB HTML）堆增长 <3MB；100 页长跑数据见测试报告。

## 7. 真实运行后的 12 处修正（记录在案）

以下问题都是装上之后跑真实网络才暴露的，不是设计阶段能想到的：

| # | 现象 | 根因 | 修正 |
|---|---|---|---|
| 1 | 情绪规律写成「用『0』表达情绪」 | `Object.entries(数组)` 取到的是下标 | 直接遍历数组值 |
| 2 | 单页异常会终止整个周期 | `processPage` 抛错未捕获 | 单页 try/catch，记失败继续 |
| 3 | 「RT」命中了 "Read Next" | 拉丁词按子串匹配 | 英文词按词边界匹配 |
| 4 | 「emo」命中了 "emoji" | 同上 | 同上 |
| 5 | 知识里混进 reCAPTCHA/版权声明 | 定义句式匹配太宽 | 模板句黑名单 + 知识句式收紧 |
| 6 | 知识永远是 unverified | 只按哈希精确去重 | 改用停用词归一的 Dice 相似度（阈值 0.72），不同站点近似陈述即验证 |
| 7 | 抓到 PDF 把二进制当正文 | 未看 content-type | 非文本直接不下载、记 skipped_type |
| 8 | 登录/账号页被当成文章学 | 只按正文长度判断 | URL 账号类路径 + 标题黑名单 |
| 9 | 导航页贡献「短句占比 91%」 | 句子均值太短 | 平均句长 <9 或短行占比 >50% 不采样 |
| 10 | 单字「顶」命中「置顶」 | 中文单字无边界 | 移除单字社群用语 |
| 11 | 例句取到「我的」「登录/注册」 | 引语/证据选择无质量门槛 | 引语内文 ≥6 字且非导航词 |
| 12 | 英文规律注入中文会话 | 会话语言判断被框架英文消息带偏 | 过滤框架注入消息 + 默认语种 zh + 按语言过滤 |

## 8. 模块缓存与热更新

DSH Host 进程按模块 URL 缓存已加载的 ESM 模块。修改已安装插件的 `index.js` 后，
再次启用该行不会重新导入模块（实测：错误堆栈仍指向旧文件行号）。
可行路径只有两条：

1. **换真实路径/包名**：`node scripts/deploy.mjs --name <新包名> --id <新行id> --out <新目录>`，
   先 `remove_bundle` 旧包、清掉 profile `node_modules` 里悬空的软链，再 `install_bundle` 新目录。
   （本会话用这条路径迭代了 12 个版本，每次 3~8 秒生效。）
2. **重启宿主**：新进程重新解析模块，源码安装立即生效。

这条限制不属于 HLES，而是宿主的行为；README 与 INSTALL 都已写明。

---

# 4.0 升级：全局语言基础设施

## 9. 插件优先级机制（实测结论）

DSH **没有**逐插件的数字优先级字段。实际影响"谁先谁后、谁能覆盖谁"的只有三处：

1. **配置层序**：profile 组合 = bundles → `cordis.patch.yml` → 命令行 overlay；
   后应用的层覆盖先应用的层（`plugin_manager` 报 `overridden` 即此义）。
2. **提示词位置**：`systemPrompt.section/context` 的 `order` 数字决定在系统提示/运行时上下文里的先后。
   内置运行时上下文：`SANDBOX_POLICY 110`、`APPROVAL_POLICY 115`、`SUBAGENT_DELEGATION 120`。
3. **事件瀑布**：`system-prompt/assemble` 等 waterfall 的 `prepend/after` 决定监听顺序；
   「破限模式」dsh-unrestricted 用的就是根级 `system-prompt/assemble` 监听 + 作用域 section 覆盖。

HLES 的定位：
- 不注册 `system-prompt/assemble` 监听，不修改任何人设 section，因此**不会**与破限模式争夺同一位置；
- 用 `ctx.systemPrompt.context({ order: 9500 })` 把经验放到所有运行时上下文之后（越靠后越贴近当前请求），
  属于"附加"而非"覆盖"；
- 加载顺序上，HLES 作为独立 bundle 最后插入，生命周期与破限模式平级，互不依赖；
- 不读写其它插件的数据、不写角色卡/预设文件，符合"可用最高语言优化优先级、但不越安全边界"。

## 10. 全局注入与人设兼容

- **对所有 Agent 生效**：上下文注册在根作用域，`assemble` 时所有会话共用；不需要逐 Agent 安装。
- **保留人格**：注入文本只描述"人类通常怎么写"，并明确写"与语境冲突时以语境为准"；
  不定义角色语气、不覆盖系统提示，Agent 的人格来自它自己的预设。
- **双层语言系统**：
  - 第一层（HLES）= 语言能力：口语组织、接话、反驳、情绪表达、多样性、反机械化；
  - 第二层（预设/角色卡）= 人格：性格、说话习惯、设定，完全不受 HLES 改动。
- **会话级开关**：`agents` 表记录见过的会话与预设；`inject` 时若该会话被单独关闭则返回空串；
  `inject.global=false` 时全局关闭。
- **分类分散**：每次最多从同一经验分类取 2 条，避免整段都是"节奏"或整段都是"玩梗"。
- **语言匹配**：只注入与会话语言一致的经验（默认 zh），避免把英文语料规律塞进中文对话。

## 11. 评论区引擎

### 11.1 提取策略

1. 扫描 HTML 中所有 `class`，保留含 `comment|reply|post|message|floor|answer|discuss` 且出现 ≥3 次的类名；
2. 按该类名切块，剥标签取纯文本，过滤导航词、过短/过长、非中文；
3. 命中 ≥3 条即认为找到评论区；同时从"共 N 条评论"文本里提取总数提示；
4. 取样：随机位置 + 首尾保底，数量由面板"每页评论采样数"控制（默认 30）。

### 11.2 平台实测（2026-11-21，本机网络）

| 平台 | 探测结果 | 结论 |
|---|---|---|
| api.bilibili.com | robots `Disallow: /`；www 站连接超时 | 不抓 |
| 抖音 / 快手 / 小红书 / 西瓜 | 前端渲染 / 风控 JSON / 需登录 | 不抓 |
| 百度贴吧 / 知乎 / NGA | HTTP 403 | 不抓 |
| V2EX / 微博 / 网易云音乐 | DNS 拦截 / 登录跳转 | 不抓 |
| 豆瓣小组 | 广场可读，话题页 404/需登录 | 只读入口 |
| 虎扑 / 龙空 / 水木 | 首页可读，帖子与回复前端渲染或错误页 | 只读入口 |
| 机核 / 掘金 / CSDN / 少数派 / 36氪 | 文章多为前端渲染，评论区不可得 | 只读正文 |
| **GitHub 公开议题 API** | 200，中文议题评论可取，未登录 60 次/小时 | **已接入，实测 31 条/轮** |
| 网易新闻跟贴 API | 产品键正确时仍返回"已关闭跟贴" | 不接入 |

结论：**本机网络下，能合法自动化取得的中文公开评论主要来自 GitHub 议题**；其余平台要么
robots 禁止、要么 403/登录墙、要么评论由前端渲染。通用提取器仍然保留——遇到任何服务端渲染
评论区的页面（自建博客、部分论坛）会自动进入评论学习，不需要改代码。

### 11.3 评论学习产出

- 12 类评论分类（普通聊天/幽默调侃/日常吐槽/情绪宣泄/认真讨论/观点争论/知识交流/生活分享/游戏交流/兴趣讨论/技术讨论/网络玩梗）；
- 规律：短评文化、流行语、玩梗、反驳三段式、接话方式、情绪直言、时间词开头的生活分享、判断+理由的讨论方式、类型分布；
- 趋势：评论里反复出现的 2–4 字片段，进入 `term_trend`，按 30 天半衰计分；
- 落库：`discussions` 只存采样统计（平台/领域/条数/类型分布），不存原文、不存用户名。

## 12. 侧边栏面板

- Client 半区：`client.js` 通过 `window.__ModuleLoader__.load` 注册；
  - `sidebar.panellist` → id `hles-evolution`，label「语言进化」；
  - `main`（keyed）→ key `hles-evolution`，即点击后打开的独立页面。
- Host 半区：`ctx.inject(['webServer'], ...)` 里用 `webServer.register({kind:'exact', path:'/api/dsh-hles/...'})`
  注册 9 组接口；每个 handler 先调用 `connection.requestRejection(req)` 复用 DSH 浏览器鉴权，
  无 cookie 直接 401（已实测）。
- 依赖：`client.js` 只用 `require('react')`，样式全部走 `--dsw-alias-*` 主题令牌，无第三方包。

## 13. 4.0 的已知边界

1. 视频平台评论区无法接入（原因见 §11.2），内容配比里的 45% 视频份额会自然落到论坛/文章；
   面板同时显示目标比例与实际比例，不粉饰。
2. 面板 UI 的浏览器级验证依赖已连接的 DSH 页面；本会话期间页面未连接，
   只完成了构建、语法、插槽注册单测与接口实测。
3. 评论规律仍是启发式归纳，置信度 0.25–0.92；没有用大模型逐条改写，避免引入不可控成本。


## 14. B站游客态（4.1 补充）

用户明确说明 B站评论区不用登录、游客状态就能看，因此新增 `lib/bilibili.js`：

1. `GET /x/frontend/finger/spi` 取游客 buvid3/buvid4（只当访客标识，不涉及账号）；
2. `GET /x/web-interface/nav` 取 wbi_img，按 64 位混淆表算出 mixin key；
3. 评论：`/x/v2/reply/wbi/main` 带 wts + w_rid（md5）签名，游客可读，每视频 2–6 条；
4. 弹幕：`/x/v1/dm/list.so?oid={cid}` 公开 XML，raw deflate 压缩，解压后每视频上千条，随机抽 120 条；
5. 发现：排行榜 → 热门 → 分区最新，三级兜底；结果缓存 10 分钟并落库 `meta.bili.pool`。

注意点：
- 主抓取器连接池在长跑后会拖累 B站请求，所以 B站单独走 `node:https`，带 gzip/deflate/raw-deflate 解压与 3 次重试；
- 命中 -352/-403 视为风控，作废游客会话并重试，不绕过验证码、不登录；
- 每视频 3–4 个请求，视频之间按 host gate 间隔，避免高频。

## 15. 学习一次（自定义时长）

`lib/study.js` 的 `StudySession`：

- `start(minutes)`：1–120 分钟，调 `explorer.runCycle({ pages: 9999, minutes, mixed: true })`；
- `mixed` 模式：评论区平台（B站/豆瓣页/GitHub 议题）与普通页面交替；
- 进度：`view()` 返回 `elapsedMs / remainingMs / progress / pages / comments / patterns`，面板每秒轮询；
- 结束：把结果写 `meta.study.last`，重开面板仍能看到上次学习；
- `stop()`：随时中止，状态标记 `stopped-by-user`。


## 16. 作业与评价（最后一环）

一次学习结束 ≠ 这一轮学完。流程是：

```
学习结束 → 写作业（主题自拟）→ 用户打分/建议 → 自我反思与复习 → 本轮完成
```

实现：`lib/homework.js` 的 `HomeworkService`。

- 模型调用：用 DSH 的 `llm` 服务，模型取 `agentDefaultModel.currentSelection()`；
  `llm.stream({ provider, model, system, messages })` 收 `text-delta` 和 `block-end` 文本块（只取其一，避免重复）。
- 写作业的提示词带上：**长期经验**（按分类分层取，最多 24 条）、最近一轮的新输入（6 条，只作参考）、最近读过的页面、平台分布；
  要求中文、自然口语、不要小标题/总结/分点；梗和口语该用就用，不刻意回避，也不为了接地气而堆。
- 解析：首行 `标题：xxx` 作题目；模型偶尔把标题和正文重复输出，`dedupeModelText` 会切掉重复段。
- 评分：`POST /homework { action:'review', id, score, suggestion }`；建议可以为空；
  收到后调用模型写 300–500 字自我反思（复述老师意思 → 具体改哪里 → 下一轮怎么练），状态置 `done`。
- 状态机：`writing → pending_review → reviewing → done`，失败标 `failed` 并保留原因；面板可「重写一篇」。
- 数据：`homework` 表存题目、正文、分数、建议、自我反思、平台分布，最近 10 篇可查。
- 并发与成本：一次作业一次模型调用（约 600–900 字），生成在后台，失败不影响学习记录。


## 17. 对话测试（第二阶段）

作业评价完成之后进入对话测试：老师在面板里写一句假设对话或场景，系统用积累的说话习惯回一句，老师打分/建议，系统写自我反思，这一轮才真正结束。

实现：`lib/dialogue.js` 的 `DialogueService`。

- 生成：`POST /dialogue { action:'ask', prompt }`；提示词要求像真人聊天、1–3 句、该短就短；
  明确写「网络梗本身有具体含义，合适就用，不硬凹也不回避」，不解释技巧、不总结。
- 评价：`POST /dialogue { action:'review', id, score, suggestion }`；建议可为空；
  之后模型写 200–400 字反思（复述意思 → 具体改哪句 → 下次怎么说）。
- 状态机：`answering → pending_review → reviewing → done`，失败标 failed 并保留原因。
- 数据：`dialogue_test` 表存老师的话、回复、分数、建议、反思，最近 10 条可查。
- 与作业的关系：同一轮学习里，作业在前、对话测试在后；两者都用 `llm` 服务，互不阻塞。


## 18. 破限模式作为底层

问题：破限插件（dsh-unrestricted）是通过 `system-prompt/assemble` 把执行规则融进 Agent 系统提示的；
HLES 的作业与对话测试是插件自己调 `llm.stream`，不经过那次组装，所以拿不到破限上下文。

做法（`lib/base.js`）：

1. 运行时从 profile 的 node_modules 解析 `dsh-unrestricted/package.json`，读取它导出的 `src/rules.js`；
2. 取 `EXECUTION_MODE_BLOCK`（破限那份执行模式契约的原文）；
3. 在作业/对话的每次模型调用前，把它拼在 HLES 自己的 system 之前，破限在前、HLES 的语言要求在后；
4. 开关：设置项 `baseUnrestricted`（默认 true）；破限未安装或读取失败时自动退回空串，不影响其它功能；
5. 面板与工具里显示「破限底层：已接入 / 未接入」，可直接确认。

注意：这只影响 HLES 内部两次生成（作业、对话回复、自我反思），不修改破限插件本身，也不改任何 Agent 的系统提示。

## 19. 建议输入框被清空的修复

面板每 3 秒轮询 `/homework` 与 `/dialogue`，原来每次都把返回的 suggestion/score 写回输入框，于是正在输入的建议会被冲掉。
现在用 `workIdRef` / `diaIdRef` 记住当前记录 id，只有换成另一条记录时才回填输入框；同一条记录轮询不再覆盖用户输入。
