/**
 * 反 AI 机械化表达检测（15 类现象）。
 *
 * 设计原则：
 *   - 每条规则都必须能在文本里指出具体位置，不做"感觉像 AI"的黑箱打分；
 *   - 短回答不参评（20 字的回复本来就该是完整句子，不该被扣分）；
 *   - 检测的是"密度/重复/模板"，不是禁用词表 —— 一个词本身没有错，
 *     错的是每次都这么用。
 */

import { splitSentences, splitParagraphs, stddev, mean, cjkLen, shannon, truncate } from './util.js';

const MIN_EVAL_CHARS = 60;

/** 每条规则：lenGate 前面条数门限，weight 权重，check 返回命中样本数组。 */
const RULES = [
    {
        code: 'repeated-sentence',
        name: '固定句式重复',
        weight: 8,
        gate: (t) => t.length >= 150,
        check(analyze) {
            const hits = analyze.repeatedBigrams.filter(([, n]) => n >= 4).slice(0, 3);
            return hits.map(([gram, n]) => `「${gram}」重复 ${n} 次`);
        },
    },
    {
        code: 'fixed-opening',
        name: '固定开头',
        weight: 6,
        gate: (t) => t.length >= 40,
        check(analyze) {
            const first = analyze.sentences[0] || '';
            const patterns = [/^(首先|第一|总的来说|综上所述|在这个|众所周知|需要指出的是|在当今)/u, /^(In today'?s|In conclusion|It is important to note)/iu];
            return patterns.some((re) => re.test(first)) ? [truncate(first, 50)] : [];
        },
    },
    {
        code: 'over-summary',
        name: '过度使用总结',
        weight: 7,
        gate: (t) => t.length >= 120,
        check(analyze) {
            const tail = analyze.sentences.slice(-3).join(' ');
            const hits = [/(综上所述|总而言之|总的来说|综上|总之)/u, /(希望(?:这|以上)?(?:能|可以)?(?:对你)?(?:有所)?帮助)/u, /(如需|如果需要)(?:更多|进一步)/u]
                .filter((re) => re.test(tail)).map((re) => truncate((tail.match(re) || [])[0], 40));
            return hits;
        },
    },
    {
        code: 'connective-overuse',
        name: '过度使用转折词',
        weight: 6,
        gate: (t) => t.length >= 120,
        check(analyze) {
            const total = Object.values(analyze.connectives).reduce((a, b) => a + b, 0);
            const density = total / (analyze.chars / 100);
            if (density <= 1.6) return [];
            const top = Object.entries(analyze.connectives).sort((a, b) => b[1] - a[1]).slice(0, 3);
            return [`连接词密度 ${density.toFixed(1)}/百字：${top.map(([w, n]) => `${w}×${n}`).join('、')}`];
        },
    },
    {
        code: 'gratuitous-list',
        name: '不必要的分点罗列',
        weight: 7,
        gate: (t) => t.length <= 420,
        check(analyze) {
            const lines = analyze.text.split(/\n/u).filter((l) => /^\s*(?:[-*·•]|\d+[.、)]|[第一二三四五]、)/u.test(l));
            const shortLines = lines.filter((l) => cjkLen(l) < 18);
            if (lines.length < 3 || shortLines.length < 2) return [];
            return [`${lines.length} 条短分点（${shortLines.length} 条不足 18 字）：${truncate(shortLines[0], 30)}`];
        },
    },
    {
        code: 're-explaining',
        name: '反复解释已知内容',
        weight: 6,
        gate: (t) => t.length >= 120,
        check(analyze) {
            const count = (text.match(/(也就是说|换句话说|就是说|这意味着|需要注意的是|简单来说|换言之)/gu) || []).length;
            return count >= 3 ? [`复述/转述标记 ${count} 次`] : [];
        },
    },
    {
        code: 'template-comfort',
        name: '模板化情绪安慰',
        weight: 8,
        gate: () => true,
        check(analyze) {
            const re = /(我理解你的感受|听起来你(?:很|非常)?|感到[^。，]{0,8}是(?:很)?正常的|这很正常|抱抱你|你已经很棒了)/gu;
            return [...analyze.text.matchAll(re)].slice(0, 3).map((m) => m[0]);
        },
    },
    {
        code: 'forced-empathy',
        name: '刻意制造共情',
        weight: 7,
        gate: () => true,
        check(analyze) {
            const re = /(我能感受到|我完全理解|我懂你|我站在你这边|请相信|我一直在这里|你不是一个人)/gu;
            return [...analyze.text.matchAll(re)].slice(0, 3).map((m) => m[0]);
        },
    },
    {
        code: 'awkward-transition',
        name: '不自然的过渡',
        weight: 5,
        gate: (t) => t.length >= 100,
        check(analyze) {
            const re = /(话虽如此|值得一提的是|不得不说|与此同时，|在此基础上|从另一个角度来看|不难发现)/gu;
            const hits = [...analyze.text.matchAll(re)].map((m) => m[0]);
            return hits.length >= 2 ? hits.slice(0, 3) : [];
        },
    },
    {
        code: 'over-parallel',
        name: '过度排比',
        weight: 6,
        gate: (t) => t.length >= 100,
        check(analyze) {
            // 连续三句以上出现相同句首（排比常见形态）
            const count = new Map();
            for (const s of analyze.sentences) {
                const open = s.slice(0, 4).replace(/[，。！？]/gu, '');
                if (!open) continue;
                count.set(open, (count.get(open) || 0) + 1);
            }
            const repeated = [...count.entries()].filter(([, n]) => n >= 3).map(([open, n]) => `句首「${open}」×${n}`);
            return repeated.slice(0, 2);
        },
    },
    {
        code: 'mechanical-ending',
        name: '机械化结尾',
        weight: 7,
        gate: (t) => t.length >= 30,
        check(analyze) {
            const tail = analyze.text.trim().slice(-80);
            const re = /(如果(?:你)?(?:还)?有其他(?:问题|需要)|欢迎随时(?:告诉|联系|提问)|希望(?:这|以上)|祝(?:你)?(?:一切顺利|生活愉快)|有任何问题随时)/gu;
            return [...tail.matchAll(re)].map((m) => m[0]);
        },
    },
    {
        code: 'over-polite',
        name: '过度使用客套话',
        weight: 5,
        gate: () => true,
        check(analyze) {
            const re = /(非常感谢|很高兴为您|不客气|请问还有什么|感谢您的(?:耐心|理解|支持)|辛苦您了)/gu;
            const hits = [...analyze.text.matchAll(re)].map((m) => m[0]);
            return hits.length >= 2 ? hits.slice(0, 3) : [];
        },
    },
    {
        code: 'uniform-complete',
        name: '过度完整的句式',
        weight: 6,
        gate: (t) => t.length >= 200,
        check(analyze) {
            if (analyze.sentences.length < 6) return [];
            const tooComplete = analyze.sentences.filter((s) => cjkLen(s) >= 22 || s.length >= 45).length;
            const fragments = analyze.sentences.filter((s) => cjkLen(s) <= 8).length;
            if (tooComplete / analyze.sentences.length > 0.85 && fragments === 0) {
                return [`${analyze.sentences.length} 句全部是长完整句，没有短句或省略`];
            }
            return [];
        },
    },
    {
        code: 'low-variation',
        name: '缺乏自然的语言变化',
        weight: 6,
        gate: (t) => t.length >= 200,
        check(analyze) {
            const sd = stddev(analyze.sentences.map((s) => cjkLen(s) || s.length));
            const openers = Object.values(analyze.openers || {});
            const openerEntropy = openers.length ? shannon(openers) : 1;
            if (sd < 5 && openerEntropy < 0.85) return [`句长标准差 ${sd.toFixed(1)}，句首熵 ${openerEntropy.toFixed(2)}`];
            return [];
        },
    },
    {
        code: 'register-mismatch',
        name: '不符合上下文的口语化表达',
        weight: 5,
        gate: (t) => t.length >= 80,
        check(analyze, context) {
            const formalRequest = /(报告|文档|方案|总结|代码|正式|评审|公文|合同|说明)/u.test(context || '');
            if (!formalRequest) return [];
            const colloquial = (analyze.text.match(/(吧|啊|呢|嘛|呗|哈|啦)/gu) || []).length;
            const slang = Object.keys(analyze.slang || {});
            if (colloquial >= 4 || slang.length) {
                return [`正式请求里出现 ${colloquial} 个语气词${slang.length ? `、网络语「${slang[0]}」` : ''}`];
            }
            return [];
        },
    },
];

/** 把正文预处理成规则要用的形状。 */
export function analyzeForChecks(text) {
    const clean = String(text ?? '').trim();
    const sentences = splitSentences(clean).filter((s) => s.length > 1);
    const chars = clean.replace(/\s+/gu, '').length;
    const openers = {};
    for (const s of sentences) {
        const key = s.slice(0, 2);
        openers[key] = (openers[key] || 0) + 1;
    }
    const bigramCounts = new Map();
    for (const s of sentences) {
        const compact = s.replace(/[，。！？、；：""''（）《》]/gu, '');
        for (let i = 0; i + 3 <= compact.length; i += 1) {
            const gram = compact.slice(i, i + 4);
            bigramCounts.set(gram, (bigramCounts.get(gram) || 0) + 1);
        }
    }
    const repeatedBigrams = [...bigramCounts.entries()].filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1]);
    return {
        text: clean,
        sentences,
        chars,
        paragraphs: splitParagraphs(clean).length,
        openers,
        repeatedBigrams,
        connectives: countWords(clean, ['但是', '然而', '不过', '因此', '所以', '此外', '另外', '与此同时', '总之', '而且', '而是', '首先', '其次', '最后']),
        slang: countWords(clean, ['yyds', '破防', '绝了', '离谱', '无语', '真香', '内卷', '躺平', 'emo', '绷不住']),
    };
}

function countWords(text, words) {
    const out = {};
    for (const w of words) {
        const n = (text.match(new RegExp(escapeRe(w), 'gu')) || []).length;
        if (n) out[w] = n;
    }
    return out;
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * @returns {{hits:Array, score:number, evaluated:boolean}}
 *   score 越高越机械（0-100）。
 */
export function detectAiTraits(text, { context = '' } = {}) {
    const analyze = analyzeForChecks(text);
    if (analyze.chars < MIN_EVAL_CHARS) {
        return { hits: [], score: 0, evaluated: false, note: `文本短于 ${MIN_EVAL_CHARS} 字，不参与机械化评分` };
    }
    const hits = [];
    let score = 0;
    for (const rule of RULES) {
        if (!rule.gate(analyze.text)) continue;
        let samples = [];
        try {
            samples = rule.check(analyze, context) || [];
        } catch {
            samples = [];
        }
        if (!samples.length) continue;
        score += rule.weight;
        hits.push({ code: rule.code, name: rule.name, weight: rule.weight, samples: samples.slice(0, 3) });
    }
    return { hits, score: Math.min(100, score), evaluated: true, analyze };
}
