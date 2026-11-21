# HLES — 中文互联网语言进化插件（DSH）

> 一个跑在 DSH（DeepSeek Harness）里的全局语言能力插件：自主探索中文互联网与公开评论区，归纳真实人类的表达习惯，沉淀成长期经验，注入所有 Agent；再用「学习 → 作业 → 对话测试」的闭环持续检验。

![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-green) ![dsh](https://img.shields.io/badge/DSH-0.2.x-black)

## 下载

- 发布包：[Releases · v4.0.0](https://github.com/xu62957-cell/dsh-hles/releases/tag/v4.0.0)
- 直接下载：https://github.com/xu62957-cell/dsh-hles/releases/download/v4.0.0/dsh-hles-4.0.0.tar.gz

## 安装（两种方式）

### 1. 从 GitHub 克隆后本地安装

```bash
git clone https://github.com/<your-name>/dsh-hles.git
# 在 DSH 会话里执行：
# plugin_manager action=install_bundle target=<克隆下来的目录绝对路径>
```

安装后自动建库；侧边栏出现「语言进化」入口，默认每 360 分钟自主探索一轮。

### 2. 更新已安装的版本

DSH 的插件模块有缓存，换版本时用新的包名或新的目录再装一次：

```bash
node scripts/deploy.mjs --name dsh-hles --id dsh-hles --out <新目录>
# 先 remove_bundle 旧包，再 install_bundle 新目录
```

## 兼容性

| 项 | 要求 |
|---|---|
| DSH | 0.2.x（cordis 插件系统，`ctx.systemPrompt.context` / `ctx.tools.register` / `ctx.inject(['webServer'])`） |
| Node | >= 22（用 `node:sqlite` 的 `DatabaseSync`） |
| 系统 | Linux / Android PRoot / macOS 均可；无原生依赖 |
| 模型 | 用 DSH 当前默认模型（`agentDefaultModel`）；作业与对话测试需要可用的 llm 服务 |
| 可选 | 装 `dsh-unrestricted`（破限模式）时，作业/对话生成自动以它为底层 |

## 它做什么

| 模块 | 说明 |
|---|---|
| 中文探索 | 26 个可读中文平台 + RSS，按 45/30/15/10 的内容配比加权，中文优先 |
| 评论区 | 通用评论块提取、随机取样、12 类分类、评论规律归纳；B站游客态（评论 + 弹幕）、豆瓣小组、虎扑帖子、GitHub 议题 |
| 经验库 | 10 类语言经验（口语/流行语/幽默/情绪/接话/反驳/叙事/圈层/趋势/反 AI），SQLite 存储 |
| 全局注入 | 所有 Agent 自动接入，只加语言能力不改人格；可按会话单独关闭 |
| 学习一次 | 面板填分钟数，跑一次限时学习，实时进度条与平台占比 |
| 作业 | 学完自动写一篇中文文章（题材与学习无关），用户打分/建议 → 自我反思 |
| 对话测试 | 用户给一句场景 → 生成回复 → 打分/建议 → 自我反思，这一轮才结束 |
| 破限底层 | 作业/对话生成以破限模式的执行契约为底层（可在设置里关） |

---

> Human Language Evolution System 4.0
> DSH 全局语言能力增强模块：探索中文互联网与公开评论区 → 归纳真实表达规律 →
> 存进 SQLite 经验库 → 作为运行时上下文注入所有 Agent → 侧边栏面板管理与查看。

不是"搜索工具"的包装，也不改任何角色卡。它做的是完整的闭环：

```
中文内容/评论区探索 → 纯文本提取 → 语言分析 → 规律归纳 → 质量验证
        ↑                                                    ↓
   反馈评估 ← 所有 Agent 的对话 ← 全局运行时注入 ← 长期经验库
```

---

## 详细能力

| 能力 | 说明 | 实现 |
|---|---|---|
| 中文优先探索 | 24 个可读中文平台入口 + RSS，按 45/30/15/10 的内容配比加权 | `lib/platforms.js`、`lib/explore.js` |
| 评论区引擎 | 通用评论块提取、随机位置取样（不只热门）、12 类评论分类、评论规律归纳 | `lib/discussions.js` |
| B站游客态 | 排行榜随机挑视频 → 评论（wbi 签名，每视频 2–6 条）+ 弹幕（公开 XML，随机抽 120 条） | `lib/bilibili.js` |
| 一键学习 | 面板里填分钟数点「开始学习」，跑一次限时学习，带实时进度条与页数/评论/规律计数 | `lib/study.js`、`/api/dsh-hles/learn` |
| 作业与评价 | 学习结束后自动写一篇中文文章（题材与学习无关），考的是学习以来积累的整体能力；以破限模式为底层；用户在面板打分/提建议；系统接着写自我反思 | `lib/homework.js`、`/api/dsh-hles/homework` |
| 对话测试 | 作业之后第二阶段：写一句假设对话/场景，系统用积累的说话习惯回一句（同样以破限为底层），用户打分/建议，系统写自我反思，这一轮才算结束 | `lib/dialogue.js`、`/api/dsh-hles/dialogue` |
| 语言趋势 | 流行语/口头禅候选 + 30 天半衰的新鲜度权重，过时说法自然沉底 | `lib/db.js`（`term_trend`） |
| 十类经验库 | 中文口语 / 网络流行语 / 幽默 / 情绪 / 对话接续 / 争论反驳 / 日常叙述 / 圈层 / 趋势 / 反 AI | `lang_pattern.category` |
| 全局 Agent 注入 | 所有 Agent、所有预设、所有会话自动接入；只加语言能力，不改人格 | `lib/prompt.js`、`lib/agents.js` |
| 会话级开关 | 面板里可单独关掉某个 Agent；也可全局关闭 | `agents` 表 + `inject.global` |
| 侧边栏面板 | 「语言进化」入口 + 9 个功能页，每个按钮接真实实现 | `client.js`、`lib/routes.js` |
| 平台状态透明 | 已接入平台与"明确不接入 + 原因"都列在面板里，不伪装 | `platforms.js`、`/api/dsh-hles/platforms` |
| 注入鉴权 | 面板接口复用 DSH 浏览器鉴权，未登录进程读不到数据 | `connection.requestRejection` |

## 部署脚本（可选）

```bash
# 新环境：直接从源码安装
plugin_manager  action=install_bundle  target=/root/工作区二/hles

# 宿主已加载过本插件、需要热更新时（换新包名 + 新目录，绕开 ESM 缓存）
node scripts/deploy.mjs --name hles25 --id hles25 --out hles-runtime29
plugin_manager action=remove_bundle  target=hles16
plugin_manager action=install_bundle target=/root/工作区二/hles-runtime29
```

安装后自动工作：创建数据库、90 秒后检查定时探索（默认每 360 分钟一轮、每轮 6 页）。
侧边栏出现「语言进化」图标，点开就是控制面板。

## 面板页面

| 页 | 内容 | 实际接口 |
|---|---|---|
| 总览 | 版本、运行状态、累计页面/评论/规律、接入 Agent、数据库大小、最近学习时间、内容配比（目标 vs 实际） | `GET /api/dsh-hles/overview` |
| 学习设置 | 顶部「学习一次」：时长 1–120 分钟、开始/停止、进度条、上次学习结果；「平台占比」：五个平台的百分比（0=不学该平台），并显示上次学习的实际占比；「这次学习的作业」：文章、打分、建议、提交评价、自我反思 | `POST/GET /learn`、`POST/GET /homework`、`POST /settings` |
| 探索控制 | 开始 / 暂停 / 恢复 / 停止 / 单次 / 随机 / 评论区探索 + 每次页数 | `POST /control` |
| 学习设置 | 中文优先、四类内容配比、每轮页数、每页评论采样、重复过滤天数、定时开关与间隔 | `POST /settings` |
| 语言学习 | 七类学习开关 + 全局注入开关、注入字数、最小重复次数 | `POST /settings` |
| Agent 管理 | 所有见过的 Agent、单独开关、全局开关、刷新 | `GET/POST /agents` |
| 探索日记 | 最近讨论区、语言趋势、探索日记全文 | `GET /diary` |
| 语言经验 | 分类统计 + 规律列表（含例子、命中数、置信度） | `GET /patterns` |
| 数据管理 | 导出 JSON、数据库快照、清理、压缩、按范围删除、重建 | `POST /data` |
| 平台状态 | 已接入平台（状态/评论能力/说明）与未接入平台（原因） | `GET /platforms` |

面板接口与页面同一套鉴权：没有 DSH 浏览器 cookie 的请求返回 401。

## 四个工具（Agent 侧）

| 工具 | 主要 action |
|---|---|
| `hles_run` | `status` / `explore` / `comments`（评论区探索）/ `start` / `pause` / `resume` / `stop` / `schedule` / `diary` / `report` / `sources` / `platforms` |
| `hles_learn` | `patterns`（可按 category 过滤）/ `knowledge` / `interests` / `assess` / `feedback` / `injection_preview` / `trends` |
| `hles_store` | `stats` / `export` / `backup` / `delete` / `rollback` / `prune` / `vacuum` |
| `hles_homework` | `list` / `get` / `review`（代老师打分+建议）/ `generate`（重写一篇） |
| `hles_dialogue` | `list` / `get` / `ask`（给一句场景生成回复）/ `review`（打分+建议） |

典型用法：

```
hles_run action=comments pages=3      # 抓一轮可解析的公开讨论
hles_learn action=patterns category=争论反驳
hles_learn action=assess text="草稿"  # 15 类机械化体检 + 改法
hles_learn action=trends              # 最近哪些说法在升温
```

## 平台接入状态（实测）

**已接入（可读）**：豆瓣、豆瓣阅读、虎扑首页、龙空、水木、少数派、机核、阮一峰、36氪、掘金、CSDN、InfoQ、开源中国、网易新闻、搜狐、中国新闻网、界面、果壳、环球科学、中国科普博览、全历史、古诗文网、Solidot、爱范儿、GitHub 中文议题。

**评论区可解析的来源（实测）**：
- 哔哩哔哩游客态：排行榜 → 评论 + 弹幕，实测一个视频采样 32 条（6 条评论 + 120 条弹幕里抽 30）；不登录、不带账号 cookie。
- 豆瓣阅读/豆瓣读书等页面：服务端渲染的评论块（class:answer/class:comment），普通探索就会自动命中（9 条、3 条/页）。
- GitHub 公开议题 API（中文项目讨论，未登录 60 次/小时）——**已实测 31 条评论/轮**。
- 面板已在真实 WebView 里加载，8 个面板接口从页面内请求全部 200（数据库 meta 表的 client_diag 可查）。
- 任何"服务端渲染了评论块"的公开页面（通用提取器，按 `class=*comment*/*reply*` 重复块定位）。
- 其余主流平台评论区需要登录或前端渲染，**未接入**（见下）。

**明确不接入（面板里原样展示原因）**：

| 平台 | 原因 |
|---|---|
| 哔哩哔哩 | 已按你的要求接入游客态（见上），这里不再列为不接入 |
| 抖音 / 快手 / 小红书 / 西瓜 | 游客能看页面，但评论接口要 a_bogus / _signature / x-s 等签名，非浏览器拿不到 |
| 百度贴吧 | HTTP 403（WAF） |
| 知乎 | 页面 403，接口 AuthenticationError |
| V2EX | 本机 DNS 拦截 |
| NGA | HTTP 403 |
| 微博 | 未登录跳转登录页 |

这不影响闭环本身：系统仍然在中文内容上持续学习，只是"评论区"这块能拿到的公开语料比预期少，
这一点在面板、报告和本文里都写清楚，不伪装成已接入。

## 数据

默认目录 `$DSH_HOME/hles/`：

```
hles.db    SQLite（WAL）
diary/     探索日记（按天）
backups/   快照
exports/   导出 JSON
```

关键表：`visits`（含 group/platform）、`frontier`（含 group/platform）、`lang_pattern`（含 category/first_seen）、
`discussions`（每次讨论区的采样统计）、`term_trend`（流行语趋势）、`agents`（接入登记与开关）、
`knowledge`、`user_pref`、`evals`、`diary`、`logs`、`sources`。

## 设计约束

1. 不依赖用户关键词：目标来自平台入口、链接队列与阶段性兴趣。
2. 随机取样：评论区按位置随机抽，不只看热门/高赞。
3. 只存规律不存人：不保存用户名、简介等身份信息；例子 ≤150 字。
4. 少样本不注入：规律出现 ≥2 次（面板可调）才进系统提示。
5. 用户偏好 ≠ 通用规律：分表；一次反馈只写偏好。
6. 准确性不装：七项评分里 `accuracy` 恒为 `null`。
7. 不覆盖他人：只加一段运行上下文，不写角色卡/预设文件，不改其它插件数据。
8. 资源可控：单页 1.5MB / 同主机 2.5s 间隔 / 堆超 260MB 收工 / 队列日志按上限裁剪。

## 配置项

面板里的设置存在数据库（`meta.settings4`），安装行 `config` 提供默认值：

```yaml
explore: { pagesPerCycle: 6, maxPagesPerCycle: 20, minHostIntervalMs: 2500, timeoutMs: 20000 }
inject:  { enabled: true, maxChars: 700, minHits: 2, defaultLang: zh }
schedule:{ enabled: true, intervalMinutes: 360 }
```

运行期可改：中文优先、内容配比、页数、评论采样数、重复过滤、定时开关、七类学习开关、
全局注入、单 Agent 开关。

## 测试

```bash
node test/run-tests.mjs --offline    # 26 项离线测试（需 Node 22+）
node test/run-tests.mjs --pages 4    # 加真实网络探索
node test/long-run.mjs --pages 100 --batch 12   # 百页长跑
```

结果见 [`docs/TEST-REPORT.md`](docs/TEST-REPORT.md)。

## 目录结构

```
hles/
├── index.js            入口：工具 / 注入 / 定时器 / 面板路由
├── client.js           侧边栏「语言进化」图标 + 9 页控制面板
├── package.json        dsh.bundle + dsh.client
├── cordis.patch.yml    默认配置
├── lib/
│   ├── platforms.js    中文平台注册表（含未接入原因）
│   ├── discussions.js  评论区提取 / 取样 / 分类 / 规律
│   ├── bilibili.js     B站游客态：wbi 签名 / 评论 / 弹幕
│   ├── study.js        「学习一次」会话与进度
│   ├── homework.js     作业生成 / 打分 / 自我反思
│   ├── dialogue.js     对话测试 / 打分 / 反思
│   ├── settings4.js    运行期设置
│   ├── agents.js       Agent 接入与开关
│   ├── routes.js       面板 HTTP 接口（复用 DSH 鉴权）
│   ├── prompt.js       经验注入（分类分散 + 会话级开关，order 9500）
│   ├── explore.js      三通道探索 + 评论区模式 + 中文优先
│   ├── db.js           SQLite（含 4.0 迁移）
│   ├── language.js / anti-ai.js / quality.js / injection.js
│   ├── fetcher.js / robots.js / parse.js / sources.js
│   ├── learn.js / schedule.js / config.js / util.js / tools.js
├── scripts/            deploy.mjs（运行时副本）、hles-cli.mjs
├── test/               run-tests.mjs、long-run.mjs、fixtures.mjs
└── docs/               ARCHITECTURE.md、INSTALL.md、TEST-REPORT.md
```

## 已知边界

- **视频评论区**：B站 robots 全禁，抖音/快手/小红书/西瓜需登录或反爬；4.0 不抓，面板如实标注。
- **知识验证率**：需要两个独立来源才升级 `verified`，100 页里通常只有个位数。
- **前端渲染页面**：正文/评论由 JS 加载的页面会被标记 `thin`，不做浏览器渲染。
- **模块缓存**：已加载插件的代码需要新模块路径（`deploy.mjs`）或宿主重启才生效。
- **面板 UI**：本机 DSH 页面未连接时无法截图验证；接口、注册逻辑、构建产物均已单独测试。
