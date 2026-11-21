/**
 * 语言观察引擎。
 *
 * 这里做三件事：
 *   1. extractFeatures —— 把一段真实人类文本量化（句长分布、语气词、连接词、
 *      引语/对话、情绪标记、网络用语、人称、重复度、标点习惯、文体）。
 *   2. classifyRegister —— 判断它属于哪种交流场景（聊天/论坛/新闻/科普/文学…），
 *      因为同一种表达在不同场景下的"自然"标准不同。
 *   3. extractPatterns —— 只保留**相对基线异常**的特征，转成可复用的语言经验，
 *      每条都带例子、来源、置信度；不做"看到什么就学什么"。
 */

import {
    cjkLen, splitSentences, splitParagraphs, mean, stddev, shannon, isCjkHeavy,
    round, clamp, truncate, tokens,
} from './util.js';

export const PARTICLES = ['吧', '啊', '呢', '嘛', '呗', '哈', '哎', '嘿', '诶', '嗯', '啦', '咯', '呀', '哦', '喔', '嘞', '唉', '噢'];

export const CONNECTIVES = [
    '但是', '不过', '然而', '其实', '所以', '因此', '而且', '然后', '可是', '只是', '于是', '另外', '此外',
    '毕竟', '当然', '至少', '总之', '反过来', '与此同时', '相比之下', '换句话说', '也就是说', '由此可见',
];

export const HEDGES = ['可能', '大概', '应该', '似乎', '也许', '估计', '好像', '差不多', '未必', '或许', '恐怕', '基本上', '某种意义上'];

export const EMOTION_MARKERS = {
    高兴: ['开心', '高兴', '舒服', '痛快', '笑死', '哈哈哈', '喜欢', '太好了', '真好'],
    疑惑: ['为什么', '怎么回', '什么鬼', '难道', '不懂', '纳闷', '???'],
    惊讶: ['居然', '竟然', '没想到', '天啊', '我去', '震惊', '哇塞'],
    无奈: ['算了', '只能', '没办法', '叹气', '无奈', '唉', '摆烂', '服了'],
    兴奋: ['太棒了', '冲鸭', '冲了', '激动', '终于', '爽到', '期待'],
    失望: ['可惜', '遗憾', '失望', '没戏', '白费'],
    不满: ['气死', '离谱', '忍不了', '吐槽', '恶心', '无语', '受不了'],
    犹豫: ['也许', '要不要', '还是算了', '有点纠结', '不太确定', '犹豫', '再想想'],
    尴尬: ['尴尬', '脚趾抠地', '社死', '不好意思', '捂脸', '呃'],
    轻松: ['随便', '轻松', '慢慢来', '随意', '无所谓', '反正'],
};

export const SLANG = [
    'yyds', '破防', '绝了', '绷不住', '无语', '离谱', '上头', '真香', 'emo', '泪目', '打工人', '种草',
    '上岸', '内卷', '躺平', '社死', '蚌埠住了', '笑不活了', '666', 'awsl', '沙发', '板凳', '楼主',
    '+1', '同问', '路过', '前排', '插眼', '马克', '挖坟', '狗头', '烂梗', '玩梗', 'emmm', 'hhhh',
];

export const FORUM_MARKERS = ['楼主', '沙发', '板凳', '前排', '顶一个', '+1', '同问', '路过', '插眼', '马克', '层主', '引用', '回复', '转发', '蹲一个'];

export const RHETORICAL = ['难道', '不就是', '岂', '何必', '凭啥', '为啥', '咋', '难不成', '不香吗', '是吧', '对不对', '何尝'];

export const DIALOGUE_TAGS = ['说道', '问道', '回道', '答道', '笑道', '喊道', '回答', '开口', '嘟囔', '嘀咕', '补充道', '解释说', '说', '问', '答'];

