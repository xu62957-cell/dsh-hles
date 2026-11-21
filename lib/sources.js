/**
 * 探索源注册表：RSS/Atom 订阅源 + 可解析的公开入口页。
 *
 * 这些源都是"站点主动提供、允许自动化抓取"的公开入口（RSS 本就是给程序消费的）。
 * 每个源带领域标签与权重，但**领域顺序不固定** —— 选择由探索引擎的多样性管理器
 * 与随机数决定，不按列表顺序遍历。
 *
 * 本机网络实测（2026-11）：一批站点在本网络不可达（DNS 被投毒/超时），已剔除；
 * 运行时会继续按 failures 降权，失败源不会永久占坑。
 */

/** 领域分类表：只用关键词打分，不做固定顺序。 */
export const DOMAINS = {
    科学: ['研究', '科学', '实验', '论文', '发现', '科学家', '物理', '化学', '生物', 'study', 'research', 'science', 'physics', 'biology'],
    历史: ['历史', '朝代', '考古', '古代', '战争', '帝国', '历史学家', 'history', 'ancient', 'archaeology', 'empire'],
    地理: ['地理', '地图', '地形', '气候带', '国家', '山脉', '河流', 'geography', 'map', 'region'],
    文学: ['小说', '诗歌', '文学', '作家', '散文', '翻译', '叙事', 'novel', 'poem', 'literature', 'writer', 'fiction'],
    艺术: ['艺术', '绘画', '展览', '美术馆', '装置', '雕塑', 'art', 'painting', 'gallery', 'exhibition'],
    音乐: ['音乐', '专辑', '乐队', '歌手', '专辑', '演出', 'music', 'album', 'band', 'song'],
    影视: ['电影', '电视剧', '导演', '影片', '影评', '剧集', 'film', 'movie', 'cinema', 'director'],
    游戏: ['游戏', '玩家', '主机', '关卡', '电竞', 'game', 'gaming', 'player', 'console'],
    编程: ['代码', '编程', '开源', '框架', '函数', '编译器', '算法', 'code', 'programming', 'open source', 'framework', 'compiler'],
    数学: ['数学', '定理', '证明', '几何', '概率', 'math', 'theorem', 'proof', 'geometry'],
    天文: ['天文', '星系', '望远镜', '行星', '宇宙', 'astronomy', 'galaxy', 'telescope', 'planet', 'space'],
    气候: ['气候', '碳排', '变暖', '能源', '环保', 'climate', 'carbon', 'emission', 'energy'],
    动植物: ['动物', '植物', '物种', '生态', '进化', '鸟', 'animal', 'plant', 'species', 'ecology', 'evolution'],
    建筑: ['建筑', '设计', '空间', '城市', '材质', 'architecture', 'building', 'urban', 'design'],
    设计: ['设计', '排版', '字体', '颜色', '交互', 'design', 'typography', 'layout', 'interface'],
    体育: ['比赛', '球队', '运动员', '联赛', '赛季', 'sport', 'team', 'match', 'league', 'athlete'],
    教育: ['教育', '学校', '学生', '课程', '教师', 'education', 'school', 'student', 'course', 'teacher'],
    心理: ['心理', '情绪', '焦虑', '行为', '认知', 'psychology', 'emotion', 'anxiety', 'behavior', 'cognitive'],
    哲学: ['哲学', '伦理', '存在', '意识', '思想', 'philosophy', 'ethic', 'consciousness', 'thought'],
    社会文化: ['社会', '文化', '社区', '性别', '阶层', '习俗', 'society', 'culture', 'community', 'custom'],
    新闻: ['记者', '报道', '新闻', '事件', '官方', 'news', 'report', 'press', 'breaking'],
    生活: ['生活', '日常', '习惯', '家居', '收纳', 'life', 'daily', 'habit', 'home'],
    美食: ['美食', '菜谱', '食材', '烹饪', '味道', 'food', 'recipe', 'cook', 'ingredient'],
    旅行: ['旅行', '城市', '路线', '景点', '游记', 'travel', 'trip', 'journey', 'destination'],
    摄影: ['摄影', '镜头', '照片', '光线', '相机', 'photography', 'camera', 'lens', 'photo'],
    手工艺: ['手工', '木工', '编织', '制作', 'DIY', 'craft', 'make', 'workshop', 'build'],
    商业: ['公司', '市场', '商业', '创业', '投资', 'business', 'market', 'startup', 'company'],
    冷门爱好: ['收藏', '小众', '爱好者', '冷门', 'hobby', 'collect', 'niche', 'fan'],
    未分类: [],
};

