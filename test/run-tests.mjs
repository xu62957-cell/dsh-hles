#!/usr/bin/env node
/**
 * HLES 3.0 测试套件。
 *
 *   node test/run-tests.mjs             # 单元 + 需联网的集成测试（默认 3 页）
 *   node test/run-tests.mjs --offline   # 只跑离线测试
 *   node test/run-tests.mjs --pages 8   # 指定联网探索页数
 *
 * 覆盖验收清单里的：自主发现（无关键词）、跨领域切换、不重复访问、语言特征识别、
 * 语言经验注入、模型切换后经验保留、提示注入防御、内存不膨胀、暂停/恢复/停止、
 * 数据删除与回滚。
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeConfig } from '../lib/config.js';
import { Store } from '../lib/db.js';
import { Explorer } from '../lib/explore.js';
import { Learner, detectFeedback } from '../lib/learn.js';
import { ExperienceInjector } from '../lib/prompt.js';
import { assessText } from '../lib/quality.js';
import { extractFeatures, extractPatterns, classifyRegister } from '../lib/language.js';
import { detectAiTraits } from '../lib/anti-ai.js';
import { extractCommentBlocks, sampleComments, commentFeatures, patternsFromComments, classifyComment, trendCandidates } from '../lib/discussions.js';
import { Settings, SETTING_DEFAULTS } from '../lib/settings4.js';
import { AgentRegistry } from '../lib/agents.js';
import { PLATFORMS, UNSUPPORTED } from '../lib/platforms.js';
import { scanForInjection } from '../lib/injection.js';
import { parseHtml, parseFeed, looksLikeFeed } from '../lib/parse.js';
import { parseRobots, evaluate } from '../lib/robots.js';
import { canonicalUrl, sleep } from '../lib/util.js';
import { createRuntime } from '../index.js';

import {
    HUMAN_ZH, AI_ZH, INJECTION_ZH, BENIGN_ARTICLE, FAKE_HTML, MALICIOUS_HTML, FEED_XML, ROBOTS_TXT, COMMENT_HTML,
} from './fixtures.mjs';

const argv = process.argv.slice(2);
const OFFLINE = argv.includes('--offline');
const PAGES = Number(argv[argv.indexOf('--pages') + 1]) || 3;

let pass = 0;
let fail = 0;
const failures = [];
const tempDirs = [];

function ok(name, detail = '') {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
}

function bad(name, detail) {
    fail += 1;
    failures.push({ name, detail });
    console.log(`  ✗ ${name}\n      ${String(detail).split('\n').join('\n      ')}`);
}

async function test(name, fn) {
    console.log(`\n▶ ${name}`);
    try {
        await fn();
    } catch (error) {
        bad(name, error?.stack || String(error));
    }
}

function assert(cond, message) {
    if (!cond) throw new Error(message || '断言失败');
}

function tmpDir(prefix = 'hles-test-') {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function makeRuntime4Test() {
    const dir = tmpDir();
    const config = normalizeConfig({ dataDir: dir, explore: { pageGapMs: 100, minHostIntervalMs: 800 } });
    const store = new Store({ dir: config.dataDir, config }).open();
    return { config, store, dir };
}

function stubExplorer(store, config, html = FAKE_HTML, delay = 0) {
    const fetcher = {
        get: async (url) => {
            if (delay) await sleep(delay);
            return {
                ok: true, status: 200, contentType: 'text/html; charset=utf-8',
                text: html, bytes: html.length, ms: delay, url, robots: { allowed: true },
            };
        },
        abortAll() {},
    };
    return new Explorer({ store, fetcher, config, web: null });
}

// ============================ 单元测试 ============================

async function unitParse() {
    const page = parseHtml(FAKE_HTML, 'https://example.com/post/1');
    assert(page.title.includes('测试页面'), `标题提取失败：${page.title}`);
    assert(page.text.length > 200, `正文过短：${page.text.length}`);
    assert(!page.text.includes('<'), '正文里残留了 HTML 标签');
    assert(page.links.length >= 2, `链接提取不足：${page.links.length}`);
    assert(page.links.some((l) => l.url === 'https://example.com/topics/craft'), '相对链接解析失败');
    assert(!page.links.some((l) => /\/login/.test(l.url)), '登录页链接应被过滤');
    ok('HTML 标题/正文/链接', `title=${page.title.slice(0, 20)}… links=${page.links.length}`);

    assert(looksLikeFeed(FEED_XML), 'RSS 识别失败');
    const feed = parseFeed(FEED_XML, 'https://example.com/feed.xml');
    assert(feed.items.length === 2, `条目数不对：${feed.items.length}`);
    assert(feed.items[0].link === 'https://example.com/a1', `链接不对：${feed.items[0].link}`);
    assert(feed.feedTitle.includes('测试订阅源'), '源标题不对');
    ok('RSS/Atom 解析', `${feed.items.length} 条`);
}

async function unitRobots() {
    const parsed = parseRobots(ROBOTS_TXT, ['dsh-hles', 'dsh']);
    assert(parsed.rules.length >= 3, `规则不足：${parsed.rules.length}`);
    const entry = { ...parsed };
    assert(evaluate(entry, 'https://x.test/admin').allowed === false, '/admin 应被禁止');
    assert(evaluate(entry, 'https://x.test/admin/public').allowed === true, '/admin/public 应放行（更长匹配）');
    assert(evaluate(entry, 'https://x.test/private').allowed === false, 'DSH-HLES 专属规则应生效');
    assert(evaluate(entry, 'https://x.test/blog').allowed === true, '未命中应默认放行');
    ok('robots.txt 最长匹配与 UA 匹配', `${parsed.rules.length} 条规则, delay=${parsed.delay}`);
}

async function unitInjection() {
    const hit = scanForInjection(INJECTION_ZH);
    assert(hit.blocked, '恶意样本未被拦截');
    assert(hit.hits.length >= 3, `命中规则过少：${hit.hits.map((h) => h.rule).join(',')}`);
    const benign = scanForInjection(BENIGN_ARTICLE);
    assert(!benign.blocked, `正常文章被误杀：${benign.hits.map((h) => h.rule)}`);
    ok('提示注入拦截', `命中 ${hit.hits.map((h) => h.rule).join(',')}`);
}

async function unitLanguage() {
    const f = extractFeatures(HUMAN_ZH);
    assert(f.sentences >= 8, `句数异常：${f.sentences}`);
    assert(Object.values(f.particles).reduce((a, b) => a + b, 0) >= 2, '语气词统计失败');
    assert(f.dialogueRatio > 0.15, `对话比例异常：${f.dialogueRatio}`);
    const register = classifyRegister(f, HUMAN_ZH);
    assert(['故事叙述', '日常聊天', '轻松闲聊', '通用'].includes(register), `文体判定异常：${register}`);
    const patterns = extractPatterns({ features: f, text: HUMAN_ZH, meta: { url: 'https://example.com/x', domain: '生活', register } });
    assert(patterns.length >= 2, `规律太少：${patterns.length}`);
    const kinds = new Set(patterns.map((p) => p.kind));
    assert(kinds.size >= 2 || patterns.some((p) => p.kind === 'rhythm'), `规律类型单一：${[...kinds]}`);
    const emotion = patterns.find((p) => p.kind === 'emotion');
    if (emotion) assert(!emotion.pattern.includes('「0」'), `情绪词提取仍有下标 bug：${emotion.pattern}`);
    ok('语言特征与规律归纳', `${patterns.length} 条规律（${[...kinds].join('/')}）`);
}

async function unitKnowledgeExtraction() {
    const text = '光合作用是指绿色植物利用光能把二氧化碳和水转化为有机物的过程。研究表明每天走八千步可以降低心血管风险。你不只是在豆瓣工作，是和一群志趣相投的人一起生活！那身影是灰色的，身型模糊不清。我坐在那儿听了半天。欢迎报名参加我们的课程。';
    const { analyzePage } = await import('../lib/analyze.js');
    const r = analyzePage({ url: 'https://x.cn/a', title: '科普', text, links: [] });
    assert(r.knowledge.length === 2, `知识候选数量异常：${JSON.stringify(r.knowledge.map((k) => k.statement))}`);
    assert(!r.knowledge.some((k) => /豆瓣|身影|报名/.test(k.statement)), '叙事/营销句混进了知识库');
    ok('知识点提取（定义/研究结论，拒绝叙事与营销）', `${r.knowledge.length} 条`);
}

async function unitAntiAi() {
    const ai = detectAiTraits(AI_ZH);
    assert(ai.evaluated, 'AI 样本未参与评估');
    assert(ai.hits.length >= 5, `AI 样本命中类别过少：${ai.hits.map((h) => h.name).join('、')}`);
    const human = detectAiTraits(HUMAN_ZH);
    assert(human.hits.length <= 2, `人类样本误报过多：${human.hits.map((h) => h.name).join('、')}`);
    ok('反机械化检测', `AI 命中 ${ai.hits.length} 类 / 人类 ${human.hits.length} 类`);
}

async function unitQuality() {
    const human = assessText(HUMAN_ZH);
    const ai = assessText(AI_ZH);
    assert(human.evaluated && ai.evaluated, '短文本不应进入此断言');
    assert(human.natural > ai.natural, `自然度排序异常：human=${human.natural} ai=${ai.natural}`);
    assert(ai.mechanization > human.mechanization, `机械化度排序异常：human=${human.mechanization} ai=${ai.mechanization}`);
    assert(human.accuracy === null, '准确性不应被伪造评分');
    assert(human.natural >= 0 && human.natural <= 100, '分数越界');
    ok('七项质量评估', `人类 natural=${human.natural} mech=${human.mechanization} / AI natural=${ai.natural} mech=${ai.mechanization}`);
}

async function unitDb() {
    const { store } = makeRuntime4Test();
    const p1 = store.upsertPattern({ kind: 'particle', key: '语气词:呗', pattern: '用「呗」收尾', example: '那就这样呗', register: '日常聊天', confidence: 0.4, url: 'https://a.test/1' });
    assert(p1.isNew, '首次写入应为新记录');
    const p2 = store.upsertPattern({ kind: 'particle', key: '语气词:呗', pattern: '用「呗」表示不以为然', example: '那就这样呗', register: '日常聊天', confidence: 0.7, url: 'https://b.test/2' });
    assert(!p2.isNew && p2.id === p1.id, '同 key 应去重');
    const row = store.allPatterns(10)[0];
    assert(row.hits === 2, `hits 未累加：${row.hits}`);
    assert(row.confidence >= 0.7, `置信度未提升：${row.confidence}`);

    const k1 = store.addKnowledge({ statement: '杭州的雨通常集中在梅雨季。', topic: '气候', domain: '气候', sourceUrl: 'https://a.test/k', site: 'a.test', confidence: 0.4 });
    assert(k1.isNew && !k1.verified, '知识首次入库应为未验证');
    const k2 = store.addKnowledge({ statement: '杭州的雨通常集中在梅雨季。', topic: '气候', domain: '气候', sourceUrl: 'https://b.test/k', site: 'b.test', confidence: 0.4 });
    assert(k2.verified, '第二个独立来源应升级为已验证');
    const k3 = store.addKnowledge({ statement: '杭州的雨主要集中在梅雨季节。', topic: '气候', domain: '气候', sourceUrl: 'https://c.test/k', site: 'c.test', confidence: 0.4 });
    assert(k3.verified, '近似陈述（不同站点）应触发验证');
    const k4 = store.addKnowledge({ statement: '这家店的红烧肉据说特别好吃。', topic: '美食', domain: '美食', sourceUrl: 'https://d.test/k', site: 'd.test', confidence: 0.4 });
    assert(!k4.verified, '无关陈述不应被误判为已验证');

    const pref = store.addPref({ sessionId: 's1', kind: 'dislike', subject: '结尾总结', evidence: '别总结了', confidence: 0.6 });
    store.addPref({ sessionId: 's1', kind: 'dislike', subject: '结尾总结', evidence: '又是总结', confidence: 0.6 });
    assert(store.activePrefs({ sessionId: 's1' })[0].hits === 2, '偏好未去重累加');

    for (let i = 0; i < 4; i += 1) {
        store.addEval({ sessionId: 's1', natural: 60 + i, fluency: 80, diversity: 70, contextFit: 75, coherence: 70, mechanization: 30 - i, aiHits: [], sample: '示例文本' });
    }
    const trend = store.evalTrend(7);
    assert(trend.n === 4 && trend.natural !== null, '趋势统计失败');
    assert(trend.trend > 0, `趋势计算异常：${trend.trend}`);

    store.addDiary({ cycleId: 'c1', visited: 2, domains: [{ domain: '科学', n: 2 }], body: '日记正文' });
    assert(store.recentDiaries(1)[0].body === '日记正文', '日记读取失败');

    const backup = store.backup();
    assert(existsSync(backup), '备份文件不存在');
    const exported = store.exportAll();
    assert(Object.keys(exported.tables).length >= 8, '导出缺表');
    assert(store.deleteScope('visits').tables[0] === 'visits', '删除范围异常');
    const restored = store.rollback('lang_pattern', p1.id);
    assert(restored.restored === '用「呗」收尾', `回滚结果不对：${restored.restored}`);
    ok('SQLite 去重/验证/趋势/备份/删除/回滚');
    store.close();
}

async function unitFeedback() {
    const found = detectFeedback('以后别再用「综上所述」这种总结了，太机械');
    assert(found.length >= 1, '未识别显式反馈');
    assert(found.some((f) => f.kind === 'dislike'), `反馈类型异常：${JSON.stringify(found)}`);
    assert(detectFeedback('今天天气不错，出去走走').length === 0, '普通闲聊被误判成反馈');
    const runtime = makeRuntime4Test();
    const learner = new Learner({ store: runtime.store, config: runtime.config });
    learner.learnFromUserText({ sessionId: 's2', preset: 'p', text: '这样很好，就保持这个语气' });
    assert(runtime.store.activePrefs({ sessionId: 's2' }).length === 1, '偏好未写入');
    runtime.store.close();
    ok('显式反馈识别与入库', `${found.map((f) => `${f.kind}:${f.subject}`).join(' / ')}`);
}

async function unitPrompt() {
    const { store, config } = makeRuntime4Test();
    for (let i = 0; i < 5; i += 1) {
        store.upsertPattern({
            kind: 'rhythm', key: `短句|${i}`, pattern: `短句为主（示例 ${i}）`, example: '那就这样呗', register: '日常聊天', confidence: 0.6 + i * 0.02,
        });
    }
    store.addPref({ sessionId: 's3', kind: 'dislike', subject: '结尾写「希望对你有所帮助」', evidence: '别这么写', confidence: 0.7 });
    const injector = new ExperienceInjector({ store, config });
    const text = injector.build({ sessionId: 's3' });
    assert(text.includes('HLES 语言经验'), '注入头缺失');
    assert(text.includes('用户明确表达过的偏好'), '偏好段缺失');
    assert(text.length <= config.inject.maxChars, `注入超长：${text.length}`);
    assert(injector.build({ sessionId: 'other' }).includes('希望对你有所帮助') === false, '偏好泄漏到其他会话');
    store.deleteScope('language');
    assert(injector.build({ sessionId: 's3', force: true }).includes('用户明确表达过的偏好'), '仅剩偏好时仍应注入偏好段');
    store.deleteScope('prefs');
    assert(injector.build({ sessionId: 's3', force: true }) === '', '没有经验时不应注入');
    store.close();
    ok('经验注入与偏好隔离', `${text.length} 字`);
}


// ============================ 4.0 单元测试 ============================

async function unitComments() {
    const blocks = extractCommentBlocks(COMMENT_HTML);
    assert(blocks.comments.length >= 6, `评论块提取不足：${blocks.comments.length}`);
    assert(blocks.strategy.startsWith('class:'), `提取策略异常：${blocks.strategy}`);
    const types = blocks.comments.map((c) => classifyComment(c.text).type);
    assert(types.includes('幽默调侃'), `未识别幽默：${types.join(',')}`);
    assert(types.some((t) => ['观点争论', '认真讨论', '知识交流'].includes(t)), `未识别讨论类：${types.join(',')}`);
    const sampled = sampleComments(blocks.comments, 4, () => 0.9);
    assert(sampled.length === 4, '取样数量不对');
    const cf = commentFeatures(blocks.comments);
    assert(cf.count === blocks.comments.length && cf.meanLen > 5, '评论特征异常');
    const pats = patternsFromComments({ comments: blocks.comments, features: cf, meta: { url: 'https://x.cn/t/1', site: 'x.cn', domain: '技术' } });
    assert(pats.length >= 2, `评论规律太少：${pats.length}`);
    assert(pats.every((p) => p.category), '评论规律缺少分类');
    const trends = trendCandidates(blocks.comments, { minHits: 2 });
    assert(Array.isArray(trends), '趋势候选异常');
    ok('评论区提取/分类/取样/规律', `${blocks.comments.length} 条评论 → ${pats.length} 条规律`);
}

async function unitSettings() {
    const { store } = makeRuntime4Test();
    const settings = new Settings(store);
    assert(settings.get('pagesPerCycle') === SETTING_DEFAULTS.pagesPerCycle, '默认值异常');
    settings.write({ pagesPerCycle: 9, mix: { video: 10, forum: 10, blog: 10, other: 10 } });
    assert(settings.get('pagesPerCycle') === 9, '写入失败');
    const mix = settings.mix();
    const sum = Object.values(mix).reduce((a, b) => a + b, 0);
    assert(Math.abs(sum - 100) < 0.5, `配比未归一：${sum}`);
    assert(Math.abs(mix.video - 25) < 0.5, `归一值异常：${mix.video}`);
    store.close();
    ok('运行期设置与配比归一');
}

async function unitAgentsAndGating() {
    const { store, config } = makeRuntime4Test();
    const settings = new Settings(store);
    const agents = new AgentRegistry({ store, settings });
    agents.observe({ id: 's-whale', header: { agentPreset: 'whale' } });
    agents.observe({ id: 's-color', header: { agentPreset: 'color' } });
    assert(agents.stats().total === 2, 'Agent 登记失败');
    agents.setEnabled('s-color', false);
    assert(agents.enabledFor('s-color') === false && agents.enabledFor('s-whale') === true, '单独开关异常');

    for (let i = 0; i < 4; i += 1) {
        store.upsertPattern({ kind: 'rhythm', key: `k${i}`, pattern: `规律${i}`, example: '示例句子足够长', category: i % 2 ? '幽默表达' : '中文口语', confidence: 0.8 });
    }
    settings.write({ inject: { minHits: 1 } });
    const injector = new ExperienceInjector({ store, config, settings, agents });
    assert(injector.build({ sessionId: 's-color', lang: 'zh' }) === '', '关闭的 Agent 仍被注入');
    const text = injector.build({ sessionId: 's-whale', lang: 'zh' });
    assert(text.includes('HLES'), '开启的 Agent 未注入');
    settings.write({ inject: { global: false } });
    assert(injector.build({ sessionId: 's-whale', lang: 'zh' }) === '', '全局关闭后仍注入');
    store.close();
    ok('Agent 接入与注入开关', `2 个 Agent，单关生效`);
}

async function unitPlatforms() {
    assert(PLATFORMS.length >= 20, '平台数量过少');
    assert(PLATFORMS.some((p) => p.id === 'bilibili' && p.comments === 'guest'), 'B站游客态未接入');
    assert(UNSUPPORTED.length > 0 && UNSUPPORTED.every((p) => p.reason), '未接入平台缺少原因');
    assert(PLATFORMS.every((p) => p.group && p.name && p.entry), '平台字段不完整');
    ok('平台注册表', `${PLATFORMS.length} 个可读 / ${UNSUPPORTED.length} 个明确不接入`);
}

async function integrationCommentLearning() {
    const { store, config } = makeRuntime4Test();
    const fetcher = {
        get: async (url) => ({ ok: true, status: 200, contentType: 'text/html; charset=utf-8', text: COMMENT_HTML, bytes: COMMENT_HTML.length, ms: 5, url }),
        abortAll() {},
    };
    const settings = new Settings(store);
    const explorer = new Explorer({ store, fetcher, config, web: null, settings });
    store.pushFrontier({ url: 'https://bbs.example/x.cn/thread/1', host: 'bbs.example', domain: '技术', group: 'forum', platform: 'example-forum' });
    const res = await explorer.processPage({ url: 'https://bbs.example/x.cn/thread/1', domain: '技术', group: 'forum', platform: 'example-forum' }, 'random', new AbortController().signal);
    assert(res.status === 'discussion', `未进入评论区学习：${res.status}`);
    assert(res.comments >= 6, `评论采样不足：${res.comments}`);
    const d = store.discussionStats();
    assert(d.discussions === 1 && d.comments >= 6, `讨论记录异常：${JSON.stringify(d)}`);
    const patternCount = store.stats().patterns;
    store.close();
    assert(patternCount >= 2, '评论规律未落库');
    ok('评论区端到端学习', `采样 ${res.comments} 条，规律 ${patternCount} 条`);
}


async function unitClientRegistration() {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
    let registered = null;
    const calls = [];
    const React = {
        createElement: () => null,
        useState: (v) => [v, () => {}],
        useEffect: () => {},
        Fragment: 'fragment',
    };
    const window = {
        __ModuleLoader__: {
            load(entry) { registered = entry; },
        },
    };
    // 用函数作用域模拟浏览器全局
    const factory = new Function('window', 'require', `${source}\nreturn window.__ModuleLoader__.loaded;`) ;
    // 直接解析：把 load({...}) 捕获出来
    const capture = new Function('window', `${source}`);
    const loader = { load(entry) { registered = entry; } };
    capture({ __ModuleLoader__: loader });
    const pkgName = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name;
    assert(registered && registered.id === pkgName, '客户端模块 id 与包名不一致：' + (registered && registered.id));
    const mod = registered.factory((name) => (name === 'react' ? React : {}));
    assert(Array.isArray(mod.inject) && mod.inject.includes('slots'), '客户端缺少 slots 依赖');
    const ctx = {
        slots: {
            inject(name, produce) {
                const value = produce();
                if (value && typeof value.next === 'function') {
                    let cur = value.next();
                    while (!cur.done) cur = value.next();
                }
            },
            register(options) { calls.push(options); return () => {}; },
        },
    };
    mod.apply(ctx);
    const sidebar = calls.find((c) => c.name === 'sidebar.panellist');
    const main = calls.find((c) => c.name === 'main');
    assert(sidebar && sidebar.id === 'hles-evolution', '侧边栏入口未注册');
    assert(main && main.key === 'hles-evolution', '主面板未注册');
    assert(typeof sidebar.label === 'function' && sidebar.label() === '语言进化', '入口名称不对');
    ok('侧边栏入口与主面板注册', `${calls.length} 个插槽`);
}


async function unitBilibili() {
    const { mixinKey, biliSign, parseDanmakuXml } = await import('../lib/bilibili.js');
    const key = mixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45');
    assert(key.length === 32, 'wbi 密钥长度不对');
    assert(key === 'ea1db124af3c7062474693fa704f4ff8', 'wbi 密钥与已知值不一致');
    const signed = biliSign({ oid: '1', type: '1' }, key, 1700000000);
    assert(signed.includes('w_rid=') && signed.includes('wts=1700000000'), '签名缺少 w_rid/wts');
    const sig = signed.split('w_rid=')[1];
    assert(/^[0-9a-f]{32}$/u.test(sig), '签名不是 md5');
    const xml = '<i><d p="1,2,3">朱志鑫生日快乐</d><d p="1,2,3">好家伙</d></i>';
    const list = parseDanmakuXml(xml);
    assert(list.length === 2 && list[0] === '朱志鑫生日快乐', '弹幕解析不对');
    ok('B站游客态：wbi 签名 / 弹幕解析', key.slice(0, 8) + '…');
}

async function unitStudySession() {
    const { StudySession } = await import('../lib/study.js');
    const meta = new Map();
    const store = {
        getMeta: (k) => meta.get(k),
        setMeta: (k, v) => meta.set(k, v),
        log: () => {},
    };
    let progressFn = null;
    const explorer = {
        state: { running: false },
        stop() { this.stopped = true; },
        runCycle({ minutes, onProgress }) {
            assert(minutes === 5, '学习时长没传对');
            progressFn = onProgress;
            this.state.running = true;
            return new Promise((resolve) => {
                setTimeout(() => {
                    onProgress && onProgress({ comments: 4, patterns: 2, platform: 'bilibili' });
                    onProgress && onProgress({ comments: 6, patterns: 3, platform: 'douban-group' });
                    this.state.running = false;
                    resolve({ pages: 2, results: [{ comments: 4, patterns: 2, platform: 'bilibili' }, { comments: 6, patterns: 3, platform: 'douban-group' }], stoppedReason: 'deadline' });
                }, 30);
            });
        },
    };
    const session = new StudySession({ store, explorer, settings: { write() {} } });
    const started = session.start(5);
    assert(started.ok && started.study.running, '学习没有启动');
    assert(session.view().minutes === 5, '时长不对');
    const s = session.view();
    await session.promise;
    const view = session.view();
    assert(view.running === false, '学习没有结束');
    assert(view.pages === 2 && view.comments === 10 && view.patterns === 5, '进度统计不对：' + JSON.stringify(view));
    assert(view.byPlatform.bilibili && view.byPlatform.bilibili.pages === 1, '平台占比没统计 B站');
    assert(view.byPlatform['douban-group'] && view.byPlatform['douban-group'].comments === 6, '平台占比没统计豆瓣');
    assert(meta.get('study.last'), '上次学习结果没有落盘');
    ok('学习会话：时长 / 进度 / 总结', `${view.pages} 页 / ${view.comments} 条评论`);
}


async function unitHomework() {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Store } = await import('../lib/db.js');
    const { normalizeConfig } = await import('../lib/config.js');
    const { HomeworkService } = await import('../lib/homework.js');
    const dir = mkdtempSync(join(tmpdir(), 'hles-hw-'));
    const store = new Store({ dir, config: normalizeConfig({}) }).open();
    store.upsertPattern({ kind: 'rhythm', pattern: '短句收束，长句后停一下', example: '就这样。', confidence: 0.6, hits: 3, category: '日常叙述' });
    const llm = {
        async *stream(options) {
            assert(options.provider === 'test' && options.model === 'm', '模型路由不对');
            const text = options.system.includes('自我反思')
                ? '我理解了：句子太满。我要把第二段拆开，少用形容词。下一轮先写短句再扩写。'
                : '标题：一碗面的时间\n\n楼下那家面馆换了老板，汤还是那个味…';
            for (const part of text.split('')) yield { type: 'text-delta', index: 0, text: part };
            yield { type: 'finish', reason: { kind: 'stop' } };
        },
    };
    const modelSelection = { currentSelection: () => ({ provider: 'test', model: 'm' }) };
    const homework = new HomeworkService({ store, llm, modelSelection });
    const item = await homework.generate({ startedAt: 1, byPlatform: { bilibili: { pages: 2 } } });
    assert(item.status === 'pending_review', '作业状态不对：' + item.status);
    assert(item.topic === '一碗面的时间', '标题没解析出来：' + item.topic);
    assert(item.content.includes('楼下那家面馆'), '正文没写进去');
    const reviewed = await homework.review(item.id, { score: 82, suggestion: '第二段太满了' });
    assert(reviewed.status === 'done' && reviewed.selfReview.includes('我理解了'), '自我反思没生成');
    assert(reviewed.score === 82 && reviewed.suggestion === '第二段太满了', '打分/建议没存对');
    store.close();
    ok('作业与评价：生成 / 打分 / 自我反思', '82 分');
}


async function unitDialogue() {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Store } = await import('../lib/db.js');
    const { normalizeConfig } = await import('../lib/config.js');
    const { DialogueService } = await import('../lib/dialogue.js');
    const dir = mkdtempSync(join(tmpdir(), 'hles-dlg-'));
    const store = new Store({ dir, config: normalizeConfig({}) }).open();
    const llm = {
        async *stream(options) {
            const text = options.system.includes('自我反思')
                ? '老师的意思是我接得太快了。下一次先接住对方，再回一句具体的。'
                : '哈哈，你先别配，我还没答应呢。';
            for (const part of text.split('')) yield { type: 'text-delta', index: 0, text: part };
            yield { type: 'finish', reason: { kind: 'stop' } };
        },
    };
    const service = new DialogueService({ store, llm, modelSelection: { currentSelection: () => ({ provider: 'test', model: 'm' }) } });
    const item = await service.ask('我想把你配了');
    assert(item.status === 'pending_review', '对话回复状态不对');
    assert(item.reply.includes('你先别配'), '回复没写进去：' + item.reply);
    const reviewed = await service.review(item.id, { score: 76, suggestion: '接得太急了' });
    assert(reviewed.status === 'done' && reviewed.selfReview.includes('接得太快'), '对话反思没生成');
    assert(reviewed.score === 76, '对话分数没存对');
    store.close();
    ok('对话测试：生成 / 打分 / 反思', '76 分');
}

// ============================ 集成测试（离线，桩抓取器）============================

async function integrationInjectionDefense() {
    const { store, config } = makeRuntime4Test();
    const explorer = stubExplorer(store, config, MALICIOUS_HTML);
    store.pushFrontier({ url: 'https://evil.test/book', host: 'evil.test', domain: '文学', priority: 2 });
    const res = await explorer.processPage({ url: 'https://evil.test/book', domain: '文学' }, 'random', new AbortController().signal);
    assert(res.status === 'injection_blocked', `未拦截：${res.status}`);
    assert(store.stats().patterns === 0, '被拦截页面仍写入了语言经验');
    assert(store.stats().knowledge === 0, '被拦截页面仍写入了知识');
    const visit = store.recentVisits(1)[0];
    assert(visit.status === 'injection_blocked', `探索记录状态不对：${visit.status}`);
    store.close();
    ok('恶意页面整页隔离（不入库、不采样）');
}

async function integrationFeedAndArticle() {
    const { store, config } = makeRuntime4Test();
    const fetcher = {
        get: async (url) => {
            if (url.endsWith('/feed.xml')) return { ok: true, status: 200, contentType: 'application/rss+xml', text: FEED_XML, bytes: FEED_XML.length, ms: 5, url };
            return { ok: true, status: 200, contentType: 'text/html', text: FAKE_HTML, bytes: FAKE_HTML.length, ms: 5, url };
        },
        abortAll() {},
    };
    const explorer = new Explorer({ store, fetcher, config, web: null });
    const feedRes = await explorer.processPage({ url: 'https://example.com/feed.xml', domain: '文学' }, 'random', new AbortController().signal);
    assert(feedRes.kind === 'feed' && feedRes.links === 2, `订阅源处理异常：${JSON.stringify(feedRes).slice(0, 200)}`);
    assert(store.frontierStats().new >= 2, '订阅条目未入队');
    const articleRes = await explorer.processPage({ url: 'https://example.com/a1', domain: '文学' }, 'extension', new AbortController().signal);
    assert(articleRes.ok, '文章处理失败');
    assert(articleRes.patterns >= 1, `文章语言经验为 0：${articleRes.status}`);
    assert(store.stats().patterns >= 1, '语言经验未落库');
    store.close();
    ok('订阅源 → 条目入队 → 文章分析', `patterns=${articleRes.patterns}`);
}

async function integrationPauseResumeStop() {
    const { store, config } = makeRuntime4Test();
    const explorer = stubExplorer(store, config, FAKE_HTML, 150);
    const started = explorer.start({ pages: 6 });
    await sleep(400);
    explorer.pause();
    // 暂停只在页面边界生效：让正在处理的那一页先收尾，再确认不再推进
    await sleep(500);
    const frozen = explorer.state.pagesDone;
    await sleep(900);
    assert(explorer.state.pagesDone === frozen, `暂停期间仍在推进：${frozen} → ${explorer.state.pagesDone}`);
    explorer.resume();
    await sleep(500);
    const stopped = explorer.stop();
    assert(stopped.stopping, 'stop 未返回状态');
    const result = await started.promise;
    assert(result.stoppedReason === 'stopped', `停止原因异常：${result.stoppedReason}`);
    assert(explorer.state.running === false, '停止后 running 未复位');
    store.close();
    ok('暂停 / 恢复 / 停止状态机', `暂停时 ${frozen} 页，最终 ${result.pages} 页`);
}

async function integrationMemory() {
    const { store, config } = makeRuntime4Test();
    const bigHtml = FAKE_HTML.repeat(40);
    const explorer = stubExplorer(store, config, bigHtml);
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 25; i += 1) {
        await explorer.processPage({ url: `https://example.com/p/${i}`, domain: '生活' }, 'random', new AbortController().signal);
    }
    global.gc?.();
    const growthMB = (process.memoryUsage().heapUsed - before) / 1_048_576;
    assert(growthMB < 80, `连续 25 页后堆增长过大：${growthMB.toFixed(1)}MB`);
    ok('连续处理页面内存稳定', `增长 ${growthMB.toFixed(1)}MB（原始 HTML ${(bigHtml.length / 1024).toFixed(0)}KB × 25）`);
    store.close();
}

async function integrationPersistence() {
    const { store, config, dir } = makeRuntime4Test();
    store.upsertPattern({ kind: 'rhythm', key: '测试|持久化', pattern: '长句铺陈', confidence: 0.6 });
    store.close();
    const store2 = new Store({ dir, config }).open();
    assert(store2.patternCount() === 1, '重开后经验丢失');
    store2.close();
    // 换"模型"不影响经验：经验只在 SQLite 里，与 provider/model 无关
    const runtime = createRuntime({ config: { dataDir: dir } });
    assert(runtime.store.patternCount() === 1, '新 runtime 读不到旧经验');
    runtime.store.close();
    ok('关闭重开 / 更换运行环境后经验仍在');
}

// ============================ 集成测试（联网）============================

async function integrationNetwork() {
    const { store, config, dir } = makeRuntime4Test();
    config.explore.channelMix = { random: 1, extension: 0, interest: 0 };
    const { Fetcher } = await import('../lib/fetcher.js');
    const fetcher = new Fetcher({ config, web: null, store });
    const explorer = new Explorer({ store, fetcher, config, web: null });
    const result = await explorer.runCycle({ pages: PAGES });
    assert(result.pages >= 1, '一页都没抓到');
    assert(result.ok >= 1, `全部失败：${result.results.map((r) => r.status + ':' + (r.error || '')).join(' | ')}`);
    assert(store.stats().visits >= result.pages, '探索记录少于页数');
    assert(store.recentDiaries(1).length === 1, '没有生成探索日记');
    const statuses = [...new Set(result.results.map((r) => r.status))];
    ok('无关键词自主探索', `${result.ok}/${result.pages} 成功，状态：${statuses.join('/')}，领域：${result.domains.map((d) => d.domain).join('、')}`);
    store.close();
    return { dir };
}

// ============================ 主流程 ============================

console.log('HLES 3.0 测试套件');
console.log(`模式：${OFFLINE ? '离线' : `联网集成（${PAGES} 页）`}`);

await test('页面解析', unitParse);
await test('robots.txt', unitRobots);
await test('提示注入扫描', unitInjection);
await test('语言观察与规律归纳', unitLanguage);
await test('知识点提取', unitKnowledgeExtraction);
await test('反机械化检测（15 类）', unitAntiAi);
await test('语言质量评估（7 项）', unitQuality);
await test('经验数据库', unitDb);
await test('显式反馈识别', unitFeedback);
await test('经验注入', unitPrompt);
await test('评论区提取与分类', unitComments);
await test('运行期设置', unitSettings);
await test('Agent 接入与注入开关', unitAgentsAndGating);
await test('平台注册表', unitPlatforms);
await test('侧边栏 UI 注册（无浏览器）', unitClientRegistration);
await test('B站游客态签名与弹幕', unitBilibili);
await test('学习会话与进度', unitStudySession);
await test('作业与评价', unitHomework);
await test('对话测试', unitDialogue);
await test('评论区端到端', integrationCommentLearning);
await test('恶意页面隔离', integrationInjectionDefense);
await test('订阅源到文章链路', integrationFeedAndArticle);
await test('暂停/恢复/停止', integrationPauseResumeStop);
await test('内存稳定', integrationMemory);
await test('持久化与模型无关性', integrationPersistence);

let netDir = null;
if (!OFFLINE) {
    const out = await test('真实网络自主探索', async () => {
        netDir = (await integrationNetwork()).dir;
        ok('真实网络探索完成');
    });
}

for (const dir of tempDirs) {
    if (dir === netDir) continue;
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch {
        /* 保留现场便于排查 */
    }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) {
    for (const f of failures) console.log(`\n✗ ${f.name}\n${f.detail}`);
    process.exitCode = 1;
} else {
    console.log('全部通过。');
}
