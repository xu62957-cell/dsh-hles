/**
 * 评论区引擎（4.0 核心）。
 *
 * 目标：拿到"真实人类在公共讨论区怎么写话"，并且**随机取样**（不是只取热门），
 * 只保存归纳出来的规律，不保存用户名、不留原文整段。
 *
 * 现实约束：B站/抖音/快手/小红书/贴吧/知乎/NGA/V2EX 等平台在本机不可合法自动化
 * 访问（robots 全禁、403、或需登录），所以这个引擎面向的是"能服务端渲染评论的
 * 公开页面"，并对任何页面做通用提取；取不到评论区时退回正文学习，不假装拿到了。
 */

import { countOccurrences, extractFeatures, extractPatterns, SLANG, FORUM_MARKERS } from './language.js';
import { splitSentences, cjkLen, oneLine, truncate, shannon, round } from './util.js';

const COMMENT_CLASS = /(?:^|[\s_-])(?:comment|reply|replies|post|message|floor|answer|talk|discuss)(?:[\s_-]|$)/i;
const NAV_LINE = /^(回复|点赞|举报|分享|收藏|展开|收起|查看全部|更多|登录|注册|关注|已关注|楼主|置顶|精华|热门|最新|上一页|下一页|\d+楼?|赞|踩|评论|转发|@.*)$/u;

/** 评论类型（12 类，4.0 §3.3）。 */
export const COMMENT_TYPES = [
    '普通聊天', '幽默调侃', '日常吐槽', '情绪宣泄', '认真讨论', '观点争论',
    '知识交流', '生活分享', '游戏交流', '兴趣讨论', '技术讨论', '网络玩梗',
];

const TYPE_MARKERS = {
    普通聊天: ['哈哈', '嗯', '啊', '在吗', '是吗', '真的', '我觉得', '你们', '兄弟们', '路过'],
    幽默调侃: ['笑死', '绷不住', '哈哈哈', '狗头', 'doge', '乐', '典', '逆天', '666', '整活', '乐子'],
    日常吐槽: ['无语', '离谱', '服了', '吐槽', '难绷', '受不了', '什么玩意', '就这', '难评'],
    情绪宣泄: ['烦死', '气死', '难受', '哭了', '破防', 'emo', '救命', '崩溃', '急', '我人麻了'],
    认真讨论: ['因为', '所以', '其实', '我认为', '关键', '本质上', '问题在于', '从…来看', '数据'],
    观点争论: ['不是', '而是', '你确定', '有没有一种可能', '逻辑', '反驳', '先问', '不敢苟同', '站不住'],
    知识交流: ['指的是', '也就是', '原理', '定义', '参考文献', '出处', '据说', '科普', '来源'],
    生活分享: ['今天', '昨天', '最近', '我', '家里', '买了', '吃了', '去了', '感觉'],
    游戏交流: ['版本', '上分', '开黑', '抽卡', '副本', 'boss', '英雄', 'buff', '更新'],
    兴趣讨论: ['喜欢', '入坑', '推荐', '作品', '看完', '追', '同好', '安利'],
    技术讨论: ['代码', '报错', '接口', '部署', '依赖', '框架', '性能', '调试', '版本号'],
    网络玩梗: ['梗', '玩梗', '复读', '开香槟', '赢麻了', '典中典', '急了', '急了急了', '打起来'],
};

/** 把一段评论文本归到 12 类里（取分最高）。 */
export function classifyComment(text) {
    const s = String(text ?? '');
    if (s.length < 2) return { type: '普通聊天', score: 0 };
    let best = '普通聊天';
    let bestScore = 0;
    for (const [type, words] of Object.entries(TYPE_MARKERS)) {
        let score = 0;
        for (const w of words) {
            if (w.includes('…')) {
                if (s.includes('从') && s.includes('来看')) score += 1;
                continue;
            }
            score += countOccurrences(s, w);
        }
        if (s.includes('？') || s.includes('?')) score += type === '观点争论' ? 1 : 0.2;
        if (s.length <= 12) score += type === '网络玩梗' || type === '日常吐槽' ? 0.4 : 0;
        if (score > bestScore) {
            bestScore = score;
            best = type;
        }
    }
    return { type: best, score: round(bestScore, 2) };
}

