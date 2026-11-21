/**
 * HLES 长期经验库（node:sqlite，零外部依赖）。
 *
 * 五类数据严格分表，避免把"用户偏好"混进"通用语言规律"：
 *   visits      互联网探索记录
 *   frontier    待访问链接队列
 *   knowledge   知识经验（带 verification 状态与来源）
 *   lang_pattern 语言经验（句式/词汇/交流/情绪规律）
 *   user_pref   用户语言偏好（与通用规律分开）
 *   evals       自我评估记录
 *   interests   阶段性兴趣（可衰减）
 *   diary       探索日记
 *   logs        运行日志
 */

import { mkdirSync, existsSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { sha1, jaccard, statementSimilarity, normalizeSpace, truncate, dayKey, round } from './util.js';

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  canonical TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  site TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '未分类',
  lang TEXT NOT NULL DEFAULT 'zh',
  channel TEXT NOT NULL DEFAULT 'random',
  status TEXT NOT NULL DEFAULT 'ok',
  http_status INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  text_len INTEGER NOT NULL DEFAULT 0,
  links INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_visits_time ON visits(fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_visits_canonical ON visits(canonical);
CREATE INDEX IF NOT EXISTS idx_visits_domain ON visits(domain, fetched_at DESC);
CREATE TABLE IF NOT EXISTS frontier (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '未分类',
  priority REAL NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  added_at INTEGER NOT NULL,
  tried_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_frontier_status ON frontier(status, priority DESC);
CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  statement TEXT NOT NULL,
  norm TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '未分类',
  source_url TEXT NOT NULL DEFAULT '',
  site TEXT NOT NULL DEFAULT '',
  sources INTEGER NOT NULL DEFAULT 1,
  confidence REAL NOT NULL DEFAULT 0.4,
  status TEXT NOT NULL DEFAULT 'unverified',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_status ON knowledge(status, updated_at DESC);
CREATE TABLE IF NOT EXISTS lang_pattern (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  pattern TEXT NOT NULL,
  example TEXT NOT NULL DEFAULT '',
  register TEXT NOT NULL DEFAULT '通用',
  lang TEXT NOT NULL DEFAULT 'zh',
  domain TEXT NOT NULL DEFAULT '未分类',
  source_url TEXT NOT NULL DEFAULT '',
  site TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.4,
  hits INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  UNIQUE(kind, key)
);
CREATE INDEX IF NOT EXISTS idx_pattern_seen ON lang_pattern(last_seen DESC);
CREATE TABLE IF NOT EXISTS pattern_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_id INTEGER NOT NULL,
  before_json TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_pattern ON pattern_history(pattern_id, at DESC);
CREATE TABLE IF NOT EXISTS user_pref (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'session',
  session_id TEXT NOT NULL DEFAULT '',
  agent_preset TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'dislike',
  subject TEXT NOT NULL,
  norm TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.5,
  hits INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(scope, session_id, kind, norm)
);
CREATE INDEX IF NOT EXISTS idx_pref_active ON user_pref(active, updated_at DESC);
CREATE TABLE IF NOT EXISTS evals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL DEFAULT '',
  turn INTEGER NOT NULL DEFAULT 0,
  natural REAL,
  fluency REAL,
  diversity REAL,
  context_fit REAL,
  coherence REAL,
  mechanization REAL,
  accuracy REAL,
  ai_hits TEXT NOT NULL DEFAULT '[]',
  sample TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evals_time ON evals(created_at DESC);
CREATE TABLE IF NOT EXISTS interests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  norm TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL DEFAULT '未分类',
  weight REAL NOT NULL DEFAULT 0.5,
  state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  last_touched INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interest_weight ON interests(weight DESC);
CREATE TABLE IF NOT EXISTS diary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id TEXT NOT NULL DEFAULT '',
  visited INTEGER NOT NULL DEFAULT 0,
  domains TEXT NOT NULL DEFAULT '[]',
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diary_time ON diary(created_at DESC);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(created_at DESC);
CREATE TABLE IF NOT EXISTS discussions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '未分类',
  group_name TEXT NOT NULL DEFAULT 'other',
  total_hint INTEGER NOT NULL DEFAULT 0,
  sampled INTEGER NOT NULL DEFAULT 0,
  features TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discussions_time ON discussions(created_at DESC);
CREATE TABLE IF NOT EXISTS term_trend (
  term TEXT PRIMARY KEY,
  category TEXT NOT NULL DEFAULT '口语',
  platform TEXT NOT NULL DEFAULT '',
  hits INTEGER NOT NULL DEFAULT 1,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  preset TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  sessions INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  host TEXT PRIMARY KEY,
  ok INTEGER NOT NULL DEFAULT 0,
  fail INTEGER NOT NULL DEFAULT 0,
  last_ok INTEGER NOT NULL DEFAULT 0,
  last_fail INTEGER NOT NULL DEFAULT 0,
  avg_ms INTEGER NOT NULL DEFAULT 0
);
`;

const TABLES = ['visits', 'frontier', 'knowledge', 'lang_pattern', 'user_pref', 'evals', 'interests', 'diary', 'logs', 'discussions', 'term_trend', 'agents'];

/** 规律类型 → 4.0 经验库分类。 */
export const CATEGORY_OF = {
    particle: '中文口语',
    rhythm: '日常叙述',
    connective: '对话接续',
    dialogue: '对话接续',
    emotion: '情绪表达',
    slang: '网络流行语',
    forum: '对话接续',
    rhetoric: '幽默表达',
    punctuation: '日常叙述',
    explain: '知识讲解',
    register: '日常叙述',
    opening: '日常叙述',
    address: '对话接续',
    humor: '幽默表达',
    debate: '争论反驳',
    meme: '网络玩梗',
};

export class Store {
    constructor({ dir, config }) {
        this.dir = dir;
        this.config = config;
        this.db = null;
        this.file = join(dir, 'hles.db');
    }

    open() {
        mkdirSync(this.dir, { recursive: true });
        mkdirSync(join(this.dir, 'diary'), { recursive: true });
        mkdirSync(join(this.dir, 'backups'), { recursive: true });
        this.db = new DatabaseSync(this.file);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = NORMAL');
        this.db.exec('PRAGMA busy_timeout = 3000');
        this.db.exec('PRAGMA journal_size_limit = 8388608');
        this.db.exec(SCHEMA);
        this.migrate4();
        this.migrate5();
        this.migrate6();
        const version = this.getMeta('schema_version');
        this.setMeta('schema_version', String(SCHEMA_VERSION));
        if (!version) {
            this.setMeta('created_at', String(Date.now()));
            this.log('info', 'HLES 数据库初始化完成', this.file);
        }
        return this;
    }

    close() {
        if (this.db) {
            try {
                this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            } catch {
                /* 关闭时 checkpoint 失败不影响数据 */
            }
            this.db.close();
            this.db = null;
        }
    }

    require() {
        if (!this.db) throw new Error('HLES 数据库未打开');
        return this.db;
    }

    getMeta(key) {
        const row = this.require().prepare('SELECT value FROM meta WHERE key = ?').get(key);
        return row?.value ?? null;
    }

    setMeta(key, value) {
        this.require().prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
    }

    /** 一个写事务；回调抛错则回滚。 */
    tx(fn) {
        const db = this.require();
        db.exec('BEGIN');
        try {
            const out = fn();
            db.exec('COMMIT');
            return out;
        } catch (error) {
            try {
                db.exec('ROLLBACK');
            } catch {
                /* 忽略回滚失败 */
            }
            throw error;
        }
    }

    // ---------- 探索记录 ----------

    addVisit(v) {
        const now = v.fetchedAt ?? Date.now();
        const info = this.require().prepare(`INSERT INTO visits
            (url, canonical, title, site, domain, lang, channel, status, http_status, bytes, text_len, links, ms, summary, error, fetched_at, group_name, platform)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            String(v.url).slice(0, 2000),
            String(v.canonical ?? v.url).slice(0, 2000),
            truncate(v.title ?? '', 300),
            truncate(v.site ?? '', 120),
            truncate(v.domain ?? '未分类', 40),
            v.lang === 'en' ? 'en' : 'zh',
            truncate(v.channel ?? 'random', 20),
            truncate(v.status ?? 'ok', 30),
            Math.round(v.httpStatus ?? 0),
            Math.round(v.bytes ?? 0),
            Math.round(v.textLen ?? 0),
            Math.round(v.links ?? 0),
            Math.round(v.ms ?? 0),
            truncate(v.summary ?? '', 600),
            truncate(v.error ?? '', 300),
            now,
            truncate(v.group ?? 'other', 20),
            truncate(v.platform ?? '', 40),
        );
        return Number(info.lastInsertRowid);
    }

    lastVisitAt(canonical) {
        const row = this.require().prepare('SELECT MAX(fetched_at) AS ts FROM visits WHERE canonical = ?').get(canonical);
        return Number(row?.ts ?? 0);
    }

    visitsSince(ts) {
        return this.require().prepare('SELECT id, url, canonical, title, domain, status, text_len, fetched_at FROM visits WHERE fetched_at >= ? ORDER BY fetched_at DESC').all(ts);
    }

    visitsTodayCount() {
        const start = Date.now() - 24 * 3600 * 1000;
        const row = this.require().prepare('SELECT COUNT(*) AS n FROM visits WHERE fetched_at >= ?').get(start);
        return Number(row?.n ?? 0);
    }

    domainCounts(limit = 40) {
        return this.require().prepare(`SELECT domain, COUNT(*) AS n, MAX(fetched_at) AS last
            FROM visits GROUP BY domain ORDER BY n DESC LIMIT ?`).all(limit)
            .map((r) => ({ domain: r.domain, n: Number(r.n), last: Number(r.last) }));
    }

    recentVisits(limit = 20) {
        return this.require().prepare(`SELECT id, url, title, site, domain, lang, status, http_status, text_len, channel, fetched_at, group_name, platform
            FROM visits ORDER BY fetched_at DESC LIMIT ?`).all(limit)
            .map((r) => ({ ...r, fetched_at: Number(r.fetched_at), http_status: Number(r.http_status), text_len: Number(r.text_len), group: r.group_name }));
    }

    /** 4.0：按内容分组统计实际探索比例。 */
    groupCounts() {
        const rows = this.require().prepare('SELECT group_name, COUNT(*) AS n FROM visits GROUP BY group_name').all();
        const out = { video: 0, forum: 0, blog: 0, other: 0 };
        for (const r of rows) {
            if (r.group_name in out) out[r.group_name] = Number(r.n);
        }
        return out;
    }

    /** 每个站点的平均正文长度：用来识别"抓得到但读不出内容"的站点。 */
    hostStats() {
        const rows = this.require().prepare("SELECT site AS host, COUNT(*) AS n, AVG(text_len) AS avg_len FROM visits WHERE status = 'ok' AND site != '' GROUP BY site").all();
        const map = new Map();
        for (const r of rows) map.set(r.host, { n: Number(r.n), avgLen: Math.round(Number(r.avg_len) || 0) });
        return map;
    }

    recentDomainSequence(n = 12) {
        return this.require().prepare('SELECT domain, canonical, channel FROM visits ORDER BY fetched_at DESC LIMIT ?').all(n)
            .map((r) => ({ domain: r.domain, canonical: r.canonical, channel: r.channel }));
    }

    // ---------- 对话测试 ----------
    addDialogue({ homeworkId = 0, prompt = '', status = 'answering' }) {
        const info = this.db.prepare(
            'INSERT INTO dialogue_test (homework_id, prompt, status, created_at) VALUES (?, ?, ?, ?)',
        ).run(Number(homeworkId) || 0, String(prompt), String(status), Date.now());
        return Number(info.lastInsertRowid);
    }
    updateDialogue(id, patch = {}) {
        const allowed = ['reply', 'status', 'score', 'suggestion', 'self_review', 'error'];
        const sets = [];
        const values = [];
        for (const key of allowed) {
            if (patch[key] === undefined) continue;
            sets.push(`${key} = ?`);
            values.push(patch[key]);
        }
        if (patch.reviewed_at !== undefined) {
            sets.push('reviewed_at = ?');
            values.push(Number(patch.reviewed_at) || 0);
        }
        if (!sets.length) return false;
        values.push(Number(id));
        this.db.prepare(`UPDATE dialogue_test SET ${sets.join(', ')} WHERE id = ?`).run(...values);
        return true;
    }
    getDialogue(id) {
        const row = this.db.prepare('SELECT * FROM dialogue_test WHERE id = ?').get(Number(id));
        return row ? this.mapDialogue(row) : null;
    }
    latestDialogue() {
        const row = this.db.prepare('SELECT * FROM dialogue_test ORDER BY id DESC LIMIT 1').get();
        return row ? this.mapDialogue(row) : null;
    }
    listDialogue(limit = 10) {
        return this.db.prepare('SELECT * FROM dialogue_test ORDER BY id DESC LIMIT ?').all(Math.max(1, Number(limit) || 10)).map((r) => this.mapDialogue(r));
    }
    mapDialogue(row) {
        return {
            id: Number(row.id),
            homeworkId: Number(row.homework_id) || 0,
            prompt: row.prompt,
            reply: row.reply,
            status: row.status,
            score: row.score === null || row.score === undefined ? null : Number(row.score),
            suggestion: row.suggestion,
            selfReview: row.self_review,
            error: row.error,
            createdAt: Number(row.created_at),
            reviewedAt: Number(row.reviewed_at) || 0,
        };
    }

    // ---------- 作业 ----------
    addHomework({ studyId = '', topic = '', content = '', status = 'pending_review', platforms = {} }) {
        const info = this.db.prepare(
            'INSERT INTO homework (study_id, topic, content, status, platforms, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(String(studyId), String(topic), String(content), String(status), JSON.stringify(platforms || {}), Date.now());
        return Number(info.lastInsertRowid);
    }
    updateHomework(id, patch = {}) {
        const allowed = ['topic', 'content', 'status', 'score', 'suggestion', 'self_review', 'error', 'platforms'];
        const sets = [];
        const values = [];
        for (const key of allowed) {
            if (patch[key] === undefined) continue;
            sets.push(`${key} = ?`);
            values.push(key === 'platforms' ? JSON.stringify(patch[key] || {}) : patch[key]);
        }
        if (patch.reviewed_at !== undefined) {
            sets.push('reviewed_at = ?');
            values.push(Number(patch.reviewed_at) || 0);
        }
        if (!sets.length) return false;
        values.push(Number(id));
        this.db.prepare(`UPDATE homework SET ${sets.join(', ')} WHERE id = ?`).run(...values);
        return true;
    }
    getHomework(id) {
        const row = this.db.prepare('SELECT * FROM homework WHERE id = ?').get(Number(id));
        return row ? this.mapHomework(row) : null;
    }
    latestHomework() {
        const row = this.db.prepare('SELECT * FROM homework ORDER BY id DESC LIMIT 1').get();
        return row ? this.mapHomework(row) : null;
    }
    listHomework(limit = 10) {
        return this.db.prepare('SELECT * FROM homework ORDER BY id DESC LIMIT ?').all(Math.max(1, Number(limit) || 10)).map((r) => this.mapHomework(r));
    }
    mapHomework(row) {
        let platforms = {};
        try { platforms = JSON.parse(row.platforms || '{}'); } catch { platforms = {}; }
        return {
            id: Number(row.id),
            studyId: row.study_id,
            topic: row.topic,
            content: row.content,
            status: row.status,
            score: row.score === null || row.score === undefined ? null : Number(row.score),
            suggestion: row.suggestion,
            selfReview: row.self_review,
            error: row.error,
            platforms,
            createdAt: Number(row.created_at),
            reviewedAt: Number(row.reviewed_at) || 0,
        };
    }

    // ---------- 查询 ----------

    pushFrontier({ url, host, domain, priority = 1, source = '', group = 'other', platform = '' }) {
        const info = this.require().prepare(`INSERT INTO frontier(url, host, domain, priority, source, added_at, group_name, platform)
            VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET priority = MAX(priority, excluded.priority)`).run(
            String(url).slice(0, 2000),
            truncate(host ?? '', 120),
            truncate(domain ?? '未分类', 40),
            Math.max(0.05, Math.min(3, Number(priority) || 1)),
            truncate(source ?? '', 200),
            Date.now(),
            truncate(group ?? 'other', 20),
            truncate(platform ?? '', 40),
        );
        return Number(info.changes) > 0;
    }

    pushFrontierBatch(items) {
        if (!items.length) return 0;
        let added = 0;
        this.tx(() => {
            for (const item of items) if (this.pushFrontier(item)) added += 1;
        });
        return added;
    }

    frontierCandidates(limit = 60) {
        return this.require().prepare(`SELECT id, url, host, domain, priority, source, group_name, platform FROM frontier
            WHERE status = 'new' ORDER BY priority DESC, added_at ASC LIMIT ?`).all(limit)
            .map((r) => ({ ...r, priority: Number(r.priority), group: r.group_name, platform: r.platform }));
    }

    markFrontier(url, status) {
        this.require().prepare('UPDATE frontier SET status = ?, tried_at = ? WHERE url = ?').run(status, Date.now(), url);
    }

    frontierStats() {
        const rows = this.require().prepare('SELECT status, COUNT(*) AS n FROM frontier GROUP BY status').all();
        const out = { new: 0, done: 0, failed: 0, skipped: 0 };
        for (const r of rows) out[r.status] = Number(r.n);
        return out;
    }

    // ---------- 知识 ----------

    addKnowledge({ statement, topic, domain, sourceUrl, site, confidence = 0.4 }) {
        const clean = normalizeSpace(statement);
        if (clean.length < 8) return { id: 0, isNew: false, verified: false };
        const norm = sha1(clean.toLowerCase(), 20);
        const db = this.require();
        const existing = db.prepare('SELECT * FROM knowledge WHERE norm = ?').get(norm);
        const now = Date.now();
        if (!existing) {
            // 近似陈述（另站同一事实的改写）：相似度 ≥0.82 视为同一知识点
            const rows = db.prepare('SELECT * FROM knowledge ORDER BY updated_at DESC LIMIT 400').all();
            for (const row of rows) {
                if (String(row.site) === String(site ?? '')) continue;
                if (statementSimilarity(clean, row.statement) < 0.72) continue;
                db.prepare('UPDATE knowledge SET sources = sources + 1, confidence = MIN(0.9, confidence + 0.2), status = ?, updated_at = ? WHERE id = ?')
                    .run('verified', now, Number(row.id));
                return { id: Number(row.id), isNew: false, verified: true };
            }
            const info = db.prepare(`INSERT INTO knowledge(statement, norm, topic, domain, source_url, site, sources, confidence, status, created_at, updated_at)
                VALUES(?,?,?,?,?,?,1,?,'unverified',?,?)`).run(
                truncate(clean, 500), norm, truncate(topic ?? '', 80), truncate(domain ?? '未分类', 40),
                truncate(sourceUrl ?? '', 500), truncate(site ?? '', 120), Math.min(0.6, Math.max(0.2, confidence)), now, now,
            );
            return { id: Number(info.lastInsertRowid), isNew: true, verified: false };
        }
        const sameHost = String(existing.site) === String(site ?? '');
        const sources = Number(existing.sources) + 1;
        const verified = !sameHost && sources >= 2 ? true : existing.status === 'verified';
        db.prepare('UPDATE knowledge SET sources = ?, confidence = ?, status = ?, updated_at = ? WHERE id = ?').run(
            sources,
            Math.min(0.9, Number(existing.confidence) + (sameHost ? 0.02 : 0.2)),
            verified ? 'verified' : existing.status,
            now,
            Number(existing.id),
        );
        return { id: Number(existing.id), isNew: false, verified };
    }

    searchKnowledge(query, limit = 10) {
        const rows = this.require().prepare('SELECT * FROM knowledge ORDER BY updated_at DESC LIMIT 800').all();
        if (!query) return rows.slice(0, limit).map(mapKnowledge);
        return rows
            .map((r) => ({ row: r, score: Math.max(jaccard(query, `${r.statement} ${r.topic}`), statementSimilarity(query, r.statement)) }))
            .filter((x) => x.score > 0.02)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map((x) => ({ ...mapKnowledge(x.row), score: round(x.score, 3) }));
    }

    unverifiedKnowledge(limit = 10) {
        return this.require().prepare("SELECT * FROM knowledge WHERE status = 'unverified' ORDER BY confidence DESC, updated_at DESC LIMIT ?").all(limit).map(mapKnowledge);
    }

    // ---------- 语言经验 ----------

    upsertPattern(p) {
        const db = this.require();
        const now = Date.now();
        const key = truncate(normalizeSpace(p.key), 120);
        const existing = db.prepare('SELECT * FROM lang_pattern WHERE kind = ? AND key = ?').get(p.kind, key);
        if (!existing) {
            const info = db.prepare(`INSERT INTO lang_pattern
                (kind, key, pattern, example, register, lang, domain, source_url, site, confidence, hits, created_at, last_seen, category, first_seen)
                VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`).run(
                truncate(p.kind, 40), key, truncate(p.pattern, 400), truncate(p.example ?? '', 160),
                truncate(p.register ?? '通用', 20), p.lang === 'en' ? 'en' : 'zh',
                truncate(p.domain ?? '未分类', 40), truncate(p.sourceUrl ?? '', 500), truncate(p.site ?? '', 120),
                Math.min(1, Math.max(0.2, Number(p.confidence) || 0.4)), now, now,
                truncate(p.category ?? CATEGORY_OF[p.kind] ?? '通用', 20), now,
            );
            return { id: Number(info.lastInsertRowid), isNew: true };
        }
        const before = JSON.stringify(existing);
        db.prepare('INSERT INTO pattern_history(pattern_id, before_json, at) VALUES(?,?,?)').run(Number(existing.id), before, now);
        const confidence = Math.max(Number(existing.confidence), Math.min(1, Number(p.confidence) || 0));
        const better = Number(p.confidence) > Number(existing.confidence);
        db.prepare(`UPDATE lang_pattern SET hits = hits + 1, confidence = ?, pattern = ?, example = CASE WHEN ? THEN ? ELSE example END,
            last_seen = ?, source_url = CASE WHEN ? THEN ? ELSE source_url END WHERE id = ?`).run(
            confidence,
            better ? truncate(p.pattern, 400) : existing.pattern,
            better ? 1 : 0,
            truncate(p.example ?? '', 160),
            now,
            better ? 1 : 0,
            truncate(p.sourceUrl ?? '', 500),
            Number(existing.id),
        );
        return { id: Number(existing.id), isNew: false };
    }

    allPatterns(limit = 400) {
        return this.require().prepare('SELECT * FROM lang_pattern ORDER BY last_seen DESC LIMIT ?').all(limit).map(mapPattern);
    }

    topPatterns({ limit = 6, minConfidence = 0.45, minHits = 1, kinds = null } = {}) {
        const rows = this.allPatterns(600);
        const now = Date.now();
        const scored = rows
            .filter((r) => r.confidence >= minConfidence && r.hits >= minHits)
            .filter((r) => !kinds || kinds.includes(r.kind))
            .map((r) => {
                const days = Math.max(0, (now - r.last_seen) / 86_400_000);
                const recency = Math.exp(-days / 45);
                const repeats = Math.min(1, Math.log10(1 + r.hits) / 1.2);
                return { ...r, score: round(r.confidence * (0.35 + 0.35 * recency + 0.3 * repeats), 4) };
            })
            .sort((a, b) => b.score - a.score);
        return scored.slice(0, limit);
    }

    patternKinds() {
        return this.require().prepare('SELECT kind, COUNT(*) AS n FROM lang_pattern GROUP BY kind ORDER BY n DESC').all()
            .map((r) => ({ kind: r.kind, n: Number(r.n) }));
    }

    patternCount() {
        const row = this.require().prepare('SELECT COUNT(*) AS n FROM lang_pattern').get();
        return Number(row?.n ?? 0);
    }

    // ---------- 用户偏好 ----------

    addPref({ scope = 'session', sessionId = '', agentPreset = '', kind = 'dislike', subject, evidence = '', confidence = 0.55 }) {
        const clean = truncate(normalizeSpace(subject), 200);
        if (!clean) return { id: 0, isNew: false };
        const norm = sha1(clean.toLowerCase(), 18);
        const db = this.require();
        const now = Date.now();
        const existing = db.prepare('SELECT * FROM user_pref WHERE scope = ? AND session_id = ? AND kind = ? AND norm = ?')
            .get(scope, sessionId, kind, norm);
        if (!existing) {
            const info = db.prepare(`INSERT INTO user_pref(scope, session_id, agent_preset, kind, subject, norm, evidence, confidence, hits, active, created_at, updated_at)
                VALUES(?,?,?,?,?,?,?,?,1,1,?,?)`).run(
                scope, sessionId, agentPreset, kind, clean, norm, truncate(evidence, 300),
                Math.min(0.9, confidence), now, now,
            );
            return { id: Number(info.lastInsertRowid), isNew: true };
        }
        db.prepare('UPDATE user_pref SET hits = hits + 1, confidence = MIN(0.95, confidence + 0.1), evidence = ?, active = 1, updated_at = ? WHERE id = ?')
            .run(truncate(evidence, 300), now, Number(existing.id));
        return { id: Number(existing.id), isNew: false };
    }

    activePrefs({ sessionId = '', limit = 3 } = {}) {
        const rows = this.require().prepare(`SELECT * FROM user_pref WHERE active = 1 AND (scope = 'global' OR session_id = ?)
            ORDER BY confidence DESC, updated_at DESC LIMIT ?`).all(sessionId, limit);
        return rows.map(mapPref);
    }

    allPrefs(limit = 50) {
        return this.require().prepare('SELECT * FROM user_pref ORDER BY updated_at DESC LIMIT ?').all(limit).map(mapPref);
    }

    // ---------- 自我评估 ----------

    addEval(e) {
        const info = this.require().prepare(`INSERT INTO evals(session_id, turn, natural, fluency, diversity, context_fit, coherence, mechanization, accuracy, ai_hits, sample, notes, created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            truncate(e.sessionId ?? '', 80), Math.round(e.turn ?? 0),
            nullable(e.natural), nullable(e.fluency), nullable(e.diversity), nullable(e.contextFit),
            nullable(e.coherence), nullable(e.mechanization), nullable(e.accuracy),
            JSON.stringify(e.aiHits ?? []), truncate(e.sample ?? '', 400), truncate(e.notes ?? '', 300), Date.now(),
        );
        return Number(info.lastInsertRowid);
    }

    evalTrend(days = 7) {
        const since = Date.now() - days * 86_400_000;
        const rows = this.require().prepare('SELECT * FROM evals WHERE created_at >= ? ORDER BY created_at ASC, id ASC').all(since);
        const cols = ['natural', 'fluency', 'diversity', 'context_fit', 'coherence', 'mechanization', 'accuracy'];
        const out = { n: rows.length, days };
        for (const c of cols) {
            const vals = rows.map((r) => r[c]).filter((v) => typeof v === 'number');
            out[c] = vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length, 1) : null;
        }
        if (rows.length >= 4) {
            const half = Math.floor(rows.length / 2);
            const early = rows.slice(0, half);
            const late = rows.slice(half);
            out.trend = round(avgOf(late, 'natural') - avgOf(early, 'natural'), 1);
        }
        return out;
    }

    recentEvals(limit = 10) {
        return this.require().prepare('SELECT * FROM evals ORDER BY created_at DESC LIMIT ?').all(limit).map((r) => ({
            id: Number(r.id), session: r.session_id, natural: r.natural, fluency: r.fluency,
            diversity: r.diversity, mechanization: r.mechanization, hits: safeJson(r.ai_hits, []),
            sample: r.sample, at: Number(r.created_at),
        }));
    }

    // ---------- 兴趣 ----------

    touchInterest({ topic, domain = '未分类', delta = 0.3 }) {
        const clean = truncate(normalizeSpace(topic), 80);
        if (clean.length < 2) return null;
        const norm = sha1(clean.toLowerCase(), 16);
        const db = this.require();
        const now = Date.now();
        const existing = db.prepare('SELECT * FROM interests WHERE norm = ?').get(norm);
        if (existing) {
            db.prepare('UPDATE interests SET weight = MIN(3, weight + ?), last_touched = ?, state = ?, domain = ? WHERE id = ?').run(
                delta, now, 'active', truncate(domain, 40), Number(existing.id),
            );
            return { id: Number(existing.id), topic: existing.topic, weight: Math.min(3, Number(existing.weight) + delta) };
        }
        const info = db.prepare('INSERT INTO interests(topic, norm, domain, weight, state, created_at, last_touched) VALUES(?,?,?,?,?,?,?)')
            .run(clean, norm, truncate(domain, 40), Math.max(0.2, delta), 'active', now, now);
        return { id: Number(info.lastInsertRowid), topic: clean, weight: Math.max(0.2, delta) };
    }

    decayInterests(factor = 0.88) {
        this.require().prepare("UPDATE interests SET weight = weight * ? WHERE state = 'active'").run(factor);
        this.require().prepare("UPDATE interests SET state = 'dormant' WHERE weight < 0.15 AND state = 'active'").run();
    }

    topInterests(limit = 5) {
        return this.require().prepare("SELECT * FROM interests WHERE state = 'active' ORDER BY weight DESC, last_touched DESC LIMIT ?").all(limit)
            .map((r) => ({ id: Number(r.id), topic: r.topic, domain: r.domain, weight: round(Number(r.weight), 2), lastTouched: Number(r.last_touched) }));
    }

    // ---------- 日记 ----------

    addDiary({ cycleId, visited = 0, domains = [], body }) {
        const now = Date.now();
        const info = this.require().prepare('INSERT INTO diary(cycle_id, visited, domains, body, created_at) VALUES(?,?,?,?,?)')
            .run(truncate(cycleId, 80), Math.round(visited), JSON.stringify(domains), String(body), now);
        try {
            const file = join(this.dir, 'diary', `${dayKey(now)}.md`);
            if (!existsSync(file)) writeFileSync(file, `# HLES 探索日记 ${dayKey(now)}\n\n`);
            appendFileSync(file, `${String(body).trim()}\n\n---\n\n`);
        } catch {
            /* 文件写入失败不影响数据库记录 */
        }
        return Number(info.lastInsertRowid);
    }

    recentDiaries(limit = 5) {
        return this.require().prepare('SELECT * FROM diary ORDER BY created_at DESC LIMIT ?').all(limit)
            .map((r) => ({ id: Number(r.id), cycle: r.cycle_id, visited: Number(r.visited), domains: safeJson(r.domains, []), body: r.body, at: Number(r.created_at) }));
    }

    // ---------- 日志 ----------

    log(level, message, meta = '') {
        try {
            this.require().prepare('INSERT INTO logs(level, message, meta, created_at) VALUES(?,?,?,?)')
                .run(String(level), truncate(message, 400), truncate(typeof meta === 'string' ? meta : JSON.stringify(meta), 300), Date.now());
        } catch {
            /* 数据库未就绪时的日志丢弃，不抛错 */
        }
    }

    recentLogs(limit = 20) {
        return this.require().prepare('SELECT * FROM logs ORDER BY created_at DESC LIMIT ?').all(limit)
            .map((r) => ({ level: r.level, message: r.message, meta: r.meta, at: Number(r.created_at) }));
    }

    // ---------- 站点统计 ----------

    noteSource(host, ok, ms = 0) {
        if (!host) return;
        const db = this.require();
        const row = db.prepare('SELECT * FROM sources WHERE host = ?').get(host);
        const now = Date.now();
        if (!row) {
            db.prepare('INSERT INTO sources(host, ok, fail, last_ok, last_fail, avg_ms) VALUES(?,?,?,?,?,?)')
                .run(host, ok ? 1 : 0, ok ? 0 : 1, ok ? now : 0, ok ? 0 : now, ok ? Math.round(ms) : 0);
            return;
        }
        const okN = Number(row.ok) + (ok ? 1 : 0);
        const avg = Math.round((Number(row.avg_ms) * Number(row.ok) + (ok ? ms : 0)) / Math.max(1, okN));
        db.prepare('UPDATE sources SET ok = ?, fail = ?, last_ok = ?, last_fail = ?, avg_ms = ? WHERE host = ?').run(
            okN, Number(row.fail) + (ok ? 0 : 1), ok ? now : Number(row.last_ok), ok ? Number(row.last_fail) : now, avg, host,
        );
    }

    sourceStats(limit = 40) {
        return this.require().prepare('SELECT * FROM sources ORDER BY (ok + fail) DESC LIMIT ?').all(limit)
            .map((r) => ({ host: r.host, ok: Number(r.ok), fail: Number(r.fail), avgMs: Number(r.avg_ms), lastFail: Number(r.last_fail) || null }));
    }

    // ---------- 4.0 迁移 ----------

    /** 旧库升级：补 lang_pattern 的 category/first_seen 两列（幂等）。 */
    migrate6() {
        const db = this.db;
        db.exec(`CREATE TABLE IF NOT EXISTS dialogue_test (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            homework_id INTEGER NOT NULL DEFAULT 0,
            prompt TEXT NOT NULL DEFAULT '',
            reply TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'answering',
            score INTEGER,
            suggestion TEXT NOT NULL DEFAULT '',
            self_review TEXT NOT NULL DEFAULT '',
            error TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            reviewed_at INTEGER NOT NULL DEFAULT 0
        )`);
        db.exec('CREATE INDEX IF NOT EXISTS idx_dialogue_created ON dialogue_test(created_at DESC)');
    }
    migrate5() {
        const db = this.db;
        db.exec(`CREATE TABLE IF NOT EXISTS homework (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            study_id TEXT NOT NULL DEFAULT '',
            topic TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'writing',
            score INTEGER,
            suggestion TEXT NOT NULL DEFAULT '',
            self_review TEXT NOT NULL DEFAULT '',
            error TEXT NOT NULL DEFAULT '',
            platforms TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            reviewed_at INTEGER NOT NULL DEFAULT 0
        )`);
        db.exec('CREATE INDEX IF NOT EXISTS idx_homework_created ON homework(created_at DESC)');
    }
    migrate4() {
        const db = this.db;
        const cols = db.prepare('PRAGMA table_info(lang_pattern)').all().map((c) => c.name);
        if (!cols.includes('category')) db.exec("ALTER TABLE lang_pattern ADD COLUMN category TEXT NOT NULL DEFAULT '通用'");
        if (!cols.includes('first_seen')) db.exec('ALTER TABLE lang_pattern ADD COLUMN first_seen INTEGER NOT NULL DEFAULT 0');
        db.exec('UPDATE lang_pattern SET first_seen = created_at WHERE first_seen = 0');
        db.exec("UPDATE lang_pattern SET category = CASE kind WHEN 'particle' THEN '中文口语' WHEN 'rhythm' THEN '日常叙述' WHEN 'connective' THEN '对话接续' WHEN 'dialogue' THEN '对话接续' WHEN 'emotion' THEN '情绪表达' WHEN 'slang' THEN '网络流行语' WHEN 'forum' THEN '对话接续' WHEN 'rhetoric' THEN '幽默表达' WHEN 'punctuation' THEN '日常叙述' WHEN 'explain' THEN '知识讲解' WHEN 'register' THEN '日常叙述' WHEN 'opening' THEN '日常叙述' WHEN 'address' THEN '对话接续' ELSE category END WHERE category = '通用'");
        const fcols = db.prepare('PRAGMA table_info(frontier)').all().map((c) => c.name);
        if (!fcols.includes('group_name')) db.exec("ALTER TABLE frontier ADD COLUMN group_name TEXT NOT NULL DEFAULT 'other'");
        if (!fcols.includes('platform')) db.exec("ALTER TABLE frontier ADD COLUMN platform TEXT NOT NULL DEFAULT ''");
        const vcols = db.prepare('PRAGMA table_info(visits)').all().map((c) => c.name);
        if (!vcols.includes('group_name')) db.exec("ALTER TABLE visits ADD COLUMN group_name TEXT NOT NULL DEFAULT 'other'");
        if (!vcols.includes('platform')) db.exec("ALTER TABLE visits ADD COLUMN platform TEXT NOT NULL DEFAULT ''");
    }

    // ---------- 4.0 讨论区 ----------

    addDiscussion({ url, title, platform, domain = '未分类', groupName = 'other', totalHint = 0, sampled = 0, features = {} }) {
        try {
            this.require().prepare(`INSERT INTO discussions(url, title, platform, domain, group_name, total_hint, sampled, features, created_at)
                VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET sampled = excluded.sampled, features = excluded.features, created_at = excluded.created_at`)
                .run(truncate(url, 800), truncate(title, 300), truncate(platform, 40), truncate(domain, 40), truncate(groupName, 20), Math.round(totalHint), Math.round(sampled), JSON.stringify(features), Date.now());
        } catch (error) {
            this.log('warn', `讨论记录写入失败：${String(error?.message || error)}`);
        }
    }

    recentDiscussions(limit = 10) {
        return this.require().prepare('SELECT * FROM discussions ORDER BY created_at DESC LIMIT ?').all(limit).map((r) => ({
            id: Number(r.id), url: r.url, title: r.title, platform: r.platform, domain: r.domain,
            group: r.group_name, sampled: Number(r.sampled), at: Number(r.created_at),
        }));
    }

    discussionStats() {
        const row = this.require().prepare('SELECT COUNT(*) AS n, SUM(sampled) AS s FROM discussions').get();
        const platforms = this.require().prepare('SELECT platform, COUNT(*) AS n, SUM(sampled) AS s FROM discussions GROUP BY platform ORDER BY n DESC').all();
        return {
            discussions: Number(row?.n ?? 0),
            comments: Number(row?.s ?? 0),
            platforms: platforms.map((p) => ({ platform: p.platform, discussions: Number(p.n), comments: Number(p.s) })),
        };
    }

    // ---------- 4.0 语言趋势 ----------

    noteTerm(term, category = '口语', platform = '') {
        const clean = truncate(String(term || '').trim(), 40);
        if (clean.length < 2) return;
        const now = Date.now();
        this.require().prepare(`INSERT INTO term_trend(term, category, platform, hits, first_seen, last_seen) VALUES(?,?,?,1,?,?)
            ON CONFLICT(term) DO UPDATE SET hits = hits + 1, last_seen = ?, category = excluded.category`)
            .run(clean, truncate(category, 20), truncate(platform, 40), now, now, now);
    }

    /** 趋势分：命中次数 × 新鲜度（30 天半衰），过时的流行语自然沉底。 */
    termTrends(limit = 40) {
        const rows = this.require().prepare('SELECT * FROM term_trend ORDER BY last_seen DESC LIMIT 400').all();
        const now = Date.now();
        return rows.map((r) => {
            const days = Math.max(0, (now - Number(r.last_seen)) / 86_400_000);
            const freshness = Math.exp(-days / 30);
            return {
                term: r.term, category: r.category, platform: r.platform,
                hits: Number(r.hits), score: round(Number(r.hits) * freshness, 4), daysOld: round(days, 1),
            };
        }).sort((a, b) => b.score - a.score).slice(0, limit);
    }

    // ---------- 4.0 Agent 接入 ----------

    registerAgent({ id, preset = '', title = '' }) {
        const key = truncate(String(id || ''), 120);
        if (!key) return;
        const now = Date.now();
        this.require().prepare(`INSERT INTO agents(id, preset, title, enabled, sessions, first_seen, last_seen) VALUES(?,?,?,1,1,?,?)
            ON CONFLICT(id) DO UPDATE SET preset = excluded.preset, title = CASE WHEN excluded.title != '' THEN excluded.title ELSE title END,
            sessions = sessions + 1, last_seen = excluded.last_seen`)
            .run(key, truncate(preset, 80), truncate(title, 120), now, now);
    }

    listAgents(limit = 100) {
        return this.require().prepare('SELECT * FROM agents ORDER BY last_seen DESC LIMIT ?').all(limit).map((r) => ({
            id: r.id, preset: r.preset, title: r.title, enabled: Number(r.enabled) === 1,
            sessions: Number(r.sessions), firstSeen: Number(r.first_seen), lastSeen: Number(r.last_seen),
        }));
    }

    setAgentEnabled(id, enabled) {
        this.require().prepare('UPDATE agents SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, String(id));
        return this.agentEnabled(id);
    }

    agentEnabled(id) {
        const row = this.require().prepare('SELECT enabled FROM agents WHERE id = ?').get(String(id));
        return row ? Number(row.enabled) === 1 : true;
    }

    agentStats() {
        const rows = this.require().prepare('SELECT enabled, COUNT(*) AS n FROM agents GROUP BY enabled').all();
        const out = { total: 0, enabled: 0, disabled: 0 };
        for (const r of rows) {
            out.total += Number(r.n);
            if (Number(r.enabled) === 1) out.enabled += Number(r.n);
            else out.disabled += Number(r.n);
        }
        return out;
    }

    // ---------- 维护 ----------

    dbSizeBytes() {
        try {
            return statSync(this.file).size;
        } catch {
            return 0;
        }
    }

    stats() {
        const db = this.require();
        const count = (sql, ...args) => Number(db.prepare(sql).get(...args)?.n ?? 0);
        return {
            file: this.file,
            sizeMB: round(this.dbSizeBytes() / 1_048_576, 2),
            visits: count('SELECT COUNT(*) AS n FROM visits'),
            visitsToday: count('SELECT COUNT(*) AS n FROM visits WHERE fetched_at >= ?', Date.now() - 86_400_000),
            domains: count('SELECT COUNT(DISTINCT domain) AS n FROM visits'),
            frontier: count("SELECT COUNT(*) AS n FROM frontier WHERE status = 'new'"),
            knowledge: count('SELECT COUNT(*) AS n FROM knowledge'),
            verified: count("SELECT COUNT(*) AS n FROM knowledge WHERE status = 'verified'"),
            patterns: count('SELECT COUNT(*) AS n FROM lang_pattern'),
            prefs: count('SELECT COUNT(*) AS n FROM user_pref WHERE active = 1'),
            evals: count('SELECT COUNT(*) AS n FROM evals'),
            diaries: count('SELECT COUNT(*) AS n FROM diary'),
            interests: count("SELECT COUNT(*) AS n FROM interests WHERE state = 'active'"),
        };
    }

    exportAll() {
        const out = { exportedAt: new Date().toISOString(), schemaVersion: SCHEMA_VERSION, tables: {} };
        for (const table of TABLES) out.tables[table] = this.require().prepare(`SELECT * FROM ${table}`).all();
        return out;
    }

    backup() {
        const name = `hles-${new Date().toISOString().replace(/[:.]/gu, '-')}.db`;
        const target = join(this.dir, 'backups', name);
        mkdirSync(dirname(target), { recursive: true });
        this.require().exec(`VACUUM INTO '${target.replace(/'/gu, "''")}'`);
        return target;
    }

    deleteScope(scope) {
        const db = this.require();
        const map = {
            all: TABLES,
            visits: ['visits'],
            frontier: ['frontier'],
            knowledge: ['knowledge'],
            language: ['lang_pattern', 'pattern_history'],
            prefs: ['user_pref'],
            eval: ['evals'],
            interests: ['interests'],
            diary: ['diary'],
            logs: ['logs'],
        };
        const tables = map[scope];
        if (!tables) throw new Error(`未知的清理范围：${scope}（可选 ${Object.keys(map).join('/')}）`);
        this.tx(() => {
            for (const table of tables) db.exec(`DELETE FROM ${table}`);
        });
        return { scope, tables };
    }

    rollback(table, id) {
        const db = this.require();
        if (table === 'lang_pattern') {
            const hist = db.prepare('SELECT * FROM pattern_history WHERE pattern_id = ? ORDER BY at DESC LIMIT 1').get(id);
            if (!hist) throw new Error(`没有可回滚的语言经验历史：${id}`);
            const before = JSON.parse(hist.before_json);
            db.prepare(`UPDATE lang_pattern SET pattern = ?, example = ?, confidence = ?, hits = ?, last_seen = ?, source_url = ? WHERE id = ?`)
                .run(before.pattern, before.example, before.confidence, before.hits, before.last_seen, before.source_url, id);
            db.prepare('DELETE FROM pattern_history WHERE id = ?').run(Number(hist.id));
            return { table, id, restored: before.pattern };
        }
        if (table === 'knowledge') {
            const row = db.prepare('SELECT * FROM knowledge WHERE id = ?').get(id);
            if (!row) throw new Error(`知识不存在：${id}`);
            db.prepare("UPDATE knowledge SET status = 'unverified', sources = 1, confidence = 0.4, updated_at = ? WHERE id = ?").run(Date.now(), id);
            return { table, id, restored: 'unverified' };
        }
        if (table === 'user_pref') {
            const row = db.prepare('SELECT * FROM user_pref WHERE id = ?').get(id);
            if (!row) throw new Error(`偏好不存在：${id}`);
            if (Number(row.hits) > 1) {
                db.prepare('UPDATE user_pref SET hits = hits - 1, confidence = MAX(0.3, confidence - 0.1), updated_at = ? WHERE id = ?').run(Date.now(), id);
                return { table, id, restored: `hits=${Number(row.hits) - 1}` };
            }
            db.prepare('UPDATE user_pref SET active = 0, updated_at = ? WHERE id = ?').run(Date.now(), id);
            return { table, id, restored: 'inactive' };
        }
        throw new Error(`不支持回滚的表：${table}`);
    }

    prune() {
        const { maxVisits, maxFrontier, maxLogs } = this.config.db;
        const db = this.require();
        let pruned = 0;
        this.tx(() => {
            const n1 = db.prepare(`DELETE FROM visits WHERE id NOT IN (SELECT id FROM visits ORDER BY fetched_at DESC LIMIT ?)`).run(maxVisits);
            const n2 = db.prepare('DELETE FROM frontier WHERE status != \'new\' AND id NOT IN (SELECT id FROM frontier ORDER BY id DESC LIMIT 300)').run();
            const n3 = db.prepare(`DELETE FROM frontier WHERE status = 'new' AND id NOT IN (SELECT id FROM frontier ORDER BY priority DESC, id DESC LIMIT ?)`).run(maxFrontier);
            const n4 = db.prepare(`DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY created_at DESC LIMIT ?)`).run(maxLogs);
            const n5 = db.prepare(`DELETE FROM pattern_history WHERE id NOT IN (SELECT id FROM pattern_history ORDER BY at DESC LIMIT 400)`).run();
            pruned = Number(n1.changes) + Number(n2.changes) + Number(n3.changes) + Number(n4.changes) + Number(n5.changes);
        });
        return { pruned };
    }

    vacuum() {
        this.require().exec('VACUUM');
        return { file: this.file, sizeMB: round(this.dbSizeBytes() / 1_048_576, 2) };
    }
}

function nullable(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function safeJson(text, fallback) {
    try {
        return JSON.parse(text);
    } catch {
        return fallback;
    }
}

function avgOf(rows, col) {
    const vals = rows.map((r) => r[col]).filter((v) => typeof v === 'number');
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

function mapKnowledge(r) {
    return {
        id: Number(r.id), statement: r.statement, topic: r.topic, domain: r.domain,
        sources: Number(r.sources), confidence: round(Number(r.confidence), 2),
        status: r.status, site: r.site, url: r.source_url, updatedAt: Number(r.updated_at),
    };
}

function mapPattern(r) {
    return {
        id: Number(r.id), kind: r.kind, key: r.key, pattern: r.pattern, example: r.example,
        register: r.register, lang: r.lang, domain: r.domain, site: r.site,
        confidence: round(Number(r.confidence), 2), hits: Number(r.hits), lastSeen: Number(r.last_seen),
        category: r.category || '通用', firstSeen: Number(r.first_seen || 0),
    };
}

function mapPref(r) {
    return {
        id: Number(r.id), scope: r.scope, session: r.session_id, preset: r.agent_preset,
        kind: r.kind, subject: r.subject, evidence: r.evidence,
        confidence: round(Number(r.confidence), 2), hits: Number(r.hits), at: Number(r.updated_at),
    };
}
