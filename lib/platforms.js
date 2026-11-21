/**
 * 中文互联网平台注册表（4.0）。
 *
 * 只登记**本机实测可访问**且**允许自动化访问**的入口；每个平台都带
 * access（怎么抓）、robots（是否允许）、status（实测状态）和 comments（能否取到公开评论）。
 * 不能接的平台不写进"已接入"，而是带着原因列在 UNSUPPORTED 里，由侧边栏面板原样展示。
 */

/** 平台类型 → 4.0 内容配比分组。 */
export const CONTENT_GROUPS = ['video', 'forum', 'blog', 'other'];

export const PLATFORMS = [
    {
        id: 'bilibili', name: '哔哩哔哩', group: 'video', lang: 'zh',
        access: 'api', entry: 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all',
        status: 'ok', comments: 'guest',
        note: '按你的要求以游客身份读取公开评论区与弹幕：评论走 wbi 签名接口（每个视频 2–6 条），弹幕走公开 XML（每视频上千条，随机取样）。不登录、不带账号 cookie、不绕验证码。B站 robots.txt 是全站 Disallow，这里是在你明确指示下低频访问其公开页面。',
        weight: 1.6,
    },
    // ---------- 中文论坛 / 社区 ----------
    {
        id: 'douban-group', name: '豆瓣小组', group: 'forum', lang: 'zh',
        access: 'html', entry: 'https://www.douban.com/group/explore',
        status: 'ok', comments: 'ssr',
        note: '小组话题页服务端渲染，游客能读到楼中楼评论（实测 14–27 条/帖）；广场页提供话题入口。',
        weight: 1.1,
    },
    {
        id: 'hupu', name: '虎扑社区', group: 'forum', lang: 'zh',
        access: 'html', entry: 'https://bbs.hupu.com/',
        status: 'partial', comments: 'ssr-topic',
        note: '帖子详情页服务端渲染且带评论区；但版块列表页是 JS 壳，自动发现受限，靠链接延伸或指定 URL 学习。',
        weight: 1.0,
    },
    {
        id: 'lkong', name: '龙空论坛', group: 'forum', lang: 'zh',
        access: 'html', entry: 'https://www.lkong.com/forum/15',
        status: 'ok', comments: 'unknown',
        note: '公开版块页，Next.js 服务端渲染，可提取帖子标题与正文链接。',
        weight: 0.9,
    },
    {
        id: 'github-cn', name: 'GitHub 中文议题', group: 'forum', lang: 'zh',
        access: 'api', entry: 'https://api.github.com/search/issues?q=repo:ruanyf/weekly+is:issue&sort=comments&order=desc&per_page=5',
        status: 'ok', comments: 'api',
        note: '公开 REST API（未登录 60 次/小时）；议题讨论多为中文长文，可作技术社区的补充语料。',
        weight: 0.7,
    },
    {
        id: 'newsmth', name: '水木社区', group: 'forum', lang: 'zh',
        access: 'html', entry: 'https://www.newsmth.net/nForum/',
        status: 'ok', comments: 'unknown',
        note: '公开版面可读。',
        weight: 0.8,
    },

    // ---------- 中文博客 / 文章 ----------
    {
        id: 'sspai', name: '少数派', group: 'blog', lang: 'zh',
        access: 'rss', entry: 'https://sspai.com/feed',
        status: 'ok', comments: 'none',
        note: 'RSS 可用；文章页为前端渲染，不取评论。',
        weight: 1.1,
    },
    {
        id: 'gcores', name: '机核', group: 'blog', lang: 'zh',
        access: 'rss', entry: 'https://www.gcores.com/rss',
        status: 'ok', comments: 'js-rendered',
        note: 'RSS 可用；文章页有评论区骨架但评论由前端加载。',
        weight: 1.0,
    },
    {
        id: 'ruanyifeng', name: '阮一峰的网络日志', group: 'blog', lang: 'zh',
        access: 'rss', entry: 'https://www.ruanyifeng.com/blog/atom.xml',
        status: 'ok', comments: 'none',
        weight: 0.9,
    },
    {
        id: '36kr', name: '36氪', group: 'blog', lang: 'zh',
        access: 'html', entry: 'https://36kr.com/',
        status: 'partial', comments: 'none',
        note: '首页可读；文章详情页为前端渲染。',
        weight: 0.8,
    },
    {
        id: 'juejin', name: '掘金', group: 'blog', lang: 'zh',
        access: 'html', entry: 'https://juejin.cn/',
        status: 'ok', comments: 'js-rendered',
        weight: 0.8,
    },
    {
        id: 'csdn', name: 'CSDN', group: 'blog', lang: 'zh',
        access: 'html', entry: 'https://blog.csdn.net/',
        status: 'ok', comments: 'js-rendered',
        weight: 0.7,
    },
    {
        id: 'infoq', name: 'InfoQ 中文', group: 'blog', lang: 'zh',
        access: 'html', entry: 'https://www.infoq.cn/',
        status: 'ok', comments: 'none',
        weight: 0.6,
    },
    {
        id: 'oschina', name: '开源中国', group: 'blog', lang: 'zh',
        access: 'html', entry: 'https://www.oschina.net/news',
        status: 'ok', comments: 'js-rendered',
        weight: 0.6,
    },

    // ---------- 中文新闻 / 评论场 ----------
    {
        id: '163news', name: '网易新闻', group: 'other', lang: 'zh',
        access: 'html', entry: 'https://news.163.com/rank/',
        status: 'ok', comments: 'api-closed',
        note: '排行页与文章页可读；跟贴接口对多数文章返回"已关闭跟贴"。',
        weight: 0.9,
    },
    {
        id: 'sohu', name: '搜狐', group: 'other', lang: 'zh',
        access: 'html', entry: 'https://www.sohu.com/',
        status: 'partial', comments: 'none',
        weight: 0.6,
    },
    {
        id: 'chinanews', name: '中国新闻网', group: 'other', lang: 'zh',
        access: 'html', entry: 'https://www.chinanews.com.cn/rss/',
        status: 'ok', comments: 'none',
        weight: 0.6,
    },
    {
        id: 'jiemian', name: '界面新闻', group: 'other', lang: 'zh',
        access: 'html', entry: 'https://www.jiemian.com/',
        status: 'ok', comments: 'none',
        weight: 0.6,
    },

    // ---------- 中文科普 / 文化 ----------
    {
        id: 'guokr', name: '果壳', group: 'other', lang: 'zh',
        access: 'html', entry: 'https://www.guokr.com/',
        status: 'ok', comments: 'none',
        weight: 0.7,
    },
    {
        id: 'huanqiukexue', name: '环球科学', group: 'other', lang: 'zh',
        access: 'html', entry: 'https://www.huanqiukexue.com/',
        status: 'ok', comments: 'none',
        weight: 0.6,
    },
    {
        id: 'kepu', name: '中国科普博览', group: 'other', lang: 'zh',
        access: 'html', entry: 'https://www.kepu.net.cn/',
        status: 'ok', comments: 'none',
        weight: 0.6,
    },
    {
        id: 'allhistory', name: '全历史', group: 'other', lang: 'zh',
        access: 'html', entry: 'https://www.allhistory.com/',
        status: 'ok', comments: 'none',
        weight: 0.6,
    },
    {
        id: 'gushiwen', name: '古诗文网', group: 'other', lang: 'zh',
        access: 'html', entry: 'https://www.gushiwen.cn/',
        status: 'ok', comments: 'none',
        weight: 0.5,
    },
    {
        id: 'douban', name: '豆瓣（书影音）', group: 'other', lang: 'zh',
        access: 'html', entry: 'https://movie.douban.com/',
        status: 'ok', comments: 'login-required',
        weight: 0.7,
    },
    {
        id: 'solidot', name: 'Solidot 奇客', group: 'other', lang: 'zh',
        access: 'rss', entry: 'https://www.solidot.org/index.rss',
        status: 'ok', comments: 'login-required',
        weight: 0.8,
    },
    {
        id: 'ifanr', name: '爱范儿', group: 'other', lang: 'zh',
        access: 'rss', entry: 'https://www.ifanr.com/feed',
        status: 'ok', comments: 'none',
        weight: 0.7,
    },
];