/** 文体判定用的标记词。 */
export const REGISTER_MARKERS = {
    日常聊天: ['哈哈', '嗯', '诶', '你在', '我觉', '随便', '咋', '好的', '行吧', '哈哈'],
    熟人交流: ['咱', '我们', '兄弟', '姐妹', '老朋友', '你这', '嘿嘿'],
    正式交流: ['敬请', '贵司', '兹', '函', '敬上', '感谢您的', '特此', '抱歉打扰'],
    网络社交: ['转发', '点赞', '评论区', '吃瓜', '在线', '蹲一个', '楼主', '互关'],
    幽默调侃: ['笑死', '离谱', '梗', '狗头', '233', '整活', '乐子', '蚌埠'],
    认真讨论: ['因此', '论证', '依据', '结论', '证据', '逻辑', '前提', '反驳'],
    情绪交流: ['难过', '开心', '焦虑', '委屈', '心疼', '抱抱', '崩溃'],
    故事叙述: ['那时候', '后来', '记得', '当时', '走进', '第二天', '那一年'],
    深度分析: ['机制', '结构', '本质', '原因', '系统性', '层面', '路径依赖'],
    简短回应: ['是的', '好的', '嗯嗯', '可以', '不错', '收到'],
    技术讨论: ['函数', '接口', '部署', '版本', '代码', '编译', '依赖', '框架', '工具链'],
    轻松闲聊: ['最近', '感觉', '还行', '反正', '随便聊聊', '话说'],
    文学表达: ['仿佛', '沉默', '光', '影子', '风', '夜色', '气味', '记忆', '寂静'],
    观点辩论: ['认为', '反对', '错误', '恰恰', '相反', '不成立', '值得商榷'],
    知识讲解: ['也就是', '可以理解为', '本质是', '例如', '指的是', '通俗地说', '打个比方'],
    新闻报道: ['记者', '据', '报道', '消息', '今日', '发布会', '通报'],
    学术论文: ['研究表明', '本文', '实验', '样本', '显著', '假设', '文献'],
};

const REGISTER_EN = {
    日常聊天: ['lol', 'yeah', 'gonna', 'hey'],
    认真讨论: ['therefore', 'evidence', 'argument', 'conclusion'],
    技术讨论: ['function', 'api', 'deploy', 'compiler', 'framework'],
    新闻报道: ['reporters', 'according to', 'officials', 'announced'],
    学术论文: ['study', 'research', 'participants', 'significant', 'hypothesis'],
    文学表达: ['silence', 'light', 'shadow', 'remember', 'evening'],
    知识讲解: ['for example', 'in other words', 'that is', 'imagine'],
};

const TEXT_STATS_BASELINE = {
    shortRatio: 0.35,
    longRatio: 0.15,
    sd: 12,
    dialogueRatio: 0.1,
};