/** 在 HTML 里按 class 找重复块，抽出候选评论。 */
export function extractCommentBlocks(html, { limit = 400 } = {}) {
    const text = String(html ?? '');
    if (!text) return { comments: [], strategy: 'none', totalHint: 0 };
    const totalHint = (() => {
        const m = /(?:共|全部|查看)?\s*([0-9]{1,6})\s*(?:条|个)\s*(?:评论|回复|跟贴|留言)/u.exec(text.replace(/<[^>]+>/g, ' '));
        return m ? Number(m[1]) : 0;
    })();
    // 统计出现的 class 名
    const classes = new Map();
    for (const m of text.matchAll(/class="([^"]{2,200})"/gu)) {
        for (const cls of m[1].split(/\s+/u)) {
            if (!COMMENT_CLASS.test(cls)) continue;
            classes.set(cls, (classes.get(cls) || 0) + 1);
        }
    }
    const ranked = [...classes.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 4);
    for (const [cls] of ranked) {
        const blocks = [];
        const parts = text.split(new RegExp(`class="[^"]*${escapeRe(cls)}[^"]*"`, 'u'));
        for (let i = 1; i < parts.length; i += 1) {
            const seg = parts[i].slice(0, 4000);
            const end = seg.search(/<div class="|<li class="|<\/body>/u);
            const chunk = end > 20 ? seg.slice(0, end) : seg.slice(0, 1500);
            const plain = oneLine(chunk.replace(/<script[\s\S]*?<\/script>/gu, ' ').replace(/<[^>]+>/gu, ' ')).trim();
            if (!plain) continue;
            if (NAV_LINE.test(plain)) continue;
            if (cjkLen(plain) < 4) continue;
            if (plain.length > 700) continue;
            blocks.push(plain);
        }
        const unique = dedupe(blocks);
        if (unique.length >= 3) {
            return { comments: unique.slice(0, limit).map((t, i) => ({ text: t, pos: i })), strategy: `class:${cls}`, totalHint };
        }
    }
    return { comments: [], strategy: 'none', totalHint };
}

/** 评论取样：位置随机，避免只看热门/高赞。 */
export function sampleComments(comments, n = 30, rand = Math.random) {
    const list = Array.isArray(comments) ? comments : [];
    if (list.length <= n) return list.slice();
    const picked = new Set();
    const out = [];
    let guard = 0;
    while (out.length < n && guard < n * 30) {
        guard += 1;
        const i = Math.floor(rand() * list.length);
        if (picked.has(i)) continue;
        picked.add(i);
        out.push(list[i]);
    }
    // 伪随机/退化随机数取不满时，按顺序补齐，保证取样数量稳定
    for (let i = 0; i < list.length && out.length < n; i += 1) {
        if (picked.has(i)) continue;
        picked.add(i);
        out.push(list[i]);
    }
    // 保底：至少带上首尾各一条，其余仍是随机位置
    if (list.length && !picked.has(0)) out.push(list[0]);
    if (list.length > 1 && !picked.has(list.length - 1)) out.push(list[list.length - 1]);
    return out;
}

/** 评论语料的整体特征 + 12 类分布。 */
export function commentFeatures(comments) {
    const list = (comments || []).map((c) => (typeof c === 'string' ? { text: c } : c)).filter((c) => c.text);
    const texts = list.map((c) => c.text);
    const joined = texts.join('\n');
    const types = {};
    for (const c of list) {
        const { type } = classifyComment(c.text);
        types[type] = (types[type] || 0) + 1;
    }
    const lens = texts.map((t) => cjkLen(t) || t.length);
    const dist = Object.values(types);
    return {
        count: list.length,
        meanLen: round(lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length), 1),
        shortRatio: round(texts.filter((t) => (cjkLen(t) || t.length) <= 12).length / Math.max(1, texts.length), 3),
        types,
        typeDiversity: round(shannon(dist), 3),
        features: extractFeatures(joined),
        slang: SLANG.filter((w) => joined.includes(w)),
        hasMarkers: FORUM_MARKERS.filter((w) => joined.includes(w)),
    };
}