/**
 * 订阅源。weight 只影响"随机挑选时的基础概率"，不决定顺序。
 * kind: rss = 订阅源（解析条目）；html = 入口页（抽取链接）。
 */
export const FEEDS = [
    // —— 英文 RSS ——
    { id: 'quanta', url: 'https://www.quantamagazine.org/feed/', domain: '科学', lang: 'en', kind: 'rss', weight: 1.2 },
    { id: 'sciencedaily', url: 'https://www.sciencedaily.com/rss/top/science.xml', domain: '科学', lang: 'en', kind: 'rss', weight: 1.1 },
    { id: 'physorg', url: 'https://phys.org/rss-feed/', domain: '科学', lang: 'en', kind: 'rss', weight: 1.0 },
    { id: 'nature', url: 'https://www.nature.com/nature.rss', domain: '科学', lang: 'en', kind: 'rss', weight: 1.2 },
    { id: 'newscientist', url: 'https://www.newscientist.com/feed/home/', domain: '动植物', lang: 'en', kind: 'rss', weight: 1.0 },
    { id: 'spacecom', url: 'https://www.space.com/feeds/all', domain: '天文', lang: 'en', kind: 'rss', weight: 0.9 },
    { id: 'carbonbrief', url: 'https://www.carbonbrief.org/feed/', domain: '气候', lang: 'en', kind: 'rss', weight: 0.9 },
    { id: 'smithsonian', url: 'https://www.smithsonianmag.com/rss/latest_articles/', domain: '历史', lang: 'en', kind: 'rss', weight: 1.0 },
    { id: 'npr', url: 'https://feeds.npr.org/1001/rss.xml', domain: '新闻', lang: 'en', kind: 'rss', weight: 0.8 },
    { id: 'lithub', url: 'https://lithub.com/feed/', domain: '文学', lang: 'en', kind: 'rss', weight: 1.0 },
    { id: 'hyperallergic', url: 'https://hyperallergic.com/feed/', domain: '艺术', lang: 'en', kind: 'rss', weight: 0.9 },
    { id: 'artforum', url: 'https://www.artforum.com/feed/', domain: '艺术', lang: 'en', kind: 'rss', weight: 0.8 },
    { id: 'pitchfork', url: 'https://pitchfork.com/feed/feed-news/rss', domain: '音乐', lang: 'en', kind: 'rss', weight: 0.9 },
    { id: 'stereogum', url: 'https://www.stereogum.com/feed/', domain: '音乐', lang: 'en', kind: 'rss', weight: 0.8 },
    { id: 'indiewire', url: 'https://www.indiewire.com/feed/', domain: '影视', lang: 'en', kind: 'rss', weight: 0.9 },
    { id: 'rps', url: 'https://www.rockpapershotgun.com/feed', domain: '游戏', lang: 'en', kind: 'rss', weight: 0.9 },
    { id: 'eurogamer', url: 'https://www.eurogamer.net/feed', domain: '游戏', lang: 'en', kind: 'rss', weight: 0.8 },
    { id: 'lwn', url: 'https://lwn.net/headlines/rss', domain: '编程', lang: 'en', kind: 'rss', weight: 1.0 },
    { id: 'rustblog', url: 'https://blog.rust-lang.org/feed.xml', domain: '编程', lang: 'en', kind: 'rss', weight: 0.9 },
    { id: 'githubblog', url: 'https://github.blog/feed/', domain: '编程', lang: 'en', kind: 'rss', weight: 0.8 },
    { id: 'soblog', url: 'https://stackoverflow.blog/feed/', domain: '编程', lang: 'en', kind: 'rss', weight: 0.8 },
    { id: 'msdev', url: 'https://devblogs.microsoft.com/feed', domain: '编程', lang: 'en', kind: 'rss', weight: 0.7 },
    { id: 'smashing', url: 'https://www.smashingmagazine.com/feed/', domain: '设计', lang: 'en', kind: 'rss', weight: 0.8 },
    { id: 'dezeen', url: 'https://www.dezeen.com/feed/', domain: '建筑', lang: 'en', kind: 'rss', weight: 0.9 },
    { id: 'petapixel', url: 'https://petapixel.com/feed/', domain: '摄影', lang: 'en', kind: 'rss', weight: 0.9 },
    { id: 'atlasobscura', url: 'https://www.atlasobscura.com/feeds/latest', domain: '旅行', lang: 'en', kind: 'rss', weight: 1.0 },
    { id: 'makezine', url: 'https://makezine.com/feed/', domain: '手工艺', lang: 'en', kind: 'rss', weight: 0.9 },
    { id: 'thekitchn', url: 'https://www.thekitchn.com/main.rss', domain: '美食', lang: 'en', kind: 'rss', weight: 0.9 },
    { id: 'espn', url: 'https://www.espn.com/espn/rss/news', domain: '体育', lang: 'en', kind: 'rss', weight: 0.6 },
    { id: 'skysports', url: 'https://www.skysports.com/rss/12040', domain: '体育', lang: 'en', kind: 'rss', weight: 0.6 },
    { id: 'insidehighered', url: 'https://www.insidehighered.com/rss.xml', domain: '教育', lang: 'en', kind: 'rss', weight: 0.8 },
    { id: 'dailynous', url: 'https://dailynous.com/feed/', domain: '哲学', lang: 'en', kind: 'rss', weight: 0.8 },
    { id: 'aeon', url: 'https://aeon.co/feed.rss', domain: '哲学', lang: 'en', kind: 'rss', weight: 1.0 },
    { id: 'gardenersworld', url: 'https://www.gardenersworld.com/feed/', domain: '动植物', lang: 'en', kind: 'rss', weight: 0.7 },
    { id: 'lifehacker', url: 'https://lifehacker.com/rss', domain: '生活', lang: 'en', kind: 'rss', weight: 0.7 },
    { id: 'lobsters', url: 'https://lobste.rs/rss', domain: '编程', lang: 'en', kind: 'rss', weight: 0.9 },
    { id: 'quantamath', url: 'https://www.quantamagazine.org/mathematics/feed/', domain: '数学', lang: 'en', kind: 'rss', weight: 0.8 },

    // —— 中文 RSS ——
    { id: 'solidot', url: 'https://www.solidot.org/index.rss', domain: '科学', lang: 'zh', kind: 'rss', weight: 1.2 },
    { id: 'sspai', url: 'https://sspai.com/feed', domain: '生活', lang: 'zh', kind: 'rss', weight: 1.1 },
    { id: 'ifanr', url: 'https://www.ifanr.com/feed', domain: '科学', lang: 'zh', kind: 'rss', weight: 0.9 },
    { id: '36kr', url: 'https://36kr.com/feed', domain: '商业', lang: 'zh', kind: 'rss', weight: 0.8 },
    { id: 'gcores', url: 'https://www.gcores.com/rss', domain: '游戏', lang: 'zh', kind: 'rss', weight: 1.0 },
    { id: 'ruanyifeng', url: 'https://www.ruanyifeng.com/blog/atom.xml', domain: '编程', lang: 'zh', kind: 'rss', weight: 1.0 },

    // —— 中文入口页（抽取链接） ——
    { id: 'guokr', url: 'https://www.guokr.com/', domain: '科学', lang: 'zh', kind: 'html', weight: 1.0 },
    { id: 'huanqiukexue', url: 'https://www.huanqiukexue.com/', domain: '科学', lang: 'zh', kind: 'html', weight: 0.9 },
    { id: 'kepu', url: 'https://www.kepu.net.cn/', domain: '科学', lang: 'zh', kind: 'html', weight: 0.8 },
    { id: 'lifeweek', url: 'https://www.lifeweek.com.cn/', domain: '社会文化', lang: 'zh', kind: 'html', weight: 0.9 },
    { id: 'jiemian', url: 'https://www.jiemian.com/', domain: '新闻', lang: 'zh', kind: 'html', weight: 0.8 },
    { id: 'infoq', url: 'https://www.infoq.cn/', domain: '编程', lang: 'zh', kind: 'html', weight: 0.9 },
    { id: 'oschina', url: 'https://www.oschina.net/news', domain: '编程', lang: 'zh', kind: 'html', weight: 0.8 },
    { id: 'csdn', url: 'https://blog.csdn.net/', domain: '编程', lang: 'zh', kind: 'html', weight: 0.6 },
    { id: 'allhistory', url: 'https://www.allhistory.com/', domain: '历史', lang: 'zh', kind: 'html', weight: 0.8 },
    { id: 'gushiwen', url: 'https://www.gushiwen.cn/', domain: '文学', lang: 'zh', kind: 'html', weight: 0.9 },
    { id: 'doubanmovie', url: 'https://movie.douban.com/', domain: '影视', lang: 'zh', kind: 'html', weight: 0.8 },
    { id: 'doubanmusic', url: 'https://music.douban.com/', domain: '音乐', lang: 'zh', kind: 'html', weight: 0.7 },
    { id: 'doubangroup', url: 'https://www.douban.com/group/explore', domain: '社会文化', lang: 'zh', kind: 'html', weight: 1.0 },
    { id: 'jiemodui', url: 'https://www.jiemodui.com/', domain: '教育', lang: 'zh', kind: 'html', weight: 0.8 },
    { id: 'jiandanxinli', url: 'https://www.jiandanxinli.com/', domain: '心理', lang: 'zh', kind: 'html', weight: 0.8 },
    { id: 'hupu', url: 'https://www.hupu.com/', domain: '体育', lang: 'zh', kind: 'html', weight: 0.7 },
    { id: 'sciencenet', url: 'https://www.sciencenet.cn/', domain: '科学', lang: 'zh', kind: 'html', weight: 0.7 },
    { id: 'chinanews', url: 'https://www.chinanews.com.cn/rss/', domain: '新闻', lang: 'zh', kind: 'html', weight: 0.6 },
];