/** 抽取统计特征。 */
export function extractFeatures(text) {
    const clean = String(text ?? '');
    const cjk = cjkLen(clean);
    const chars = clean.replace(/\s+/gu, '').length;
    const sentences = splitSentences(clean).filter((s) => s.length >= 2);
    const paragraphs = splitParagraphs(clean);
    const lens = sentences.map((s) => cjkLen(s) || s.length);
    const short = lens.filter((n) => n <= 10).length;
    const long = lens.filter((n) => n >= 30).length;
    const quoteRe = /[「“"『][\s\S]{1,200}?[」”"』]/gu;
    const quoted = (clean.match(quoteRe) || []).length;
    const colonQuote = (clean.match(/[：:]\s*[「“"]/gu) || []).length;
    const dialogueLines = (clean.match(/^[「“"『].{1,80}[」”"』]$/gmu) || []).length;
    const dialogueRatio = sentences.length ? (quoted + colonQuote + dialogueLines) / sentences.length : 0;
    const openers = sentences.map((s) => (isCjkHeavy(s) ? s.slice(0, 2) : s.split(/\s+/u)[0] || ''));
    const openerCounts = countOf(openers);
    const repeatedOpeners = Object.entries(openerCounts).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
    const bigrams = tokens(clean);
    const bigramCounts = countOf(bigrams.filter((t) => t.length === 2));
    const repeatedBigrams = Object.entries(bigramCounts).filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1]);
    const uniqueRatio = bigrams.length ? new Set(bigrams).size / bigrams.length : 0;
    const punct = {
        comma: (clean.match(/[，,]/gu) || []).length,
        period: (clean.match(/[。.]/gu) || []).length,
        question: (clean.match(/[？?]/gu) || []).length,
        exclaim: (clean.match(/[！!]/gu) || []).length,
        ellipsis: (clean.match(/…{2,}|\.{3,}/gu) || []).length,
        dash: (clean.match(/——|--/gu) || []).length,
        paren: (clean.match(/（[^）]{1,40}）|\([^)]{1,40}\)/gu) || []).length,
        colon: (clean.match(/[：:]/gu) || []).length,
        semicolon: (clean.match(/[；;]/gu) || []).length,
    };
    const person = {
        first: (clean.match(/我们|咱们|我/gu) || []).length,
        second: (clean.match(/你们|您|你/gu) || []).length,
        third: (clean.match(/他们|她们|他|她|它/gu) || []).length,
        everyone: (clean.match(/大家|各位|咱们/gu) || []).length,
    };
    const latin = (clean.match(/[a-zA-Z]/gu) || []).length;
    const hasHan = cjk > 20;
    return {
        chars,
        cjk,
        sentences: sentences.length,
        paragraphs: paragraphs.length,
        sentenceLens: lens,
        sentenceMean: round(mean(lens), 1),
        sentenceSd: round(stddev(lens), 1),
        shortRatio: round(sentences.length ? short / sentences.length : 0, 3),
        longRatio: round(sentences.length ? long / sentences.length : 0, 3),
        dialogueRatio: round(dialogueRatio, 3),
        quoted,
        colonQuote,
        dialogueLines,
        particles: countWords(clean, PARTICLES),
        connectives: countWords(clean, CONNECTIVES),
        hedges: countWords(clean, HEDGES),
        emotions: Object.fromEntries(Object.entries(EMOTION_MARKERS).map(([k, words]) => [k, totalOf(countWords(clean, words))])),
        slang: countWords(clean, SLANG),
        forum: countWords(clean, FORUM_MARKERS),
        rhetorical: countWords(clean, RHETORICAL),
        dialogueTags: countWords(clean, DIALOGUE_TAGS),
        punctuation: punct,
        person,
        openers: openerCounts,
        repeatedOpeners,
        repeatedBigrams,
        uniqueRatio: round(uniqueRatio, 3),
        latinRatio: round(latin / Math.max(1, chars), 3),
        hasHan,
        registerScores: scoreRegisters(clean),
    };
}

function countOf(items) {
    const out = Object.create(null);
    for (const item of items) {
        if (!item) continue;
        out[item] = (out[item] || 0) + 1;
    }
    return out;
}

