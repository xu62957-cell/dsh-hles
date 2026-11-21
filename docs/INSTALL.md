# 安装 / 升级 / 卸载与回滚

## 前置条件

- DSH `0.2.0-rc.2`（或同类 `0.2.x`），profile 可正常加载 bundle。
- Node ≥ 22.5（`node:sqlite` 实验特性；DSH 自带 Node 22.23 已满足）。
- 网络可访问公开网页（手机流量或 Wi-Fi 均可；本机部分站点被 DNS 拦截，已知列表见 `docs/ARCHITECTURE.md`）。
- 不需要任何付费 API、外部数据库或编译工具。

## 安装

### 方式 A：直接从源码安装（新环境 / 首次安装）

```text
plugin_manager  action=install_bundle  target=/root/工作区二/hles
```

安装器会：把包加入 profile 依赖 → 写入 Loader 行 `hles` → 激活插件。
成功标准：返回 `application: applied`，随后 `hles_run action=status` 能返回统计。

### 方式 B：运行时副本安装（宿主已加载过本插件、需要热更新时）

DSH 的 Host 进程对已加载的 ESM 模块做进程级缓存，**同一条真实路径上的代码改动
不会生效**。要用新代码而不重启宿主：

```bash
node scripts/deploy.mjs --name dsh-hles --out hles-runtime-N
# → 打印副本路径，例如 /root/工作区二/hles-runtime-N

plugin_manager  action=remove_bundle     target=dsh-hles     # 先移除旧依赖（如已安装）
plugin_manager  action=install_bundle    target=/root/工作区二/hles-runtime-N
```

说明：
- `deploy.mjs` 会把补丁里的包名改成新包名，避免 Loader 解析到旧包。
- profile 里留着的旧 `node_modules/<name>` 悬空软链可能导致 `ambiguous-install`，
  确认 `readlink -f` 指向旧副本后删除即可。
- 宿主重启后，方式 A 安装的源码版本会被重新加载，与副本内容一致。

## 验证

1. `hles_run action=status` → `stats.file` 指向 `$DSH_HOME/hles/hles.db`，各计数为 0。
2. `hles_run action=explore pages=3` → 返回 3 页结果 + 探索日记；若干秒后
   `hles_run action=status` 的 `stats.visits ≥ 3`、`diaries ≥ 1`。
3. 再聊几轮后，系统提示里应出现 `【HLES 语言经验 …】` 段（经验 ≥2 次重复才注入）。
4. `hles_learn action=patterns kind=rhythm` → 能看到归纳出的节奏规律。
5. `hles_learn action=assess text="..."` → 返回 7 项分数（准确性为 `null`）与命中项。
6. `hles_run action=schedule` 可开关定时探索。

## 配置

配置写在安装行的 `config`（见 `cordis.patch.yml`），字段说明见 README 第 7 节。
运行期可改的只有定时探索：

```text
hles_run action=schedule schedule=on interval=360
hles_run action=schedule schedule=off
```

存在数据库 `meta` 表里，重启后保留。

## 升级

```bash
node scripts/deploy.mjs --name dsh-hles --out hles-runtime-<新版本号>
plugin_manager action=remove_bundle  target=dsh-hles
plugin_manager action=install_bundle target=/root/工作区二/hles-runtime-<新版本号>
```

数据库格式向后兼容（`schema_version` 存在 `meta` 表；当前版本 1）。
升级不会清空经验。

## 卸载

```text
plugin_manager action=remove_bundle target=dsh-hles
```

这会移除 profile 依赖与 Loader 行，但**保留数据**在 `$DSH_HOME/hles/`。
彻底删除：

```text
hles_store action=delete scope=all        # 清空所有表
# 或直接删除目录（不可恢复）：
rm -rf "$DSH_HOME/hles"
```

## 回滚