/** HN 讨论区：公开 API，可直接拿到人类讨论文本（评论区语言样本）。 */
export const DISCUSSION_API = {
    hnFront: (n = 30) => `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${n}`,
    hnItem: (id) => `https://hn.algolia.com/api/v1/items/${id}`,
};

/** 按 id 找源。 */
export function findFeed(id) {
    return FEEDS.find((f) => f.id === id);
}

/** 领域关键词打分；score 相同取先出现的（表顺序仅作并列时的稳定排序）。 */
export function classifyDomain(text, fallback = '未分类') {
    const s = String(text ?? '').toLowerCase();
    if (!s.trim()) return fallback;
    let best = fallback;
    let bestScore = 0;
    for (const [domain, words] of Object.entries(DOMAINS)) {
        if (!words.length) continue;
        let score = 0;
        for (const w of words) {
            const needle = w.toLowerCase();
            let at = 0;
            let hits = 0;
            while (hits < 6) {
                const idx = s.indexOf(needle, at);
                if (idx < 0) break;
                hits += 1;
                at = idx + needle.length;
            }
            score += hits * (needle.length >= 4 ? 1.2 : 1);
        }
        if (score > bestScore) {
            bestScore = score;
            best = domain;
        }
    }
    return bestScore >= 2 ? best : fallback;
}

/** 所有领域名（供测试覆盖率统计用）。 */
export function domainNames() {
    return Object.keys(DOMAINS).filter((d) => d !== '未分类');
}
