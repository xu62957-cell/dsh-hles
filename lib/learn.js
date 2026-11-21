/**
 * 持续学习：从真实对话里收集语言反馈，并给每轮回答做一次自评。
 *
 * 边界（对应设计要求）：
 *   - 只有**用户明确表达的偏好**才进 user_pref，而且和通用语言规律分表存储；
 *   - 一次反馈不会改写通用规律；通用规律只从网页语料里归纳；
 *   - 默认只保存 160 字以内的样本用于复盘，不保存整段对话；
 *   - 自评的"准确性"不评分（需要事实核对），不伪造分数。
 */

import { splitSentences, truncate, oneLine, isCjkHeavy } from './util.js';
import { assessText } from './quality.js';

const DISLIKE_CUES = [
    [/太(?:机械|机器|模板|假|啰嗦|正式|生硬|僵|AI)/iu, 0.7],
    [/(?:不像|没有)(?:真人|人话|人味|人味儿)/u, 0.7],
    [/(?:别|不要|不用|少)(?:再)?(?:总结|说教|客套|排比|罗列|分点|解释)/u, 0.8],
    [/(?:套话|废话|模板|机器人味|AI味|ai味)/u, 0.65],
    [/(?:别老|总是|每次都|又这样|又是这套|又来)/u, 0.6],
    [/(?:不用|别)这么客气/u, 0.7],
    [/(?:太)长(?:了)?(?:，|,)?(?:说重点)/u, 0.6],
];

const LIKE_CUES = [
    [/(?:这样(?:很|就)?好|就这样说|保持(?:这个|这样)|别改|别改了)/u, 0.7],
    [/(?:自然|像人话|有人味|有那味|舒服|顺畅|读着轻松)/u, 0.6],
    [/(?:这句好|这么说对|就这个语气|这个说法(?:好|对)|对味)/u, 0.65],
    [/(?:懂了|明白了)(?:，|,)?(?:就)?(?:这么)/u, 0.5],
];

const PREFERENCE_CUES = [
    /(?:以后|今后|一直|永远|每次|记得)(?:都)?(?:要|别|不要|用|少用|多说|别用|尽量)([^。！？!?\n]{2,50})/u,
    /我(?:更)?喜欢([^。！？!?\n]{2,50})/u,
    /我希望(?:你)?([^。！？!?\n]{2,50})/u,
    /(?:不要|别)再(?:用|说|写)([^。！？!?\n]{2,50})/u,
];

/** 从一条用户消息里识别显式反馈。 */
export function detectFeedback(text) {
    const clean = oneLine(text);
    if (!clean || clean.length < 4) return [];
    const out = [];
    const sentences = splitSentences(clean);
    const push = (kind, subject, evidence, confidence) => {
        const s = oneLine(subject);
        if (!s || s.length < 2) return;
        out.push({ kind, subject: truncate(s, 120), evidence: truncate(evidence || clean, 200), confidence });
    };
    for (const [re, conf] of DISLIKE_CUES) {
        const m = re.exec(clean);
        if (!m) continue;
        const sentence = sentences.find((s) => s.includes(m[0])) || clean;
        push('dislike', extractSubject(sentence, m[0]), sentence, conf);
        break;
    }
    for (const [re, conf] of LIKE_CUES) {
        const m = re.exec(clean);
        if (!m) continue;
        const sentence = sentences.find((s) => s.includes(m[0])) || clean;
        push('like', extractSubject(sentence, m[0]), sentence, conf);
        break;
    }
    const quoted = /["「『“']([^"」』”']{2,30})["」』”']/u.exec(clean);
    for (const re of PREFERENCE_CUES) {
        const m = re.exec(clean);
        if (!m || !m[1]) continue;
        let target = quoted ? quoted[1] : oneLine(m[1]);
        target = target.split(/[，,。；;:：]/u)[0].trim();
        target = target.replace(/^(再|又|总是|老是|这么|那么|用|说|写|的|了)+/u, '').trim();
        if (target.length < 2 || target.length > 30) continue;
        const scopeHint = /(以后|今后|一直|永远|每次|记得)/u.test(clean) ? 0.75 : 0.6;
        push('preference', target, sentences.find((s) => s.includes(m[0])) || clean, scopeHint);
        break;
    }
    return out.slice(0, 3);
}

function extractSubject(sentence, cue) {
    const clauses = String(sentence ?? '').split(/[，,。；;]/u).map((c) => c.trim()).filter(Boolean);
    const hit = clauses.find((c) => c.includes(cue)) || String(sentence ?? '');
    const cleaned = hit.replace(/^[\s，,。！？]+/u, '').trim();
    return cleaned.length >= 2 ? cleaned : String(sentence ?? '').trim();
}

/** 会话事件驱动的学习器。 */
export class Learner {
    constructor({ store, config, logger }) {
        this.store = store;
        this.config = config;
        this.logger = logger;
        this.sessions = new Map();
    }

