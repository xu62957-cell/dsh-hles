/**
 * 语言质量评估：自然度 / 流畅度 / 多样性 / 上下文适应 / 连贯性 / 机械化程度 / 准确性。
 *
 * 前六项是启发式可算的；「准确性」需要事实核对，启发式不做假判断 ——
 * 这里返回 null 并说明原因，避免用编出来的分数骗自己。
 */

import { clamp, round, stddev, cjkLen, shannon, splitSentences, splitParagraphs, jaccard } from './util.js';
import { detectAiTraits, analyzeForChecks } from './anti-ai.js';
import { extractFeatures, classifyRegister } from './language.js';

const FORMAL_HINT = /(报告|文档|方案|总结|代码|正式|评审|公文|合同|说明|论文)/u;
const CHAT_HINT = /(哈哈|在吗|聊聊|随便|吐槽|说说|玩|推荐)/u;

/** 期望文体：请求语气决定回答该偏正式还是偏口语。 */
export function expectedRegister(context) {
    if (FORMAL_HINT.test(context || '')) return '正式';
    if (CHAT_HINT.test(context || '')) return '轻松';
    return '中性';
}

export function assessText(text, { context = '', sessionId = '', turn = 0 } = {}) {
    const clean = String(text ?? '').trim();
    const features = extractFeatures(clean);
    const anti = detectAiTraits(clean, { context });
    const analyze = anti.analyze || analyzeForChecks(clean);
    const register = classifyRegister(features, clean);
    const expected = expectedRegister(context);
    const sentences = analyze.sentences;
    const lens = sentences.map((s) => cjkLen(s) || s.length);
    const sd = stddev(lens);
    const openerEntropy = sentences.length ? shannon(sentences.map((s) => s.slice(0, 2))) : 0;
    const notes = [];

    if (!anti.evaluated) {
        return {
            natural: null, fluency: null, diversity: null, contextFit: null,
            coherence: null, mechanization: null, accuracy: null,
            aiHits: [], evaluated: false, register, expected,
            note: anti.note, features, sessionId, turn, sample: clean.slice(0, 160),
        };
    }

    // —— 自然度：口语颗粒、句长变化、有活人痕迹（省略/插入/反问）
    let natural = 62;
    natural += Math.min(14, Object.values(features.particles).reduce((a, b) => a + b, 0) * 2.2);
    natural += Math.min(10, (features.shortRatio - 0.2) * 25);
    natural += Math.min(8, sd / 3);
    if (features.punctuation.ellipsis || features.punctuation.dash || features.punctuation.paren) natural += 4;
    if (features.rhetorical && Object.keys(features.rhetorical).length) natural += 3;
    natural -= anti.score * 0.55;
    natural -= features.repeatedOpeners.length * 3;
    natural = clamp(natural, 5, 96);

    // —— 流畅度：句子不要过长/过碎，连接词别堆，标点别乱
    let fluency = 84;
    const meanLen = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
    if (meanLen > 42) fluency -= Math.min(25, (meanLen - 42) * 1.2);
    if (meanLen > 0 && meanLen < 9 && sentences.length > 4) fluency -= 8;
    if (features.punctuation.comma / Math.max(1, sentences.length) > 4) fluency -= 10;
    const connDensity = Object.values(features.connectives).reduce((a, b) => a + b, 0) / Math.max(1, features.chars / 100);
    if (connDensity > 1.6) fluency -= Math.min(15, (connDensity - 1.6) * 8);
    if (sentences.length >= 4 && sd < 2.5) fluency -= 6;
    if (features.longRatio > 0.6) fluency -= 10;
    fluency -= anti.hits.filter((h) => ['connective-overuse', 're-ex-explaining', 're-explaining', 'awkward-transition'].includes(h.code)).length * 5;
    fluency = clamp(fluency, 5, 97);

    // —— 多样性：句首/用词/句式
    let diversity = 40 + openerEntropy * 26 + Math.min(20, features.uniqueRatio * 30);
    if (features.registerScores && Object.values(features.registerScores).filter((n) => n > 0).length >= 3) diversity += 6;
    diversity -= features.repeatedOpeners.length * 4;
    diversity -= anti.hits.filter((h) => ['over-parallel', 'repeated-sentence', 'low-variation'].includes(h.code)).length * 6;
    diversity = clamp(diversity, 5, 97);

    // —— 上下文适应：语气与请求是否匹配
    let contextFit = 70;
    if (expected === '正式') {
        contextFit = register === '通用' || /正式|知识|深度/.test(register) ? 84 : 62;
        if (Object.keys(features.slang).length) contextFit -= 14;
        if (features.particles && Object.values(features.particles).reduce((a, b) => a + b, 0) > 6) contextFit -= 8;
        if (anti.hits.some((h) => h.code === 'register-mismatch')) contextFit -= 10;
    } else if (expected === '轻松') {
        contextFit = /聊天|闲聊|幽默|网络/.test(register) ? 88 : 66;
        if (features.particles && Object.values(features.particles).reduce((a, b) => a + b, 0) === 0) contextFit -= 6;
        if (features.shortRatio < 0.15 && meanLen > 35) contextFit -= 8;
    } else {
        contextFit = 72 + (openerEntropy > 0.8 ? 6 : 0);
    }
    contextFit = clamp(contextFit, 10, 96);

    // —— 连贯性：句间词汇衔接 + 段落结构 + 指代
    const cohesion = [];
    for (let i = 1; i < sentences.length; i += 1) cohesion.push(jaccard(sentences[i - 1], sentences[i]));
    const avgCohesion = cohesion.length ? cohesion.reduce((a, b) => a + b, 0) / cohesion.length : 0;
    const paras = splitParagraphs(clean);
    let coherence = 55 + Math.min(28, avgCohesion * 90);
    if (paras.length >= 2) coherence += 6;
    if (paras.length > 9 && sentences.length / paras.length < 1.4) coherence -= 6;
    if (features.person.second > 0 && features.person.first > 0) coherence += 3;
    coherence -= Math.min(18, features.repeatedOpeners.length * 3);
    coherence = clamp(coherence, 10, 96);

    // —— 机械化程度 = 100 - 反机械化得分（越高越机械）
    const mechanization = clamp(anti.score, 0, 100);

    if (anti.hits.length) notes.push(`机械化命中 ${anti.hits.length} 类：${anti.hits.map((h) => h.name).join('、')}`);
    if (sd > 18) notes.push(`句长变化大（σ=${sd.toFixed(1)}），节奏自然`);
    if (Object.values(features.particles).reduce((a, b) => a + b, 0) === 0 && sentences.length > 3) notes.push('没有语气词，偏书面');
    if (avgCohesion < 0.03 && sentences.length > 4) notes.push('句间词汇关联偏弱，可能显得跳');
    if (features.repeatedOpeners.length) notes.push(`句首重复：${features.repeatedOpeners.slice(0, 2).map(([o, n]) => `${o}×${n}`).join('、')}`);

    return {
        natural: round(natural, 1),
        fluency: round(fluency, 1),
        diversity: round(diversity, 1),
        contextFit: round(contextFit, 1),
        coherence: round(coherence, 1),
        mechanization: round(mechanization, 1),
        accuracy: null,
        accuracyNote: '准确性需要事实核对，启发式不评分',
        aiHits: anti.hits.map((h) => ({ code: h.code, name: h.name, samples: h.samples })),
        evaluated: true,
        register,
        expected,
        notes,
        features: {
            sentences: features.sentences, meanLen: round(meanLen, 1), sd: round(sd, 1),
            shortRatio: features.shortRatio, dialogueRatio: features.dialogueRatio,
            particles: Object.values(features.particles).reduce((a, b) => a + b, 0),
        },
        sessionId,
        turn,
        sample: clean.slice(0, 160),
    };
}