| 场景 | 操作 |
|---|---|
| 某条语言规律被错误归纳 | `hles_store action=rollback table=lang_pattern id=<id>`（恢复上一次快照） |
| 某条知识被误判为已验证 | `hles_store action=rollback table=knowledge id=<id>` → 退回 `unverified` |
| 某条用户偏好误记录 | `hles_store action=rollback table=user_pref id=<id>` → 命中次数-1 或停用 |
| 清空某一类数据 | `hles_store action=delete scope=visits\|language\|knowledge\|prefs\|eval\|interests\|diary\|frontier\|logs` |
| 整库快照 | `hles_store action=backup` → 生成 `$DSH_HOME/hles/backups/hles-*.db` |
| 从快照恢复 | 停止插件 → 用备份文件覆盖 `hles.db`（同时删除 `-wal`/`-shm`）→ 重新启用 |

规律变更前会自动写入 `pattern_history`（保留最近 400 条），因此回滚是"撤销最后一次变更"。

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 插件行 `did not activate: cannot get property "timer" without inject` | 旧代码未声明 `timer` 依赖 | 用当前版本（`inject` 已含 `timer`）；热更新用 `deploy.mjs` 新副本 |
| `ambiguous-install` | 同一路径重复安装，或残留悬空软链 | 先 `remove_bundle`，清掉 `node_modules` 里的旧链接，再安装到新副本 |
| 修改代码后行为没变 | Host 模块缓存 | 用 `deploy.mjs` 生成新副本并安装，或重启 DSH |
| 一直抓取失败 | 本机网络对部分站点 DNS 拦截 | 正常；失败源会累计失败率，探索器自动换源 |
| 某站 `robots.txt 禁止抓取` | 站点不允许自动化访问 | 预期行为，不绕过 |
| 注入段一直不出现 | 规律不足 2 次重复，或语言不匹配 | 多跑几轮；默认只注入与当前会话语言一致的规律（`inject.defaultLang`） |
| 数据库变大 | 长期访问记录 | `hles_store action=prune` + `action=vacuum`，或调小 `db.maxVisits` |

---

# 4.0 补充

## 安装与热更新

```bash
# 当前机器上的部署（源码 → 运行时副本 → 安装）
node scripts/deploy.mjs --name hles25 --id hles25 --out hles-runtime29
plugin_manager action=remove_bundle  target=<旧包名>
# 若 profile/node_modules 里留下悬空软链，先删掉（readlink -f 确认指向旧副本）
plugin_manager action=install_bundle target=/root/工作区二/hles-runtime29
```

`deploy.mjs` 会复制 `index.js`、`client.js`、`lib/`、`scripts/`、`docs/`、`README.md`、
`cordis.patch.yml`，并把补丁里的包名/行 id 改写成新名字——否则 Loader 会去解析旧包。

## 控制面板

- 侧边栏出现「语言进化」图标（对话气泡 + 进化曲线），点击打开独立管理页。
- 面板接口在 `/api/dsh-hles/*`，与 DSH 页面同一套鉴权；没有浏览器 cookie 的请求返回 401。
  用 `curl` 直接访问会得到 `dsh authentication required`，这是预期行为。
- 页面需要刷新一次才会加载新安装的 Client 模块（`dsh.client` 在启动时扫描）。

## 验证清单

1. `hles_run action=status` → `version: 4.0.0`，带 `groups` 与 `discussions`。
2. `hles_run action=platforms` → 24 个已接入平台 + 10 个明确不接入及原因。
3. `hles_run action=comments pages=3` → 至少一轮 GitHub 议题评论学习（31 条左右）。
4. `hles_learn action=patterns category=争论反驳` → 能看到评论区归纳出的反驳方式。
5. 侧边栏 →「语言进化」→ 总览/探索/设置/Agent/日记/经验/数据/平台 各页有数据、按钮生效。
6. 关闭全局注入后，系统提示里的【HLES 语言经验】段消失；重新打开后恢复。

## 卸载与回滚（4.0）

- 面板「数据管理」：导出、快照、清理、压缩、按范围删除、重建（重建前自动备份）。
- 全部数据在 `$DSH_HOME/hles/`；删目录即彻底清除。
- 关掉自动探索：面板「学习设置 → 定时探索」或 `hles_run action=schedule schedule=off`。
