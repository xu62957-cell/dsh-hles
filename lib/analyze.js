/**
 * 网页理解：不是抽关键词，而是按页面类型给出结构化的阅读结果。
 *
 * 输出：主题/领域、站点类型、组织方式、语言特征、要点、值得学的知识、
 * 存疑之处、可继续探索的方向。论坛、博客、新闻、小说、科普、评论区各有侧重。
 */

import { classifyDomain } from './sources.js';
import {
    classifyRegister, extractFeatures, extractPatterns, summarizeFeatures,
} from './language.js';
import { scanForInjection } from './injection.js';
import { cjkLen, oneLine, splitSentences, truncate, hostOf, round } from './util.js';

const NAV_WORDS = /^(首页|登录|注册|下载|关于|联系|更多|阅读全文|查看|返回|上一页|下一页|分享|评论|点赞|收藏|搜索|menu|home|login|more|read more|next|previous)$/iu;

/** 站点类型判定：URL 形态 + 文本里的自述标记。 */
export function siteTypeOf(url, text = '', title = '') {
    const host = hostOf(url);
    const s = `${title}\n${text}`.slice(0, 4000);
    if (/discuz|bbs\.|forum|community|group|tieba|reddit|discourse|hn\.algolia/iu.test(host)) return 'forum';
    if (/news|reuters|bbc|cnn|guardian|times|chinanews|thepaper|jiemian|npr|espn/iu.test(host)) return 'news';
    if (/wiki|baike|wikipedia|handwiki/iu.test(host) || /百科|维基/iu.test(title)) return 'wiki';
    if (/blog|csdn|medium|substack|juejin|cnblogs|ruanyifeng|dev\.to/iu.test(host) || /博客|blog/iu.test(title)) return 'blog';
    if (/(楼主|沙发|板凳|评论区|回复|楼中楼|@\w+)/u.test(s)) return 'forum';
    if (/(摘要|关键词|参考文献|doi|abstract|keywords)/iu.test(s)) return 'paper';
    if (/(记者|据新华社|报道称|发布会|通报)/u.test(s)) return 'news';
    if (/(第一章|第[一二三四五六七八九十]+回|他说|她低声|chapter)/iu.test(s)) return 'fiction';
    if (/(教程|快速开始|install|npm|代码块|function |import |class )/iu.test(s)) return 'technical';
    if (/(商品|价格|购物车|下单|优惠|￥|¥\d)/u.test(s)) return 'commerce';
    if (/(提问|回答|问题描述|最佳答案|问答)/u.test(s)) return 'qa';
    return 'article';
}

const TYPE_HINTS = {
    forum: '看人际互动：谁在回应谁、怎么接话、怎么反驳、幽默怎么用',
    blog: '看个人叙述：第一人称怎么讲经历、怎么把观点放进故事里',
    news: '看信息组织：导语怎么压缩事实、引语怎么放、背景怎么补',
    fiction: '看叙事：场景怎么调感官、对白怎么带情绪、留白放在哪里',
    paper: '看论证：问题—方法—结果怎么串，术语怎么被限定',
    technical: '看讲解：概念怎么拆步骤、示例怎么嵌进正文',
    wiki: '看定义：一句话概括加分层展开，中性语气',
    qa: '看问答：问题怎么被复述、答案怎么分情况',
    commerce: '看说服：卖点排序、形容词密度、行动号召',
    article: '看结构：开头怎么起、段落怎么推进、结尾怎么收',
};

// 只收"可检验的知识陈述"：定义、研究结论、机制说明；
// 叙事（他/那身影）、营销（加入我们/报名）、第二人称劝诱一律不要。
const DEFINITIONAL = [
    /(?:指的是|是指|定义为|被称为|被称为是|叫做|称为|又称)/u,
    /(研究表明|研究发现|数据显示|实验发现|调查显示|统计显示|研究显示|分析显示)/u,
    /(?:是一种|是一个|是一类|是由|指的是|本质上|其原理是|原理是)/u,
    /([A-Z][a-z]+(?:\s+[a-z]+){1,4})\s+(?:refers to|means|describes|is defined as)\s+([^.]{10,90})/u,
];
const REJECT_KNOWLEDGE = /(你|您|我们|咱们|大家|欢迎|报名|加入我们|招聘|简历|课程|活动|扫码|关注我们|点击|转发|购买|优惠|峰会|考察团|请联系|！|!|？|\?)/u;
const LEADING_NARRATIVE = /^(?:那|这|他|她|它|他们|她们|它们|那天|这时|当时|后来|于是|然后|我|咱|或|和|与|但|而|因此|所以|并且|同时|此外|另外)|^(?:you|we|i)\b/iu;

