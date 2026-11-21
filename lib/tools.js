/**
 * 暴露给 Agent 的 3 个工具：运行控制、经验检索/自评、数据库维护。
 *
 * 工具输出一律是可读文本 + 结构化 JSON 值。文字部分刻意写短：模型需要的是
 * "这一轮读了什么、学到什么、下一步能做什么"，不是把整页正文再搬一遍。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assessText } from './quality.js';
import { truncate, round, jaccard } from './util.js';
import { readSchedule, setSchedule } from './schedule.js';

const TEXT = (text) => [{ type: 'text', text: String(text).slice(0, 12_000) }];

const OUT_SCHEMA = {
    type: 'object',
    properties: {},
    additionalProperties: true,
};

function tool({ name, description, parameters, execute, render }) {
    return {
        name,
        description,
        parameters,
        output: { schema: OUT_SCHEMA, render: (args, value) => TEXT(render(args, value)) },
        execute,
        isConcurrencySafe: () => false,
    };
}

const ADVICE = {
    'repeated-sentence': '把重复出现的短语/句式换掉一处，或直接删掉一次',
    'fixed-opening': '删掉「首先/总的来说/在这个」这类起手，直接从事实切入',
    'over-summary': '结尾不要总结全文；停在一个具体判断或下一步上',
    'connective-overuse': '砍掉一半连接词，让句子靠语序和内容衔接',
    'gratuitous-list': '把分点合并成两三句连贯的话，除非用户明确要清单',
    're-explaining': '同一件事只说一遍；已经说过的不要再换词重述',
    'template-comfort': '别套「我理解你的感受」，说一件具体的事代替安慰',
    'forced-empathy': '去掉表态式的共情，直接回应问题本身',
    'awkward-transition': '删掉「值得一提的是」这类过渡，直接说下一句',
    'over-parallel': '打破排比，只保留最有力的一句',
    'mechanical-ending': '删掉「希望对你有所帮助 / 还有其他问题随时说」',
    'over-polite': '去掉请/感谢/辛苦了的堆叠，一句话说完',
    'uniform-complete': '插一句短的、不完整的话，或把长句断开',
    'low-variation': '调整句长，别让每句都差不多长',
    'register-mismatch': '正式请求里去掉口语语气词和网络梗',
};

export function buildTools({ store, explorer, learner, injector, config, dataDir, settings = null, agents = null, study = null, homework = null, dialogue = null, version = '4.0.0' }) {
    const runTool = tool({
        name: 'hles_run',
        description: [
            'HLES 自主互联网探索系统的控制台。',
            'action=explore 立刻抓取并阅读若干公开页面（不依赖任何关键词），把读到的知识与语言规律写进长期经验库；',
            'status 看运行状态与统计；start/pause/resume/stop 控制后台定时探索；',
            'diary 看最近的探索日记；report 看综合报告；sources 看各站点的成功率。',
            '只有在用户想主动探索、查看状态、或调整运行状态时调用。',
        ].join(''),
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['status', 'explore', 'comments', 'study', 'probe', 'start', 'pause', 'resume', 'stop', 'schedule', 'diary', 'report', 'sources', 'platforms'],
                    description: '要执行的操作',
                },
                pages: { type: 'number', description: '单次探索页数（默认取配置，上限 maxPagesPerCycle）' },
                minutes: { type: 'number', description: '单次探索的时间上限（分钟）' },
                platform: { type: 'string', description: 'action=probe 时：要试抓的平台 id（如 bilibili）' },
                url: { type: 'string', description: 'action=probe 时：直接给一个公开页面 URL，抓一次并学习（评论区会自动识别）' },
                schedule: { type: 'string', enum: ['on', 'off'], description: 'action=schedule 时：打开或关闭定时探索' },
                interval: { type: 'number', description: 'action=schedule 时：定时间隔（分钟，5-1440）' },
            },
            required: ['action'],
        },
        async execute(args, exec) {
            const action = String(args?.action || 'status');
            if (action === 'status') {
                return {
                    ...explorer.status(),
                    effectiveSchedule: readSchedule(store, config),
                    stats: store.stats(),
                    trend: store.evalTrend(7),
                    version,
                    study: study ? study.view() : null,
                    clientDiag: (() => { try { return JSON.parse(store.getMeta('client_diag') || 'null'); } catch { return null; } })(),
                    recentVisits: store.recentVisits(5),
                    groups: store.groupCounts(),
                    discussions: store.discussionStats(),
                    patterns: store.patternKinds(),
                    effectiveSchedule: readSchedule(store, config),
                    knowledge: { total: store.stats().knowledge, verified: store.stats().verified, unverified: store.unverifiedKnowledge(3) },
                };
            }
            if (action === 'explore') {
                if (explorer.state.running) throw new Error('已有探索在运行，先用 action=status 看进度或 stop 掉');
                const pages = Math.max(1, Math.min(
                    Number(args?.pages) || config.explore.pagesPerCycle,
                    config.explore.maxPagesPerCycle,
                ));
                const result = await explorer.runCycle({ pages, minutes: Number(args?.minutes) || 0 });
                return {
                    cycleId: result.cycleId,
                    pages: result.pages,
                    ok: result.ok,
                    failed: result.failed,
                    stoppedReason: result.stoppedReason,
                    elapsedMs: result.elapsedMs,
                    domains: result.domains,
                    results: result.results.map((r) => ({
                        url: r.url,
                        title: truncate(r.title || '', 90),
                        domain: r.domain,
                        status: r.status,
                        ok: r.ok,
                        patterns: r.patterns,
                        knowledge: r.knowledge,
                        summary: truncate(r.summary || r.error || '', 160),
                    })),
                    diary: result.diary,
                };
            }
            if (action === 'comments') {
                if (explorer.state.running) throw new Error('已有探索在运行，先用 action=status 看进度或 stop 掉');
                const pages = Math.max(1, Math.min(Number(args?.pages) || 4, config.explore.maxPagesPerCycle));
                const result = await explorer.runCycle({ pages, mode: 'comments' });
                return {
                    cycleId: result.cycleId, pages: result.pages, ok: result.ok, stoppedReason: result.stoppedReason,
                    results: result.results.map((r) => ({ url: r.url, title: truncate(r.title || '', 90), domain: r.domain, status: r.status, patterns: r.patterns, comments: r.comments || 0 })),
                    diary: result.diary,
                };
            }
            if (action === 'start') {
                const out = explorer.start({ pages: Number(args?.pages) || config.explore.pagesPerCycle, minutes: Number(args?.minutes) || 0 });
                out.promise?.catch(() => {});
                return { started: true, pages: out.pages, minutes: out.minutes, note: '后台运行，用 action=status 查看进度' };
            }
            if (action === 'pause') return explorer.pause();
            if (action === 'resume') return explorer.resume();
            if (action === 'stop') return explorer.stop();
            if (action === 'schedule') {
                const enabled = args?.schedule === 'on' ? true : args?.schedule === 'off' ? false : undefined;
                const out = setSchedule(store, { enabled, intervalMinutes: args?.interval });
                store.log('info', `定时探索设置更新：enabled=${out.enabled} interval=${out.intervalMinutes}min`);
                return { ...out, note: out.enabled ? `每 ${out.intervalMinutes} 分钟自动探索一次` : '定时探索已关闭' };
            }
            if (action === 'study') {
                if (!study) return { text: '学习会话未初始化' };
                if (study.view().running) return { text: '已有学习在进行中', data: study.view() };
                const minutes = Math.max(1, Math.min(120, Number(args?.minutes) || 10));
                const started = study.start(minutes);
                return { text: `开始学习 ${minutes} 分钟，用 status 看进度`, data: started.study };
            }
            if (action === 'probe') {
                const direct = String(args?.url || '').trim();
                if (direct) {
                    if (!/^https?:\/\//u.test(direct)) throw new Error('url 必须以 http(s) 开头');
                    const target = { url: direct, domain: '未分类', host: new URL(direct).host, source: 'probe-url', group: 'other', platform: 'manual-url' };
                    const result = await explorer.processPage(target, 'random', new AbortController().signal);
                    return {
                        text: result.ok
                            ? `页面学习完成：${result.title || direct}，评论 ${result.comments || 0} 条，规律 ${result.patterns || 0} 条`
                            : `页面学习失败：${result.error || result.status}`,
                        data: result,
                    };
                }
                const id = String(args?.platform || 'bilibili');
                if (id === 'bilibili') {
                    const target = {
                        url: 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all',
                        domain: '未分类', host: 'api.bilibili.com', source: 'platform:bilibili', group: 'video', platform: 'bilibili',
                    };
                    const base = {
                        url: target.url, channel: 'random', host: target.host, site: target.host, domain: '视频',
                        status: 'ok', bytes: 0, ms: 0, title: '', patterns: 0, knowledge: 0, links: 0, group: 'video', platform: 'bilibili',
                    };
                    const result = await explorer.processBilibili({ base, target, started: Date.now() });
                    return {
                        text: result.ok
                            ? `B站取样成功：${result.title || ''}，评论+弹幕 ${result.comments || 0} 条，规律 ${result.patterns || 0} 条`
                            : `B站取样失败：${result.error || '未知错误'}`,
                        data: result,
                    };
                }
                return { text: '只支持 platform=bilibili 的试抓' };
            }
            if (action === 'diary') return { diaries: store.recentDiaries(3), discussions: store.recentDiscussions(6), trends: store.termTrends(12) };
            if (action === 'platforms') {
                const { PLATFORMS, UNSUPPORTED, GROUP_LABEL } = await import('./platforms.js');
                return { groups: GROUP_LABEL, platforms: PLATFORMS, unsupported: UNSUPPORTED };
            }
            if (action === 'sources') return { sources: store.sourceStats(20), frontier: store.frontierStats(), feeds: config.sources };
            if (action === 'report') {
                return {
                    stats: store.stats(),
                    trend: store.evalTrend(7),
                    domains: store.domainCounts(15),
                    patterns: store.patternKinds(),
                    discussions: store.discussionStats(),
                    groups: store.groupCounts(),
                    trends: store.termTrends(10),
                    topPatterns: store.topPatterns({ limit: 8 }).map((p) => ({ kind: p.kind, category: p.category, pattern: p.pattern, confidence: p.confidence })),
                    knowledge: store.searchKnowledge('', 5),
                    unverified: store.unverifiedKnowledge(5),
                    interests: store.topInterests(5),
                    diary: store.recentDiaries(1)[0]?.body || '',
                };
            }
            throw new Error(`未知 action：${action}`);
        },
        render(args, value) {
            if (!value || typeof value !== 'object') return String(value ?? '');
            if (value.text) return value.text;
            if (Array.isArray(value.homework)) {
                const head = typeof value.available === 'boolean' ? `作业模块：${value.available ? '可用' : '模型不可用'}\n` : '';
                const list = value.homework.map((w) => `#${w.id} ${w.topic || '(无标题)'} · ${w.status}`).join('\n');
                return head + (list || '还没有作业');
            }
            if (value.homework && typeof value.homework === 'object') {
                const w = value.homework;
                return [w.topic || '(无标题)', '状态：' + w.status, String(w.content || '').slice(0, 600)].filter(Boolean).join('\n');
            }
            if (value.latest) {
                const w = value.latest;
                return [w.topic || '(无标题)', w.status === 'pending_review' ? '等你打分' : w.status, String(w.content || '').slice(0, 400)].join('\n');
            }
            return JSON.stringify(value).slice(0, 600);
        },
    });

    const learnTool = tool({
        name: 'hles_learn',
        description: [
            'HLES 语言经验库的读写口。',
            'action=patterns 查已归纳的表达规律（可按 kind / query 过滤）；knowledge 查知识条目；interests 查阶段性兴趣；',
            'assess 对一段准备发出的文字做机械化体检（15 类反 AI 套路 + 7 项质量分），返回命中位置和改法；',
            'feedback 把用户明确说的语言偏好记下来（只影响该会话，不改通用规律）；',
            'injection_preview 看当前会被注入到系统提示里的经验块。',
            '写完一段重要回复后想自查是否太模板化时，优先用 action=assess。',
        ].join(''),
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['patterns', 'knowledge', 'interests', 'assess', 'feedback', 'injection_preview', 'trends'],
                    description: '要执行的操作',
                },
                text: { type: 'string', description: 'assess 时是要检查的文本；feedback 时是用户原话' },
                query: { type: 'string', description: 'patterns/knowledge 的检索词' },
                kind: { type: 'string', description: 'patterns 过滤：rhythm/particle/connective/dialogue/emotion/slang/forum/…' },
                category: { type: 'string', description: 'patterns 过滤：中文口语/网络流行语/幽默表达/情绪表达/对话接续/争论反驳/日常叙述/网络玩梗/知识讲解/通用' },
                subject: { type: 'string', description: 'feedback 时直接给出的偏好内容' },
                limit: { type: 'number', description: '返回条数，默认 8' },
                session: { type: 'string', description: '可选：会话 id，用于取该会话的偏好' },
            },
            required: ['action'],
        },
        async execute(args, exec) {
            const action = String(args?.action || 'patterns');
            const limit = Math.max(1, Math.min(40, Number(args?.limit) || 8));
            const sessionId = String(args?.session || exec?.agent?.id || '');
            if (action === 'trends') return { trends: store.termTrends(limit) };
            if (action === 'patterns') {
                const rows = store.allPatterns(400)
                    .filter((p) => !args?.kind || p.kind === args.kind)
                    .filter((p) => !args?.category || p.category === args.category)
                    .map((p) => ({ ...p, score: args?.query ? jaccard(args.query, `${p.pattern} ${p.key} ${p.example}`) : 0.5 }))
                    .filter((p) => !args?.query || p.score > 0.02)
                    .sort((a, b) => (args?.query ? b.score - a.score : b.confidence - a.confidence))
                    .slice(0, limit);
                return { count: rows.length, kinds: store.patternKinds(), categories: [...new Set(store.allPatterns(400).map((p) => p.category))], patterns: rows };
            }
            if (action === 'knowledge') {
                return { items: store.searchKnowledge(args?.query || '', limit), unverified: store.unverifiedKnowledge(Math.min(limit, 5)) };
            }
            if (action === 'interests') return { interests: store.topInterests(limit) };
            if (action === 'injection_preview') return injector.preview({ sessionId });
            if (action === 'feedback') {
                if (!args?.text && !args?.subject) throw new Error('feedback 需要 text（用户原话）或 subject');
                if (args?.subject) {
                    const r = learner.recordFeedback({ text: args.text || '', sessionId, kind: args.kind || 'dislike', subject: args.subject });
                    return { recorded: r, prefs: store.activePrefs({ sessionId, limit: 5 }) };
                }
                const found = learner.recordFeedback({ text: args.text, sessionId });
                return { found, prefs: store.activePrefs({ sessionId, limit: 5 }) };
            }
            if (action === 'assess') {
                if (!args?.text) throw new Error('assess 需要 text');
                const report = assessText(args.text, { context: args?.query || '', sessionId });
                report.suggestions = (report.aiHits || []).map((h) => ({ code: h.code, advice: ADVICE[h.code] || '' })).filter((x) => x.advice);
                return report;
            }
            throw new Error(`未知 action：${action}`);
        },
        render(args, value) {
            if (args?.action === 'assess' && value?.evaluated !== undefined) {
                if (!value.evaluated) return `文本太短，不评分。${value.note || ''}`;
                const score = [
                    `自然 ${fmt(value.natural)}｜流畅 ${fmt(value.fluency)}｜多样 ${fmt(value.diversity)}`,
                    `语境 ${fmt(value.contextFit)}｜连贯 ${fmt(value.coherence)}｜机械化 ${fmt(value.mechanization)}（越低越好）`,
                    '准确性：未评分（需事实核对）',
                ].join('\n');
                const hits = (value.aiHits || []).map((h) => `· ${h.name}：${h.samples.join(' / ')}`);
                const adv = (value.suggestions || []).map((s) => `  → ${s.advice}`);
                return `${score}\n${hits.length ? `\n命中：\n${hits.join('\n')}` : '\n没有命中机械化特征。'}\n${adv.length ? `\n改法：\n${adv.join('\n')}` : ''}`;
            }
            if (args?.action === 'injection_preview' && value?.text !== undefined) {
                return value.text ? `注入 ${value.chars} 字（${value.patterns} 条规律 / ${value.prefs} 条偏好）：\n${value.text}` : '当前经验不足，注入为空。';
            }
            if (args?.action === 'patterns') {
                const rows = (value.patterns || []).map((p) => `· [${p.category || p.kind}] ${p.pattern}${p.example ? `（例：${truncate(p.example, 40)}）` : ''} conf=${p.confidence} hits=${p.hits}`);
                return rows.length ? rows.join('\n') : '还没有归纳出语言经验，先跑一次探索。';
            }
            return JSON.stringify(value, null, 2).slice(0, 8000);
        },
    });

    const storeTool = tool({
        name: 'hles_store',
        description: [
            'HLES 经验库维护：统计、导出、备份、清理、回滚、压缩。',
            'stats 看容量与记录数；export 把全部经验导出成 JSON 文件；backup 生成数据库快照；',
            'delete 按范围清理（all/visits/frontier/knowledge/language/prefs/eval/interests/diary/logs）；',
            'rollback 撤销某条语言经验/知识/偏好的最近一次变更；prune 按上限裁剪；vacuum 回收空间。',
            '用户要求删除数据或备份时必须用这个工具，不要直接动文件。',
        ].join(''),
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['stats', 'export', 'backup', 'delete', 'rollback', 'prune', 'vacuum'],
                    description: '要执行的操作',
                },
                scope: { type: 'string', description: 'delete 的范围' },
                table: { type: 'string', description: 'rollback 的表：lang_pattern / knowledge / user_pref' },
                id: { type: 'number', description: 'rollback 的记录 id' },
            },
            required: ['action'],
        },
        async execute(args) {
            const action = String(args?.action || 'stats');
            if (action === 'stats') return { stats: store.stats(), trend: store.evalTrend(30), sources: store.sourceStats(10) };
            if (action === 'export') {
                const dir = join(dataDir, 'exports');
                mkdirSync(dir, { recursive: true });
                const file = join(dir, `hles-export-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
                const data = store.exportAll();
                writeFileSync(file, JSON.stringify(data, null, 2));
                return { file, tables: Object.fromEntries(Object.entries(data.tables).map(([k, v]) => [k, v.length])), bytes: JSON.stringify(data).length };
            }
            if (action === 'backup') return { file: store.backup(), stats: store.stats() };
            if (action === 'delete') {
                const scope = String(args?.scope || '');
                if (!scope) throw new Error('delete 需要 scope（all/visits/frontier/knowledge/language/prefs/eval/interests/diary/logs）');
                return store.deleteScope(scope);
            }
            if (action === 'rollback') {
                const table = String(args?.table || 'lang_pattern');
                const id = Number(args?.id);
                if (!id) throw new Error('rollback 需要 id');
                return store.rollback(table, id);
            }
            if (action === 'prune') return store.prune();
            if (action === 'vacuum') return store.vacuum();
            throw new Error(`未知 action：${action}`);
        },
        render(args, value) {
            return JSON.stringify(value, null, 2).slice(0, 8000);
        },
    });

    const homeworkTool = tool({
        name: 'hles_homework',
        description: [
            '查看/提交 HLES 的“作业与评价”。学习结束后系统会自动写一篇中文文章作为作业；',
            '用户（老师）在面板里打分、提建议后，系统写自我反思，这一轮才算学完。',
            'action=list 看最近作业；get 看一篇；review 代老师提交打分/建议；generate 用最近一次学习的数据重写一篇。',
        ].join(''),
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['list', 'get', 'review', 'generate'], description: '要执行的操作' },
                id: { type: 'number', description: '作业 id（get/review 用）' },
                score: { type: 'number', description: '打分 0–100（review 用，可省略）' },
                suggestion: { type: 'string', description: '老师的建议（review 用，可以为空）' },
            },
            required: ['action'],
        },
        async execute(args) {
            if (!homework) return { text: '作业模块未初始化' };
            const action = String(args?.action || 'list');
            if (action === 'list') {
                await homework.ensureBase?.();
                return { homework: homework.list(10), latest: homework.latest(), available: homework.available, base: homework.baseActive };
            }
            if (action === 'get') {
                const item = args?.id ? store.getHomework(Number(args.id)) : homework.latest();
                return { homework: item };
            }
            if (action === 'generate') {
                const item = await homework.generate(study ? study.view() : null);
                return { text: item?.status === 'pending_review' ? '作业写好了，等老师打分' : '作业生成失败', homework: item };
            }
            if (action === 'review') {
                const id = Number(args?.id) || homework.latest()?.id;
                if (!id) return { text: '还没有作业' };
                const item = await homework.review(id, { score: args?.score, suggestion: args?.suggestion });
                return { text: item?.status === 'done' ? '评价已接受，自我反思已生成' : '评价已记录，但自我反思生成失败', homework: item };
            }
            return { text: '未知操作' };
        },
        render(args, value) {
            if (!value || typeof value !== 'object') return String(value ?? '');
            if (value.text) return value.text;
            if (Array.isArray(value.homework)) {
                const head = (typeof value.available === 'boolean' ? ('作业模块：' + (value.available ? '可用' : '模型不可用')) : '') + (typeof value.base === 'boolean' ? (' · 破限底层：' + (value.base ? '已接入' : '未接入')) : '') + '\n';
                const lines = value.homework.map((w) => '#' + w.id + ' ' + (w.topic || '(无标题)') + ' · ' + w.status).join('\n');
                return head + (lines || '还没有作业');
            }
            if (value.homework && typeof value.homework === 'object') {
                const w = value.homework;
                return [w.topic || '(无标题)', '状态：' + w.status, String(w.content || '').slice(0, 600)].filter(Boolean).join('\n');
            }
            if (value.latest) {
                const w = value.latest;
                return [w.topic || '(无标题)', w.status === 'pending_review' ? '等你打分' : w.status, String(w.content || '').slice(0, 400)].join('\n');
            }
            return JSON.stringify(value).slice(0, 600);
        },
    });

    const dialogueTool = tool({
        name: 'hles_dialogue',
        description: [
            '对话测试：作业打分之后进入的第二个阶段。老师给一句假设对话或场景，系统用积累的语言习惯回一句；',
            '老师再打分/提建议，系统写自我反思。action=list 看最近测试；get 看一条；ask 先生成回复；review 代老师提交打分/建议。',
        ].join(''),
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['list', 'get', 'ask', 'review'], description: '要执行的操作' },
                id: { type: 'number', description: '测试 id（get/review 用）' },
                prompt: { type: 'string', description: '老师的话或场景（ask 用）' },
                score: { type: 'number', description: '打分 0–100（review 用）' },
                suggestion: { type: 'string', description: '老师的建议（review 用，可为空）' },
            },
            required: ['action'],
        },
        async execute(args) {
            if (!dialogue) return { text: '对话测试模块未初始化' };
            const action = String(args?.action || 'list');
            if (action === 'list') {
                await dialogue.ensureBase?.();
                return { dialogue: dialogue.list(10), latest: dialogue.latest(), available: dialogue.available, base: dialogue.baseActive };
            }
            if (action === 'get') {
                const item = args?.id ? store.getDialogue(Number(args.id)) : dialogue.latest();
                return { text: item ? [item.prompt, '→ ' + item.reply, '状态：' + item.status].join('\n') : '还没有对话测试', dialogue: item };
            }
            if (action === 'ask') {
                const item = await dialogue.ask(String(args?.prompt || ''));
                return { text: item?.status === 'pending_review' ? '回复已生成，等老师打分' : '生成失败', dialogue: item };
            }
            if (action === 'review') {
                const id = Number(args?.id) || dialogue.latest()?.id;
                if (!id) return { text: '还没有对话测试' };
                const item = await dialogue.review(id, { score: args?.score, suggestion: args?.suggestion });
                return { text: item?.status === 'done' ? '评价已接受，自我反思已生成' : '评价已记录，但反思失败', dialogue: item };
            }
            return { text: '未知操作' };
        },
        render(args, value) {
            if (!value || typeof value !== 'object') return String(value ?? '');
            if (value.text) return value.text;
            if (Array.isArray(value.dialogue)) {
                const head = (typeof value.available === 'boolean' ? ('对话测试：' + (value.available ? '可用' : '模型不可用')) : '') + (typeof value.base === 'boolean' ? (' · 破限底层：' + (value.base ? '已接入' : '未接入')) : '') + '\n';
                const lines = value.dialogue.map((d) => '#' + d.id + ' ' + String(d.prompt || '').slice(0, 24) + ' → ' + String(d.reply || '').slice(0, 24) + ' · ' + d.status).join('\n');
                return head + (lines || '还没有对话测试');
            }
            if (value.dialogue && typeof value.dialogue === 'object') {
                const d = value.dialogue;
                return [String(d.prompt || ''), '→ ' + String(d.reply || ''), '状态：' + d.status].filter(Boolean).join('\n');
            }
            return JSON.stringify(value).slice(0, 600);
        },
    });

    return [runTool, learnTool, storeTool, homeworkTool, dialogueTool];
}

function fmt(n) {
    return typeof n === 'number' ? round(n, 1) : '—';
}