/** 从评论语料里归纳表达规律（这是 4.0 最核心的产出）。 */
export function patternsFromComments({ comments, meta = {}, features = null, settings = null }) {
    const list = (comments || []).map((c) => (typeof c === 'string' ? { text: c } : c)).filter((c) => c.text);
    if (list.length < 5) return [];
    const f = features || commentFeatures(list);
    const joined = list.map((c) => c.text).join('\n');
    const out = [];
    const push = (kind, category, key, pattern, example, confidence) => {
        out.push({
            kind, category, key,
            pattern,
            example: truncate(example || '', 150),
            register: '评论区',
            lang: 'zh',
            domain: meta.domain || '未分类',
            sourceUrl: meta.url || '',
            site: meta.site || '',
            confidence: Math.min(0.92, Math.max(0.25, confidence)),
        });
    };
    const on = (name) => !settings || settings.learn?.[name] !== false;
    const find = (re) => list.find((c) => re.test(c.text))?.text || '';

    // 1) 短评文化
    if (on('colloquial') && f.shortRatio >= 0.35) {
        push('rhythm', '中文口语', '评论|短评', `评论区大量使用短评（≤12 字占 ${Math.round(f.shortRatio * 100)}%），一句话把态度说完`, find(/.{2,12}/u), 0.4 + Math.min(0.3, f.shortRatio));
    }
    // 2) 网络流行语
    if (on('internet') && f.slang.length) {
        for (const term of f.slang.slice(0, 3)) {
            push('slang', '网络流行语', `流行语:${term}`, `社区里用「${term}」表达态度，通常直接嵌在句子里，不需要解释`, find(new RegExp(escapeRe(term), 'u')), 0.42);
        }
    }
    // 3) 玩梗/复读
    const meme = list.find((c) => /(复读|典中典|赢麻|开香槟|急了|打起来|绷|梗)/u.test(c.text));
    if (on('humor') && meme) {
        push('meme', '网络玩梗', '玩梗|复读', '用短句复读或接梗参与讨论，不追求信息量，追求"在场感"', meme.text, 0.4);
    }
    // 4) 反驳/质疑的三段式
    const rebut = list.find((c) => /(有没有一种可能|不是.{0,6}而是|你确定|先问|不敢苟同|逻辑|站不住|笑死)/u.test(c.text));
    if (on('dialogue') && rebut) {
        push('debate', '争论反驳', '反驳|先接再转', '反驳时先接住对方一句，再用「不是…而是…/有没有一种可能…」把话头转走，语气不升高', rebut.text, 0.42);
    }
    // 5) 接话
    const replyMarker = list.find((c) => /(楼上|前面|同意|补充|回复|刚想说|同问|插眼)/u.test(c.text));
    if (on('dialogue') && replyMarker) {
        push('forum', '对话接续', '接话|接上一楼', '接话常用「楼上/前面说得」定位对象，再说自己的补充，避免重复原文', replyMarker.text, 0.4);
    }
    // 6) 情绪宣泄
    const emo = list.find((c) => /(烦死|气死|难受|破防|崩溃|哭了|救命|麻了)/u.test(c.text));
    if (on('emotion') && emo) {
        push('emotion', '情绪表达', '情绪|直说', '情绪上头时不绕弯子，直接用「烦死/破防/麻了」这类词，句尾常带感叹', emo.text, 0.4);
    }
    // 7) 生活分享
    const life = list.find((c) => /^(今天|昨天|最近|刚刚|前天|上周)/u.test(c.text) && (cjkLen(c.text) || c.text.length) > 20);
    if (on('narrative') && life) {
        push('narrative', '日常叙述', '分享|时间开头', '分享经历时用时间词直接开头（今天/昨天/最近），先给场景再给感受', life.text, 0.38);
    }
    // 8) 认真讨论
    const serious = list.find((c) => /(本质上|问题在于|我认为|关键|因为.{2,}所以)/u.test(c.text) && (cjkLen(c.text) || c.text.length) > 30);
    if (serious) {
        push('explain', '知识讲解', '讨论|给理由', '认真讨论时把判断和理由分开写：先给结论，再补「因为/问题在于」', serious.text, 0.4);
    }
    // 9) 类型分布（作为一条经验记录整体）
    const typeTop = Object.entries(f.types).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (typeTop.length) {
        push('register', '日常叙述', `评论类型|${typeTop.map(([k]) => k).join(',')}`,
            `公共讨论区里常见的三类声音：${typeTop.map(([k, n]) => `${k}(${Math.round((n / Math.max(1, f.count)) * 100)}%)`).join('、')}`,
            list[0].text, 0.42);
    }
    return out.filter((p) => p.pattern && p.example);
}

/** 流行语/口头禅候选：在评论里反复出现的 2–6 字片段（去掉常见虚词）。 */
export function trendCandidates(comments, { minHits = 3, limit = 12 } = {}) {
    const list = (comments || []).map((c) => (typeof c === 'string' ? c : c.text)).filter(Boolean);
    const counts = new Map();
    const STOP = /^(没有|一个|这个|那个|什么|怎么|因为|所以|就是|不是|可以|还是|但是|然后|现在|真的|感觉|知道|觉得|一样|已经|自己|时候|东西|问题|有点|这么|那么|我们|你们|他们|大家|什么|这里|那里|今天|昨天|最近|工作|公司|技术|开发|工程|前端|后端|经验|产品|项目|需求|业务|团队|代码|系统|数据|服务|平台|功能|版本|用户|时间|地方|方式|方面|情况|内容|部分|过程|结果|原因|方法|目标|能力|价值|机会|行业|市场|领域|经验)$/u;
    const MORPHEME = /[的了是在和与也就都还又很太更最吗呢吧啊]/u;
    const QUOTED = /[「『“"【]([^」』”"】]{2,10})[」』”"】]/gu;
    for (const text of list) {
        const clean = text.replace(/[^\u3400-\u9fff]/gu, '');
        for (let n = 2; n <= 4; n += 1) {
            for (let i = 0; i + n <= clean.length; i += 1) {
                const gram = clean.slice(i, i + n);
                if (STOP.test(gram)) continue;
                counts.set(gram, (counts.get(gram) || 0) + 1);
            }
        }
    }
    // 引号里被反复提到的说法优先
    const quoted = new Set();
    for (const text of list) {
        for (const m of String(text).matchAll(QUOTED)) quoted.add(m[1]);
    }
    return [...counts.entries()]
        .filter(([g, n]) => n >= minHits && !/^\d+$/u.test(g) && !MORPHEME.test(g))
        .filter(([g]) => quoted.has(g) || (g.length >= 3 && g.length <= 4) || /[A-Za-z]/.test(g))
        .sort((a, b) => b[1] * b[0].length - a[1] * a[0].length)
        .slice(0, limit)
        .map(([term, hits]) => ({ term, hits }));
}

function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function dedupe(list) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
        const key = item.replace(/\s+/gu, '');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}