const UNSUPPORTED = [
    /(绝对是|百分之百|必然是|从来不会|永远不会|从来没有|无一例外|绝无例外|一定会)/u,
    /(据(?:说|传)|有人说|有消息称|听说)[^。！？]{4,40}/u,
    /(科学界公认|所有人都知道|毫无疑问地)/u,
];

/** 主分析入口。 */
export function analyzePage({ url, title, text, headings = [], links = [], sourceDomain = '', lang = 'zh' }) {
    const clean = String(text ?? '').trim();
    const site = hostOf(url);
    const siteType = siteTypeOf(url, clean, title);
    const injection = scanForInjection(clean);
    const features = extractFeatures(clean);
    const register = classifyRegister(features, clean);
    const domain = sourceDomain && sourceDomain !== '未分类' ? sourceDomain : classifyDomain(`${title} ${clean.slice(0, 1200)}`);
    const sentences = splitSentences(clean);
    const keyPoints = pickKeyPoints(sentences, 4);
    const knowledge = extractKnowledgeCandidates({ title, text: clean, domain, url, site, lang });
    const uncertainty = findUncertainty(sentences, 3);
    const nextDirections = pickNextDirections(links, 5);
    const structure = {
        paragraphs: features.paragraphs,
        sentences: features.sentences,
        headings: headings.length,
        hasList: /(^\s*[-*·•]|\n\d+[.、])/u.test(clean),
        hasQuote: features.quoted > 0,
        linkDensity: round(links.length / Math.max(1, features.paragraphs), 2),
    };
    const language = {
        register,
        siteType,
        focus: TYPE_HINTS[siteType] || TYPE_HINTS.article,
        features,
        summary: summarizeFeatures(features),
    };
    const boilerplate = JUNK_TITLE.test(oneLine(title)) || isBoilerplate(clean, features);
    const summary = buildSummary({ title, text: clean, siteType, register, domain, keyPoints });
    return {
        url, title, site, siteType, domain, register, lang,
        injection,
        structure,
        language,
        keyPoints,
        knowledge,
        uncertainty,
        nextDirections,
        summary,
        patterns: [],
        boilerplate,
        sampleable: !boilerplate && isSampleable(clean, features, injection),
    };
}

/** 语言采样门槛：太短、几乎全是链接/导航、或注入高危的页面不学表达。 */
export function isSampleable(text, features, injection) {
    if (injection?.blocked) return false;
    if (features.chars < 300) return false;
    if (features.sentences < 4) return false;
    // 导航/列表页的句子极短：真实散文的平均句长远高于此
    if (features.sentenceMean < 9) return false;
    const lines = String(text ?? '').split(/\n+/u).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return false;
    const navish = lines.filter((l) => NAV_WORDS.test(l)).length;
    if (navish > Math.max(3, features.sentences * 0.6)) return false;
    const shortLines = lines.filter((l) => l.length <= 8).length;
    if (shortLines / lines.length > 0.5) return false;
    return true;
}

/** 导航/登录/列表型页面的粗糙判定：短行占比过高、缺少成句表达。 */
export function isBoilerplate(text, features) {
    const lines = String(text ?? '').split(/\n+/u).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return true;
    // 成句太少：基本是导航/列表/按钮文字
    if (features.sentences < 4) return true;
    const short = lines.filter((l) => (l.length <= 10)).length;
    if (short / lines.length > 0.72 && features.sentences < 8) return true;
    // 去掉导航后仍然几乎没有内容
    if (features.chars < 180) return true;
    return false;
}