function countWords(text, words) {
    const out = Object.create(null);
    const lower = text.toLowerCase();
    for (const word of words) {
        const hits = countOccurrences(lower, word);
        if (hits > 0) out[word] = hits;
    }
    return out;
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** 英文/数字按词边界匹配，中文按子串匹配（中文没有词边界）。 */
export function countOccurrences(haystack, needle) {
    const s = String(haystack ?? '');
    const w = String(needle ?? '');
    if (!w) return 0;
    if (/^[\x00-\x7f]+$/u.test(w)) {
        const re = new RegExp(`(?<![a-z0-9])${escapeRe(w.toLowerCase())}(?![a-z0-9])`, 'gu');
        return (s.toLowerCase().match(re) || []).length;
    }
    let at = 0;
    let hits = 0;
    const lower = s.toLowerCase();
    const target = w.toLowerCase();
    while (hits < 60) {
        const idx = lower.indexOf(target, at);
        if (idx < 0) break;
        hits += 1;
        at = idx + target.length;
    }
    return hits;
}

function containsWord(text, word) {
    return countOccurrences(text, word) > 0;
}

function totalOf(map) {
    return Object.values(map).reduce((a, b) => a + b, 0);
}

export function scoreRegisters(text) {
    const lower = String(text ?? '').toLowerCase();
    const scores = {};
    for (const [register, words] of Object.entries(REGISTER_MARKERS)) {
        let s = 0;
        for (const w of words) {
            if (!w) continue;
            let at = 0;
            let hits = 0;
            while (hits < 20) {
                const idx = lower.indexOf(w.toLowerCase(), at);
                if (idx < 0) break;
                hits += 1;
                at = idx + w.length;
            }
            s += hits;
        }
        scores[register] = s;
    }
    for (const [register, words] of Object.entries(REGISTER_EN)) {
        let s = 0;
        for (const w of words) if (lower.includes(w)) s += 1;
        if (s > 0) scores[register] = (scores[register] || 0) + s;
    }
    return scores;
}

export function classifyRegister(features, text) {
    const chars = Math.max(1, features.chars);
    const scores = features.registerScores || scoreRegisters(text);
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [top, topScore] = ranked[0] || ['通用', 0];
    const density = topScore / (chars / 100);
    if (topScore >= 3 && density >= 0.4) {
        // 结构先验修正：对话多、句子短 → 更像聊天/叙事
        if (features.dialogueRatio > 0.3 && (top === '新闻报道' || top === '学术论文')) return '故事叙述';
        if (features.shortRatio > 0.6) return top === '深度分析' ? '日常聊天' : top;
        return top;
    }
    if (features.shortRatio > 0.7) return '简短回应';
    if (features.dialogueRatio > 0.35) return '故事叙述';
    return '通用';
}

/** 提取可入库的语言规律（相对基线显著才收）。 */
export function extractPatterns({ features, text, meta = {} }) {
    const out = [];
    const chars = Math.max(1, features.chars);
    const base = TEXT_STATS_BASELINE;
    const register = meta.register || classifyRegister(features, text);
    const lang = features.hasHan ? 'zh' : 'en';
    const push = (kind, key, pattern, example, confidence) => {
        const ex = String(example || '').trim();
        // 例句门槛：太短、纯导航、纯符号的一律不要
        if (ex.length < 6) return;
        if (/^(首页|登录|注册|更多|搜索|下一页|上一页|返回|分享|评论|收藏|展开|收起|查看全部|Filter|Sort|Login|Register|Home|More|Next|Previous)$/iu.test(ex)) return;
        if (!/[\u3400-\u9fff]/u.test(ex) && ex.length < 20) return;
        out.push({
            kind,
            key,
            pattern,
            example: truncate(example || '', 150),
            register,
            lang,
            domain: meta.domain || '未分类',
            sourceUrl: meta.url || '',
            site: meta.site || '',
            confidence: clamp(confidence, 0.2, 0.95),
        });
    };
    const trimQuote = (s) => String(s ?? '').replace(/^[」”'"\s]+/u, '').trim();
    const evidence = (needle, list) => {
        for (const s of list) if (containsWord(s, needle) && trimQuote(s).length >= 8) return trimQuote(s);
        const fallback = list.find((s) => trimQuote(s).length >= 8);
        return fallback ? trimQuote(fallback) : trimQuote(list[0] || '');
    };
    const sentences = splitSentences(text).filter((s) => s.length >= 2);

    // 1) 句长节奏
    if (features.sentences >= 6) {
        if (features.shortRatio >= 0.45) {
            push('rhythm', `短句主导|${lang}|${register}`,
                `以短句为主（短句占比 ${Math.round(features.shortRatio * 100)}%，平均 ${features.sentenceMean} 字），节奏快、停顿多`,
                evidence('', sentences.filter((s) => s.length <= 12)) || sentences[0], 0.4 + Math.min(0.3, features.shortRatio - 0.45));
        } else if (features.longRatio >= 0.28) {
            push('rhythm', `长句铺陈|${lang}|${register}`,
                `长句为主（长句占比 ${Math.round(features.longRatio * 100)}%），信息密集、少见句号`,
                evidence('', sentences.filter((s) => s.length >= 30)) || sentences[0], 0.38 + Math.min(0.3, features.longRatio - 0.28));
        }
        if (features.sentenceSd >= 18) {
            push('rhythm', `长短交替|${lang}|${register}`,
                `句长变化大（标准差 ${features.sentenceSd}），长句后常跟短句收束，形成呼吸感`,
                pickAlternating(sentences) || sentences[0], 0.42 + Math.min(0.25, (features.sentenceSd - 18) / 40));
        } else if (features.sentenceSd <= 5.5 && features.sentences >= 10) {
            push('rhythm', `等长句|${lang}|${register}`,
                `句长高度均匀（标准差 ${features.sentenceSd}），偏声明式、少停顿`,
                sentences[0], 0.35);
        }
    }

    // 2) 语气词
    for (const [word, n] of Object.entries(features.particles).sort((a, b) => b[1] - a[1]).slice(0, 3)) {
        if (n < 2 || n / (chars / 100) < 0.25) continue;
        push('particle', `语气词:${word}`, `口语里用「${word}」收尾，软化语气、缩短人际距离`, evidence(word, sentences), 0.35 + Math.min(0.35, n * 0.06));
    }

    // 3) 连接词/转折
    for (const [word, n] of Object.entries(features.connectives).sort((a, b) => b[1] - a[1]).slice(0, 3)) {
        if (n < 2) continue;
        const rate = n / (chars / 100);
        if (rate < 0.3) continue;
        push('connective', `连接:${word}`, `转折/推进常先抛「${word}」，再补新信息，避免生硬接续`, evidence(word, sentences), 0.32 + Math.min(0.3, n * 0.05));
    }

    // 4) 模糊限定
    const hedgeTotal = totalOf(features.hedges);
    if (hedgeTotal >= 2 && hedgeTotal / (chars / 100) >= 0.4) {
        const top = Object.entries(features.hedges).sort((a, b) => b[1] - a[1])[0][0];
        push('hedge', `限定:${top}`, `不确定处用「${top}」等限定词留出余地，不把话说死`, evidence(top, sentences), 0.35 + Math.min(0.25, hedgeTotal * 0.04));
    }

    // 5) 对话/引语
    if (features.dialogueRatio >= 0.2) {
        const tag = Object.entries(features.dialogueTags).sort((a, b) => b[1] - a[1])[0]?.[0];
        const ratio = Math.min(0.9, features.dialogueRatio);
        push('dialogue', `对话占比|${register}`,
            `对话/引语占比约 ${Math.round(ratio * 100)}%，靠对白推进而不是解说${tag ? `，提示语常用「${tag}」` : ''}`,
            pickQuote(text) || sentences[0], 0.4 + Math.min(0.25, ratio));
    }

    // 6) 情绪表达
    for (const [emotion, n] of Object.entries(features.emotions).sort((a, b) => b[1] - a[1]).slice(0, 2)) {
        if (n < 2) continue;
        const word = (EMOTION_MARKERS[emotion] || []).find((w) => containsWord(text, w));
        push('emotion', `情绪:${emotion}`, `表达「${emotion}」不直接命名情绪，而用「${word || emotion}」这类具体反应带出来`, evidence(word || emotion, sentences), 0.33 + Math.min(0.3, n * 0.05));
    }

    // 7) 网络/社群用语
    for (const [word, n] of Object.entries(features.slang).sort((a, b) => b[1] - a[1]).slice(0, 2)) {
        if (n < 1) continue;
        push('slang', `社群用语:${word}`, `圈层里用「${word}」表达态度，语气轻、不必解释`, evidence(word, sentences), 0.3 + Math.min(0.35, n * 0.12));
    }

    // 8) 论坛互动
    const forumTotal = totalOf(features.forum);
    if (forumTotal >= 2) {
        const top = Object.entries(features.forum).sort((a, b) => b[1] - a[1])[0][0];
        push('forum', `互动:${top}`, `论坛式接话用「${top}」直接回应上一楼，不重复原文`, evidence(top, sentences), 0.35 + Math.min(0.3, forumTotal * 0.05));
    }

    // 9) 反问/调侃
    const rhetTotal = totalOf(features.rhetorical);
    if (rhetTotal >= 1) {
        const top = Object.entries(features.rhetorical).sort((a, b) => b[1] - a[1])[0][0];
        push('rhetoric', `反问:${top}`, `用「${top}」把判断交给对方接话，制造互动而不是下结论`, evidence(top, sentences), 0.3 + Math.min(0.3, rhetTotal * 0.1));
    }

    // 10) 人称/称呼
    const second = features.person.second;
    if (second >= 3 && second / Math.max(1, features.person.first + 1) > 0.6) {
        push('address', '第二人称', `直接对读者说「你」，把说明变成对话`, evidence('你', sentences), 0.35);
    }

    // 11) 标点习惯
    if (features.punctuation.ellipsis >= 2) {
        push('punctuation', '省略号', `用省略号拖住语气，表示未尽、迟疑或留白`, pickSentenceWith(sentences, '…'), 0.35);
    }
    if (features.punctuation.dash >= 2) {
        push('punctuation', '破折号插入', `用破折号在句中插入补充说明，口语感强`, pickSentenceWith(sentences, '—'), 0.35);
    }
    if (features.punctuation.paren >= 3) {
        push('punctuation', '括号旁白', `用括号塞进旁白式补充，像是顺口加的注解`, pickSentenceWith(sentences, '（'), 0.33);
    }
    if (features.punctuation.question >= 2 && features.dialogueRatio < 0.15) {
        push('punctuation', '设问', `用问句制造停顿并自答，把叙述变成讲解`, pickSentenceWith(sentences, '？'), 0.32);
    }

    // 12) 讲解方式
    if (/可以把它(?:想|理解)成|简单说|通俗地|打个比方|也就是说|换句话说|本质上/iu.test(text)) {
        push('explain', '类比解释', `解释复杂概念时先给一个可想象的类比，再补机制`, pickSentenceWith(sentences, '想成') || pickSentenceWith(sentences, '也就是'), 0.42);
    }

    // 13) 文体与组织
    push('register', `文体|${register}`, `这段文本属于「${register}」，组织方式是${structureNote(features)}`, sentences[0] || '', 0.4);

    // 14) 开头方式（真实文本常见的切入方式）
    const first = sentences[0] || '';
    if (first.length >= 6) {
        const style = /[？?]$/.test(first) ? '以问句开场' : /^[「“"]/.test(first) ? '以对白开场' : /^\d/.test(first) ? '以数字/清单开场' : '以陈述句直接切入';
        push('opening', `开场|${register}`, `${style}，不铺垫背景`, first, 0.3);
    }

    return out;
}

function structureNote(features) {
    const bits = [];
    if (features.paragraphs >= 5) bits.push('分段多、段落短');
    else if (features.paragraphs <= 2) bits.push('整篇少分段');
    if (features.dialogueRatio > 0.2) bits.push('对白推进');
    if (features.punctuation.colon >= 3) bits.push('多用冒号引出内容');
    if (features.shortRatio > 0.45) bits.push('短句节奏');
    if (features.repeatedOpeners.length > 0) bits.push(`句首重复（「${features.repeatedOpeners[0][0]}」）`);
    return bits.join('、') || '平铺直叙';
}

function pickAlternating(sentences) {
    for (let i = 1; i < sentences.length; i += 1) {
        if (sentences[i].length <= 12 && sentences[i - 1].length >= 25) return `${truncate(sentences[i - 1], 70)} / ${sentences[i]}`;
    }
    return sentences[0];
}

function pickQuote(text) {
    const s = String(text ?? '');
    const re = /[「“"]([\s\S]{4,80}?)[」”"]/gu;
    let m;
    while ((m = re.exec(s))) {
        const inner = m[1].trim();
        if (inner.length < 6) continue;
        if (/^(我的|首页|登录|注册|更多|下载|设置|搜索|返回|分享|评论|收藏)$/u.test(inner)) continue;
        return m[0];
    }
    return '';
}

function pickSentenceWith(sentences, needle) {
    return sentences.find((s) => s.includes(needle)) || sentences[0] || '';
}

/** 给一段文本一个可读的特征摘要（存进探索记录/日记）。 */
export function summarizeFeatures(features) {
    return [
        `句数 ${features.sentences}`,
        `均长 ${features.sentenceMean}`,
        `短句 ${Math.round(features.shortRatio * 100)}%`,
        `对话 ${Math.round(features.dialogueRatio * 100)}%`,
        `语气词 ${totalOf(features.particles)}`,
        `连接词 ${totalOf(features.connectives)}`,
        `网络语 ${totalOf(features.slang)}`,
    ].join(' · ');
}

export function entropyOf(text) {
    const counts = Object.values(countOf(tokens(text)));
    return round(shannon(counts), 3);
}
