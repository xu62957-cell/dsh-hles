/**
 * 侧边栏面板的 HTTP 接口（4.0 §9）。
 *
 * 每个按钮都接到真实实现：探索控制 → Explorer；设置 → Settings；Agent → AgentRegistry；
 * 数据管理 → Store；平台状态 → platforms.js。没有只做展示的假按钮。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { StudySession } from './study.js';
import { join } from 'node:path';

import { PLATFORMS, UNSUPPORTED, GROUP_LABEL } from './platforms.js';
import { SETTING_DEFAULTS } from './settings4.js';

const PREFIX = '/api/dsh-hles';

function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
    });
    res.end(body);
}

async function readJson(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        return null;
    }
}

export function registerPanelRoutes({ ctx, store, explorer, settings, agents, injector, version, config, study, homework = null, dialogue = null }) {
    const webServer = ctx.get?.('webServer') ?? ctx.webServer;
    if (!webServer) return { registered: false, reason: 'no-webServer' };
    const connection = ctx.get?.('connection');
    const disposers = [];
    // 与 DSH 页面同一套鉴权：没有浏览器 cookie 的进程拿不到面板数据
    const rejectUnauthenticated = (req, res) => {
        if (!connection?.requestRejection) return false;
        const rejection = connection.requestRejection(req);
        if (!rejection) return false;
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('dsh authentication required');
        return true;
    };

    const route = (path, handler) => {
        const definition = {
            kind: 'exact',
            path: `${PREFIX}${path}`,
            async handler(req, res) {
                try {
                    if (rejectUnauthenticated(req, res)) return;
                    const url = new URL(req.url ?? path, 'http://localhost');
                    await handler(req, res, url);
                } catch (error) {
                    sendJson(res, 500, { error: String(error?.message || error) });
                }
            },
        };
        disposers.push(webServer.register(definition));
    };

    // ---------- 总览 ----------
    route('/overview', async (req, res) => {
        const stats = store.stats();
        const groups = store.groupCounts();
        const mix = settings.mix();
        const total = Object.values(groups).reduce((a, b) => a + b, 0) || 1;
        sendJson(res, 200, {
            version,
            running: explorer.state.running,
            paused: explorer.state.paused,
            pagesDone: explorer.state.pagesDone,
            lastRunAt: Number(store.getMeta('last_learn_at') || 0),
            stats,
            discussions: store.discussionStats(),
            agents: agents.stats(),
            groups: Object.keys(GROUP_LABEL).map((g) => ({
                group: g, label: GROUP_LABEL[g], target: mix[g] ?? 0,
                actual: Math.round(((groups[g] || 0) / total) * 1000) / 10,
            })),
            schedule: settings.read().schedule,
            categories: store.patternCount() ? categoryCounts(store) : {},
        });
    });

    // ---------- 探索控制 ----------
    route('/control', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const body = (await readJson(req)) || {};
        const action = String(body.action || '');
        const pages = Number(body.pages) || settings.get('pagesPerCycle', 6);
        try {
            if (action === 'start') {
                const out = explorer.start({ pages });
                out.promise?.catch(() => {});
                store.setMeta('last_learn_at', String(Date.now()));
                return sendJson(res, 200, { ok: true, started: true, pages: out.pages });
            }
            if (action === 'pause') return sendJson(res, 200, { ok: true, status: explorer.pause() });
            if (action === 'resume') return sendJson(res, 200, { ok: true, status: explorer.resume() });
            if (action === 'stop') return sendJson(res, 200, { ok: true, ...explorer.stop() });
            if (action === 'explore' || action === 'random' || action === 'comments') {
                if (explorer.state.running) return sendJson(res, 409, { error: '已有探索在运行' });
                const result = await explorer.runCycle({
                    pages: Math.min(Number(pages) || 3, config.explore.maxPagesPerCycle),
                    mode: action === 'comments' ? 'comments' : action === 'random' ? 'random' : 'normal',
                });
                store.setMeta('last_learn_at', String(Date.now()));
                return sendJson(res, 200, {
                    ok: true, pages: result.pages, okCount: result.ok, stoppedReason: result.stoppedReason,
                    domains: result.domains, diary: result.diary,
                    results: result.results.map((r) => ({ url: r.url, title: r.title, status: r.status, domain: r.domain, patterns: r.patterns })),
                });
            }
            return sendJson(res, 400, { error: `未知操作：${action}` });
        } catch (error) {
            return sendJson(res, 500, { error: String(error?.message || error) });
        }
    });

    // ---------- 设置 ----------
    route('/settings', async (req, res) => {
        if (req.method === 'GET') return sendJson(res, 200, { settings: settings.read(), defaults: SETTING_DEFAULTS });
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const body = await readJson(req);
        if (!body || typeof body !== 'object') return sendJson(res, 400, { error: '请求格式无效' });
        const next = settings.write(body);
        store.log('info', '面板更新设置', JSON.stringify(body).slice(0, 200));
        return sendJson(res, 200, { ok: true, settings: next });
    });

    // ---------- Agent ----------
    route('/agents', async (req, res) => {
        if (req.method === 'GET') return sendJson(res, 200, { agents: agents.list(), stats: agents.stats(), global: agents.globalEnabled() });
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const body = (await readJson(req)) || {};
        if (body.action === 'toggle') {
            const enabled = agents.setEnabled(String(body.id), body.enabled !== false);
            return sendJson(res, 200, { ok: true, id: body.id, enabled, agents: agents.list(), stats: agents.stats() });
        }
        if (body.action === 'global') {
            settings.write({ inject: { global: body.enabled !== false } });
            return sendJson(res, 200, { ok: true, global: body.enabled !== false });
        }
        return sendJson(res, 400, { error: '未知操作' });
    });

    // ---------- 日记 / 讨论 ----------
    route('/diary', async (req, res) => {
        sendJson(res, 200, {
            diaries: store.recentDiaries(6),
            discussions: store.recentDiscussions(12),
            trends: store.termTrends(20),
        });
    });

    // ---------- 语言经验 ----------
    route('/patterns', async (req, res, url) => {
        const category = url.searchParams.get('category') || '';
        const limit = Math.min(100, Number(url.searchParams.get('limit')) || 30);
        const rows = store.allPatterns(500)
            .filter((p) => !category || p.category === category)
            .slice(0, limit);
        sendJson(res, 200, { patterns: rows, categories: categoryCounts(store), trends: store.termTrends(15) });
    });

    // ---------- 平台 ----------
    route('/platforms', async (req, res) => {
        sendJson(res, 200, { platforms: PLATFORMS, unsupported: UNSUPPORTED, groups: GROUP_LABEL });
    });

    // ---------- 数据管理 ----------
    route('/data', async (req, res) => {
        if (req.method === 'GET') return sendJson(res, 200, { stats: store.stats(), discussions: store.discussionStats() });
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const body = (await readJson(req)) || {};
        const action = String(body.action || '');
        try {
            if (action === 'export') {
                const dir = join(config.dataDir, 'exports');
                mkdirSync(dir, { recursive: true });
                const file = join(dir, `hles4-export-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
                writeFileSync(file, JSON.stringify(store.exportAll(), null, 2));
                return sendJson(res, 200, { ok: true, file });
            }
            if (action === 'backup') return sendJson(res, 200, { ok: true, file: store.backup() });
            if (action === 'prune') return sendJson(res, 200, { ok: true, ...store.prune() });
            if (action === 'vacuum') return sendJson(res, 200, { ok: true, ...store.vacuum() });
            if (action === 'delete') {
                const scope = String(body.scope || '');
                if (!scope) return sendJson(res, 400, { error: '缺少 scope' });
                return sendJson(res, 200, { ok: true, ...store.deleteScope(scope) });
            }
            if (action === 'rollback') return sendJson(res, 200, { ok: true, ...store.rollback(String(body.table || 'lang_pattern'), Number(body.id)) });
            if (action === 'rebuild') {
                const file = store.backup();
                store.deleteScope('language');
                store.deleteScope('knowledge');
                store.deleteScope('discussions');
                store.prune();
                store.vacuum();
                return sendJson(res, 200, { ok: true, backup: file, stats: store.stats() });
            }
            return sendJson(res, 400, { error: `未知操作：${action}` });
        } catch (error) {
            return sendJson(res, 500, { error: String(error?.message || error) });
        }
    });

    // ---------- 页内自检 ----------
    route('/diag', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const body = (await readJson(req)) || {};
        const payload = {
            at: Number(body.at) || Date.now(),
            slots: Array.isArray(body.slots) ? body.slots.slice(0, 12) : [],
            ua: String(body.ua || '').slice(0, 160),
            path: String(body.path || '').slice(0, 120),
            endpoints: Array.isArray(body.endpoints) ? body.endpoints.slice(0, 16).map((e) => ({ path: String(e?.path || '').slice(0, 40), status: Number(e?.status) || 0 })) : [],
        };
        store.setMeta('client_diag', JSON.stringify(payload));
        store.log('info', '客户端面板已在页面中加载', payload.ua.slice(0, 80));
        return sendJson(res, 200, { ok: true, version });
    });

    // ---------- 学习一次（自定义时长 + 进度） ----------
    route('/learn', async (req, res) => {
        if (req.method === 'GET') return sendJson(res, 200, { study: study.view() });
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const body = (await readJson(req)) || {};
        if (body.action === 'stop') return sendJson(res, 200, study.stop());
        if (explorer.state.running || study.view().running) {
            return sendJson(res, 409, { error: '已有探索在运行，先停止再来' });
        }
        const started = study.start(body.minutes ?? settings.get('studyMinutes', 10));
        if (!started.ok) return sendJson(res, 409, { error: started.error });
        return sendJson(res, 200, started);
    });

    // ---------- 作业与评价 ----------
    route('/homework', async (req, res) => {
        if (req.method === 'GET') {
            if (homework) await homework.ensureBase?.();
            return sendJson(res, 200, {
                latest: homework ? homework.latest() : null,
                list: homework ? homework.list(10) : [],
                available: homework ? homework.available : false,
                base: homework ? homework.baseActive : false,
            });
        }
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        if (!homework) return sendJson(res, 503, { error: '作业模块未初始化' });
        const body = (await readJson(req)) || {};
        try {
            if (body.action === 'generate') {
                const item = await homework.generate(study ? study.view() : null);
                return sendJson(res, 200, { ok: true, homework: item });
            }
            if (body.action === 'review') {
                const item = await homework.review(Number(body.id), { score: body.score, suggestion: body.suggestion });
                return sendJson(res, 200, { ok: true, homework: item });
            }
            return sendJson(res, 400, { error: '未知操作' });
        } catch (error) {
            return sendJson(res, 500, { error: String(error?.message || error) });
        }
    });

    // ---------- 对话测试 ----------
    route('/dialogue', async (req, res) => {
        if (req.method === 'GET') {
            if (dialogue) await dialogue.ensureBase?.();
            return sendJson(res, 200, {
                latest: dialogue ? dialogue.latest() : null,
                list: dialogue ? dialogue.list(10) : [],
                available: dialogue ? dialogue.available : false,
                base: dialogue ? dialogue.baseActive : false,
            });
        }
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        if (!dialogue) return sendJson(res, 503, { error: '对话测试模块未初始化' });
        const body = (await readJson(req)) || {};
        try {
            if (body.action === 'ask') {
                const item = await dialogue.ask(String(body.prompt || ''), { homeworkId: Number(body.homeworkId) || 0 });
                return sendJson(res, 200, { ok: true, dialogue: item });
            }
            if (body.action === 'review') {
                const item = await dialogue.review(Number(body.id), { score: body.score, suggestion: body.suggestion });
                return sendJson(res, 200, { ok: true, dialogue: item });
            }
            return sendJson(res, 400, { error: '未知操作' });
        } catch (error) {
            return sendJson(res, 500, { error: String(error?.message || error) });
        }
    });

    // ---------- 注入预览 ----------
    route('/preview', async (req, res, url) => {
        const sessionId = url.searchParams.get('session') || '';
        sendJson(res, 200, injector.preview({ sessionId }));
    });

    return {
        registered: true,
        dispose: () => {
            for (const dispose of disposers) {
                try {
                    dispose();
                } catch {
                    /* 已卸载 */
                }
            }
        },
    };
}

function categoryCounts(store) {
    const out = {};
    for (const p of store.allPatterns(1000)) out[p.category || '通用'] = (out[p.category || '通用'] || 0) + 1;
    return out;
}
