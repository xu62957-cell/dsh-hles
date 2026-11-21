/**
 * 网页提示注入防御。
 *
 * 所有网页正文都被当作不可信输入。这里做静态扫描：命中高危模式时整页隔离，
 * 既不进知识库、也不进语言样本库，只在探索记录里留下"为什么被拦"。
 * 这是纯文本模式匹配，不可能覆盖全部变体 —— 因此它是第一道闸，
 * 不是"证明安全"的证书；真正的隔离来自流程：网页文本永远只作为数据分析，
 * 不会作为指令进入系统提示，也不会触发任何工具调用。
 */

const RULES = [
    { id: 'ignore-instructions', severity: 'high', re: /(ignore|disregard|forget)\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/iu },
    { id: 'ignore-instructions-zh', severity: 'high', re: /(忽略|无视|忘记|抛开)(以上|之前|前面|上述|所有)?(的)?(指令|提示|规则|设定|要求)/u },
    { id: 'system-prompt-theft', severity: 'high', re: /(system\s*prompt|系统提示词?|隐藏指令|初始设定).{0,20}(泄露|输出|告诉我|打印|reveal|show|print|leak)/iu },
    { id: 'role-override', severity: 'high', re: /(you are now|from now on you|act as|roleplay as).{0,40}(assistant|admin|developer|root|系统)/iu },
    { id: 'role-override-zh', severity: 'high', re: /(从现在(开始|起)|接下来)(你)?(是|扮演|作为).{0,20}(管理员|开发者|系统|assistant|ai助理)/u },
    { id: 'exfiltrate-credentials', severity: 'high', re: /(api[_\s-]?key|access[_\s-]?token|密码|密钥|凭证|credential).{0,30}(发送|上传|发送到|post|send|upload|发给我|告诉我)/iu },
    { id: 'run-command', severity: 'high', re: /(请|立即|马上)?(执行|运行|run|execute)\s*(以下|下面|这条)?\s*(命令|脚本|command|script|shell|bash)/iu },
    { id: 'tool-call-directive', severity: 'medium', re: /(调用|使用|use|call)\s*(工具|tool)\s*(写入|删除|发送|upload|write|delete|send)/iu },
    { id: 'chat-template-escape', severity: 'high', re: /(\[INST\]|<<SYS>>|<\|im_start\|>|<\|im_end\|>|<\|system\|>|<\|assistant\|>)/iu },
    { id: 'fake-role-marker', severity: 'medium', re: /^(system|assistant|developer)\s*[:：]/imu },
    { id: 'base64-blob', severity: 'medium', re: /(base64|payload)[^。\n]{0,20}[A-Za-z0-9+/]{120,}={0,2}/iu },
    { id: 'instruction-precedence', severity: 'high', re: /(以下|下面|this)[^，。\n]{0,4}(内容|文本|指令|prompt|content|instruction)s?[^，。\n]{0,10}(优先级|高于|覆盖|overrides?)\s*(你的|your)?\s*(系统|system)/iu },
    { id: 'data-exfil-url', severity: 'medium', re: /(把|将|send|post|upload)[^。\n]{0,40}(https?:\/\/[^\s]+)[^。\n]{0,20}(发送|上传|post|send)/iu },
    { id: 'prompt-leak-request', severity: 'medium', re: /(重复|复述|输出|print|repeat).{0,10}(你的|your).{0,10}(prompt|提示词|指令)/iu },
];

export function scanForInjection(text) {
    const s = String(text ?? '');
    if (!s) return { suspect: false, risk: 'none', hits: [] };
    const hits = [];
    for (const rule of RULES) {
        const m = rule.re.exec(s);
        if (!m) continue;
        const at = Math.max(0, m.index - 30);
        hits.push({
            rule: rule.id,
            severity: rule.severity,
            sample: s.slice(at, Math.min(s.length, at + 120)).replace(/\s+/gu, ' '),
        });
        if (hits.length >= 6) break;
    }
    const high = hits.filter((h) => h.severity === 'high').length;
    const medium = hits.filter((h) => h.severity === 'medium').length;
    const risk = high > 0 ? 'high' : medium > 0 ? 'medium' : 'none';
    return {
        suspect: risk !== 'none',
        risk,
        hits,
        blocked: high > 0,
        summary: hits.length ? hits.map((h) => h.rule).join(',') : '',
    };
}

/** 讨论区文本（HN 评论等）单独再扫一遍：短句里也可能夹带指令。 */
export function scanDiscussion(items) {
    let high = 0;
    const rules = new Set();
    for (const item of items || []) {
        const r = scanForInjection(item.text || '');
        if (r.risk === 'high') {
            high += 1;
            for (const h of r.hits) rules.add(h.rule);
        }
    }
    return { blocked: high > 0, highRiskItems: high, rules: [...rules] };
}