    /**
     * 当前会话的表达语言，用于挑选同语种的经验。
     * 用最近几条用户消息的多数票，避免被框架注入的英文指令带偏。
     */
    languageOf(sessionId) {
        const s = this.sessions.get(String(sessionId || ''));
        if (!s) return '';
        const recent = [...(s.texts || [])].filter((text) => !looksLikeHarnessText(text)).slice(-6);
        if (!recent.length) return '';
        let zh = 0;
        let en = 0;
        for (const text of recent) {
            if (isCjkHeavy(text)) zh += 1;
            else en += 1;
        }
        // 两边都不足 2 条时不猜，交给配置里的默认语种
        if (zh < 2 && en < 2) return '';
        return zh >= en ? 'zh' : 'en';
    }

    get(id) {
        let s = this.sessions.get(id);
        if (!s) {
            s = { lastUserText: '', texts: [], assistant: [], lastTurn: 0, evaluatedTurn: -1, preset: '' };
            this.sessions.set(id, s);
            if (this.sessions.size > 80) {
                // 只保留最近 40 个会话的缓冲，避免常驻内存
                const keys = [...this.sessions.keys()].slice(0, 40);
                for (const k of keys) this.sessions.delete(k);
            }
        }
        return s;
    }

    onSessionEvent(session, event) {
        if (!session?.id || !event?.type) return;
        const id = String(session.id);
        const preset = String(session.header?.agentPreset || '');
        const state = this.get(id);
        state.preset = preset || state.preset;
        if (event.type === 'user/message') {
            const text = textOf(event.data);
            if (text) {
                if (!looksLikeHarnessText(text)) {
                    state.lastUserText = text;
                    state.texts = [...(state.texts || []), text].slice(-8);
                    if (this.config.learn.feedback) this.learnFromUserText({ sessionId: id, preset, text });
                }
            }
            return;
        }
        if (event.type === 'assistant/message') {
            const text = textOf(event.data?.message);
            if (text) {
                state.assistant.push({ text, turn: Number(event.data?.turn ?? 0) });
                if (state.assistant.length > 3) state.assistant.shift();
            }
            return;
        }
        if (event.type === 'turn/end') {
            const turn = Number(event.data?.turn ?? 0);
            if (!this.config.learn.evaluateTurns) return;
            if (state.evaluatedTurn === turn) return;
            const last = state.assistant.filter((a) => a.turn === turn).pop() || state.assistant.pop();
            if (!last?.text) return;
            state.evaluatedTurn = turn;
            try {
                const report = assessText(last.text, { context: state.lastUserText, sessionId: id, turn });
                if (!report.evaluated) return;
                this.store.addEval({
                    sessionId: id, turn,
                    natural: report.natural, fluency: report.fluency, diversity: report.diversity,
                    contextFit: report.contextFit, coherence: report.coherence,
                    mechanization: report.mechanization, accuracy: null,
                    aiHits: report.aiHits.map((h) => h.code),
                    sample: this.config.learn.keepSamples ? last.text.slice(0, this.config.learn.maxSampleChars) : '',
                    notes: report.notes.join('；'),
                });
            } catch (error) {
                this.store.log('warn', `回合自评失败：${String(error?.message || error)}`, id);
            }
        }
    }

    learnFromUserText({ sessionId, preset, text }) {
        const found = detectFeedback(text);
        for (const item of found) {
            const global = /(以后都|永远|一直都|每次都)/u.test(text);
            this.store.addPref({
                scope: global ? 'global' : 'session',
                sessionId: global ? '' : sessionId,
                agentPreset: preset,
                kind: item.kind,
                subject: item.subject,
                evidence: item.evidence,
                confidence: item.confidence,
            });
        }
        if (found.length) {
            this.store.log('info', `记录用户语言反馈 ${found.length} 条：${found.map((f) => `${f.kind}:${truncate(f.subject, 30)}`).join(' / ')}`, sessionId);
        }
        return found;
    }

    /** 工具调用入口：让模型把用户明确的反馈写进库。 */
    recordFeedback({ text, sessionId = '', preset = '', kind, subject, confidence = 0.7 }) {
        if (kind && subject) {
            return this.store.addPref({ scope: 'session', sessionId, agentPreset: preset, kind, subject, evidence: text || '', confidence });
        }
        return this.learnFromUserText({ sessionId, preset, text: text || '' });
    }
}

/** 框架/系统注入的消息（运行时上下文、目标轮续跑指令等）不代表用户语言。 */
export function looksLikeHarnessText(text) {
    const s = String(text ?? '').trim();
    if (!s) return true;
    if (/^(Current runtime context|Continue working toward the objective|The approval policy changed|<goal_round>|\[assistant\])/iu.test(s)) return true;
    if (/untrusted-memory|<system-reminder>|<available_skills>/iu.test(s)) return true;
    return false;
}

function textOf(message) {
    if (!message) return '';
    const blocks = Array.isArray(message.content) ? message.content : [];
    return blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim();
}