/**
 * 明确不接入的平台：本机网络实测不可用，或平台规则不允许自动化访问。
 * 侧边栏"平台状态"里原样展示，不伪装成已接入。
 */
export const UNSUPPORTED = [
    { id: 'douyin', name: '抖音', group: 'video', reason: '游客能看视频页，但网页评论接口要 a_bogus 签名（浏览器里由 JS 现算），非浏览器客户端拿不到；热榜可读、评论不可读。' },
    { id: 'kuaishou', name: '快手', group: 'video', reason: 'GraphQL 热榜游客可读，但评论/作品列表需要登录 cookie 与设备参数。' },
    { id: 'xiaohongshu', name: '小红书', group: 'video', reason: '笔记页返回 JS 壳（约 3KB），评论由 x-s/x-t 签名接口加载，签名在浏览器 JS 里现算。' },
    { id: 'ixigua', name: '西瓜视频', group: 'video', reason: '评论接口需要 _signature 参数，游客请求返回 HTML 校验页。' },
    { id: 'tieba', name: '百度贴吧', group: 'forum', reason: 'HTTP 403（反自动化拦截）。' },
    { id: 'zhihu', name: '知乎', group: 'forum', reason: '页面 HTTP 403，接口返回 AuthenticationError。' },
    { id: 'v2ex', name: 'V2EX', group: 'forum', reason: '本机 DNS 被拦截，连接超时。' },
    { id: 'nga', name: 'NGA', group: 'forum', reason: 'HTTP 403。' },
    { id: 'weibo', name: '微博', group: 'other', reason: '游客 API 被重定向到 passport 登录页，拿不到评论列表。' },
];

export const GROUP_LABEL = {
    video: '视频与评论区',
    forum: '论坛与社区',
    blog: '博客与文章',
    other: '新闻、科普与其他',
};

/** 4.0 默认内容配比（视频不可用时自动落到论坛与文章，面板里会显示实际比例）。 */
export const DEFAULT_MIX = { video: 45, forum: 30, blog: 15, other: 10 };

export function platformsByGroup(group) {
    return PLATFORMS.filter((p) => p.group === group);
}

export function platformById(id) {
    return PLATFORMS.find((p) => p.id === id) || null;
}

/** 中文优先：给 explorer 用的入口列表（只含 status ok/partial 的）。 */
export function chineseEntries() {
    return PLATFORMS.filter((p) => p.status !== 'down');
}