function pickKeyPoints(sentences, n) {
    const scored = [];
    for (const s of sentences) {
        const len = cjkLen(s) || s.length;
        if (len < 18 || len > 140) continue;
        let score = 0;
        if (/\d/u.test(s)) score += 1.2;
        if (/(因为|由于|导致|所以|意味着|表明|说明|发现)/u.test(s)) score += 1.5;
        if (/(研究|数据|实验|调查|报告)/u.test(s)) score += 1;
        if (/(应当|必须|建议|结论|关键)/u.test(s)) score += 1;
        score -= Math.min(1.5, (s.match(/[，,]/gu) || []).length * 0.15);
        scored.push({ s, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, n).map((x) => truncate(x.s, 150));
}

const BOILERPLATE_SENTENCE = /(reCAPTCHA|Privacy Policy|Terms of Service|privacy policy|terms of use|All rights reserved|cookie|Cookie|版权所有|©\d|订阅我们|关注我们|扫码|下载APP|点击查看|广告|登录后|注册后|京ICP|备案号|Your support is vital|last updated on|we use cookies)/iu;
const JUNK_TITLE = /^(privacy policy|terms(?: of (?:use|service))?|cookie policy|legal notice|support us|donate|about us|contact us|help center|帮助中心|用户协议|隐私政策|法律声明|社区指导原则|常见问题)/iu;

function extractKnowledgeCandidates({ title, text, domain, url, site, lang }) {
    const out = [];
    const sentences = splitSentences(text);
    for (const s of sentences) {
        const len = cjkLen(s) || s.length;
        if (len < 14 || len > 120) continue;
        if (BOILERPLATE_SENTENCE.test(s)) continue;
        if (REJECT_KNOWLEDGE.test(s) || LEADING_NARRATIVE.test(s)) continue;
        // 必须是完整陈述句（以句号/问号/感叹号收尾），不要列表残片
        if (!/[。！？.!?]$/u.test(s.trim())) continue;
        // 全英文句子只在英文站点收，且必须超过 30 个字符（避免按钮文案）
        if (!/[\u4e00-\u9fff]/u.test(s) && (lang !== 'en' || s.length < 30)) continue;
        for (const re of DEFINITIONAL) {
            if (!re.test(s)) continue;
            const statement = oneLine(s);
            out.push({
                statement,
                topic: topicOf(title, statement),
                domain,
                sourceUrl: url,
                site,
                lang,
                confidence: 0.35 + (/(研究|实验|数据|显示|发现)/u.test(s) ? 0.08 : 0) + (len <= 60 ? 0.04 : 0),
            });
            break;
        }
        if (out.length >= 6) break;
    }
    return out;
}

function findUncertainty(sentences, n) {
    const out = [];
    for (const s of sentences) {
        if (cjkLen(s) < 8) continue;
        for (const re of UNSUPPORTED) {
            if (!re.test(s)) continue;
            out.push({ claim: truncate(s, 120), why: re === UNSUPPORTED[0] ? '绝对化表述，缺少限定' : '转述/传闻，缺少来源' });
            break;
        }
        if (out.length >= n) break;
    }
    return out;
}

function pickNextDirections(links, n) {
    return links
        .filter((l) => l.anchor && !NAV_WORDS.test(l.anchor))
        .filter((l) => (cjkLen(l.anchor) >= 4 || l.anchor.length >= 10))
        .slice(0, n)
        .map((l) => ({ anchor: truncate(l.anchor, 40), url: l.url }));
}

function topicOf(title, statement) {
    const t = oneLine(title);
    if (t.length >= 4 && t.length <= 60) return truncate(t, 60);
    return truncate(statement, 40);
}

function buildSummary({ title, text, siteType, register, domain, keyPoints }) {
    const head = oneLine(title) || '（无标题）';
    const first = keyPoints[0] || truncate(firstInformative(text), 100);
    return truncate(`${head}｜${domain}/${siteType}/${register}｜${first}`, 320);
}

function firstInformative(text) {
    const sentences = splitSentences(text);
    for (const s of sentences) if ((cjkLen(s) || s.length) >= 20) return s;
    return text.slice(0, 100);
}

/** 从正文里取语言规律（带解析结果复用）。 */
export function analyzeLanguage({ text, features, meta }) {
    return extractPatterns({ features, text, meta });
}
