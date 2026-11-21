/* HLES 4.0 侧边栏控制面板：侧栏图标 + 独立管理页。所有按钮都连到 /api/dsh-hles/* 的真实实现。 */
window.__ModuleLoader__.load({
  id: 'dsh-hles',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const API = '/api/dsh-hles';

    /* ---------------- 数据小工具 ---------------- */
    async function api(path, options) {
      const res = await fetch(API + path, Object.assign({ credentials: 'same-origin', headers: { 'content-type': 'application/json' } }, options || {}));
      let body = null;
      try { body = await res.json(); } catch (_) { body = null; }
      if (!res.ok) throw new Error((body && body.error) || ('HTTP ' + res.status));
      return body;
    }
    const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('zh-CN') : (n == null ? '—' : String(n)));
    const time = (ts) => {
      if (!ts) return '还没跑过';
      const d = new Date(ts);
      const diff = Date.now() - ts;
      if (diff < 60_000) return '刚刚';
      if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前';
      if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前';
      return d.toLocaleString('zh-CN', { hour12: false });
    };

    /* ---------------- 基础控件 ---------------- */
    const S = {
      wrap: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'var(--dsw-font-family)' },
      head: { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px 10px', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
      title: { fontSize: 16, fontWeight: 600, letterSpacing: 0.2 },
      sub: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
      tabs: { display: 'flex', gap: 4, padding: '10px 16px', flexWrap: 'wrap', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
      tab: (on) => ({
        padding: '6px 12px', borderRadius: 999, fontSize: 13, cursor: 'pointer', border: '1px solid transparent',
        background: on ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
        color: on ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        fontWeight: on ? 600 : 400,
      }),
      body: { flex: 1, overflowY: 'auto', padding: '16px 20px 40px', display: 'flex', flexDirection: 'column', gap: 14 },
      card: { background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 'var(--dsw-radius-md, 10px)', padding: 14 },
      h3: { margin: '0 0 10px', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 },
      stat: { background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 8, padding: '10px 12px' },
      statN: { fontSize: 20, fontWeight: 650, lineHeight: 1.2 },
      statL: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginTop: 2 },
      row: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
      grow: { flex: 1, minWidth: 0 },
      btn: (kind) => ({
        padding: '7px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2)',
        background: kind === 'primary' ? 'var(--dsw-alias-button-primary-fill)' : 'var(--dsw-alias-bg-layer-2)',
        color: kind === 'primary' ? '#fff' : 'var(--dsw-alias-label-primary)',
      }),
      input: { width: 90, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', fontSize: 13 },
      chip: (tone) => ({
        display: 'inline-block', padding: '1px 7px', borderRadius: 999, fontSize: 11,
        background: tone === 'ok' ? 'var(--dsw-alias-interactive-bg-hover)' : 'var(--dsw-alias-bg-layer-3)',
        color: tone === 'ok' ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-tertiary)',
        border: '1px solid var(--dsw-alias-border-l1)',
      }),
      mono: { fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' },
      err: { color: '#d9534f', fontSize: 12 },
      note: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.6 },
    };

    function Btn(props) {
      const { children, kind, onClick, disabled } = props;
      return h('button', { style: Object.assign(S.btn(kind), disabled ? { opacity: 0.45, cursor: 'not-allowed' } : {}), onClick: disabled ? undefined : onClick }, children);
    }
    function Card(props) { return h('div', { style: S.card }, props.children); }
    function Stat(props) { return h('div', { style: S.stat }, h('div', { style: S.statN }, props.value), h('div', { style: S.statL }, props.label)); }
    function Toggle(props) {
      const on = !!props.on;
      return h('button', {
        onClick: () => props.onChange(!on),
        style: {
          width: 40, height: 22, borderRadius: 999, border: '1px solid var(--dsw-alias-border-l2)', cursor: 'pointer',
          background: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-2)', position: 'relative', flex: '0 0 auto',
        },
      }, h('span', {
        style: {
          position: 'absolute', top: 2, left: on ? 20 : 2, width: 16, height: 16, borderRadius: '50%',
          background: '#fff', transition: 'left .18s ease',
        },
      }));
    }
    function Field(props) {
      const { label, value, onChange, min, max, step } = props;
      return h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '6px 0' } },
        h('span', { style: { flex: 1 } }, label),
        h('input', {
          type: 'number', value, min, max, step: step || 1, style: S.input,
          onChange: (e) => onChange(Number(e.target.value)),
        }));
    }
    function Bar(props) {
      const pct = Math.max(0, Math.min(100, Number(props.value) || 0));
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' } },
        h('span', { style: { width: 92, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, props.label),
        h('div', { style: { flex: 1, height: 8, borderRadius: 999, background: 'var(--dsw-alias-bg-layer-3)', overflow: 'hidden' } },
          h('div', { style: { width: pct + '%', height: '100%', background: 'var(--dsw-alias-brand-primary)', borderRadius: 999 } })),
        h('span', { style: { width: 86, fontSize: 12, textAlign: 'right', color: 'var(--dsw-alias-label-tertiary)' } }, pct + '%'));
    }

    /* ---------------- 侧栏图标：对话气泡 + 进化符号 ---------------- */
    function EvolutionIcon() {
      return h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M3.5 5.5h17v10.2h-8.2L8 19.2v-3.5H3.5z', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }),
        h('path', { d: 'M7 14.2c1.6-4.2 2.9-6.3 4-6.3 1.2 0 1.2 2.4 2.4 2.4 1.1 0 2.3-1.6 3.6-4.8', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('circle', { cx: 16.9, cy: 5.5, r: 1.5, fill: 'currentColor' }));
    }

    /* ---------------- 面板 ---------------- */
    function Panel() {
      const [tab, setTab] = React.useState('overview');
      const [overview, setOverview] = React.useState(null);
      const [settings, setSettings] = React.useState(null);
      const [agents, setAgents] = React.useState(null);
      const [diary, setDiary] = React.useState(null);
      const [patterns, setPatterns] = React.useState(null);
      const [platforms, setPlatforms] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [msg, setMsg] = React.useState('');
      const [error, setError] = React.useState('');

      const toast = (t) => { setMsg(t); setError(''); setTimeout(() => setMsg(''), 4000); };
      const fail = (e) => { setError(e.message || String(e)); setMsg(''); };

      const loadOverview = () => api('/overview').then(setOverview).catch(fail);
      React.useEffect(() => { loadOverview(); }, []);
      React.useEffect(() => {
        if (tab === 'explore' || tab === 'overview') { const t = setInterval(loadOverview, 4000); return () => clearInterval(t); }
        return undefined;
      }, [tab]);
      React.useEffect(() => {
        if (tab === 'settings' && !settings) api('/settings').then((d) => setSettings(d.settings)).catch(fail);
        if (tab === 'agents' && !agents) api('/agents').then(setAgents).catch(fail);
        if (tab === 'diary' && !diary) api('/diary').then(setDiary).catch(fail);
        if (tab === 'patterns' && !patterns) api('/patterns').then(setPatterns).catch(fail);
        if (tab === 'platforms' && !platforms) api('/platforms').then(setPlatforms).catch(fail);
      }, [tab]);

      const control = async (action, extra) => {
        setBusy(action);
        try {
          const out = await api('/control', { method: 'POST', body: JSON.stringify(Object.assign({ action }, extra || {})) });
          toast(action === 'explore' || action === 'random' || action === 'comments'
            ? '探索完成：' + out.pages + ' 页（成功 ' + out.okCount + '）'
            : '操作完成：' + action);
          await loadOverview();
        } catch (e) { fail(e); } finally { setBusy(''); }
      };

      const saveSettings = async (patch) => {
        setBusy('save');
        try {
          const out = await api('/settings', { method: 'POST', body: JSON.stringify(patch) });
          setSettings(out.settings);
          toast('设置已保存');
          await loadOverview();
        } catch (e) { fail(e); } finally { setBusy(''); }
      };

      const tabBtn = (id, label) => h('button', { style: S.tab(tab === id), onClick: () => setTab(id) }, label);

      return h('div', { style: S.wrap },
        h('div', { style: S.head },
          h('div', { style: { color: 'var(--dsw-alias-brand-primary)', display: 'flex' } }, EvolutionIcon()),
          h('div', { style: S.grow },
            h('div', { style: S.title }, '语言进化'),
            h('div', { style: S.sub }, 'HLES 4.0 · 中文互联网语言经验 · 全局生效'))),
        h('div', { style: S.tabs },
          tabBtn('overview', '总览'), tabBtn('explore', '探索控制'), tabBtn('settings', '学习设置'),
          tabBtn('language', '语言学习'), tabBtn('agents', 'Agent 管理'), tabBtn('diary', '探索日记'),
          tabBtn('patterns', '语言经验'), tabBtn('data', '数据管理'), tabBtn('platforms', '平台状态')),
        h('div', { style: S.body },
          msg ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-brand-primary)' } }, msg) : null,
          error ? h('div', { style: S.err }, '出错了：' + error) : null,
          tab === 'overview' ? h(OverviewTab, { data: overview }) : null,
          tab === 'explore' ? h(ExploreTab, { data: overview, busy, control }) : null,
          tab === 'settings' ? h(SettingsTab, { settings, onChange: setSettings, onSave: saveSettings, busy }) : null,
          tab === 'language' ? h(LanguageTab, { settings, onChange: setSettings, onSave: saveSettings, busy }) : null,
          tab === 'agents' ? h(AgentsTab, { data: agents, setData: setAgents, fail, toast }) : null,
          tab === 'diary' ? h(DiaryTab, { data: diary }) : null,
          tab === 'patterns' ? h(PatternsTab, { data: patterns }) : null,
          tab === 'data' ? h(DataTab, { onDone: toast, fail }) : null,
          tab === 'platforms' ? h(PlatformsTab, { data: platforms }) : null));
    }

    function OverviewTab({ data }) {
      if (!data) return h('div', { style: S.note }, '加载中…');
      const s = data.stats || {};
      const d = data.discussions || {};
      return h(React.Fragment, null,
        h(Card, null,
          h('div', { style: S.grid },
            h(Stat, { value: data.version || '4.0.0', label: '版本' }),
            h(Stat, { value: data.running ? (data.paused ? '已暂停' : '探索中') : '空闲', label: '运行状态' }),
            h(Stat, { value: fmt(s.visits), label: '累计页面' }),
            h(Stat, { value: fmt(d.comments), label: '分析评论' }),
            h(Stat, { value: fmt(s.patterns), label: '语言规律' }),
            h(Stat, { value: (data.agents.enabled || 0) + ' / ' + (data.agents.total || 0), label: '接入 Agent' }),
            h(Stat, { value: s.sizeMB != null ? s.sizeMB + ' MB' : '—', label: '数据库' }),
            h(Stat, { value: time(data.lastRunAt), label: '最近学习' }))),
        h(Card, null, h('h3', { style: S.h3 }, '内容配比（目标 / 实际）'),
          (data.groups || []).map((g) => h(Bar, { key: g.group, label: g.label, value: g.target, hint: g.actual })),
          h('div', { style: S.note }, '实际比例取自已记录的访问分组；视频平台在本机不可合法访问时会自然落到论坛与文章。')),
        h(Card, null, h('h3', { style: S.h3 }, '经验分类'),
          h('div', { style: S.grid }, Object.entries(data.categories || {}).map(([k, v]) => h(Stat, { key: k, value: fmt(v), label: k })))),
        h(Card, null, h('h3', { style: S.h3 }, '调度'),
          h('div', { style: S.note }, '定时探索：' + (data.schedule && data.schedule.enabled ? '开启，每 ' + data.schedule.intervalMinutes + ' 分钟一轮' : '已关闭'))));
    }

    function ExploreTab({ data, busy, control }) {
      const [pages, setPages] = React.useState(6);
      return h(React.Fragment, null,
        h(Card, null, h('h3', { style: S.h3 }, '探索控制'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            h(Btn, { kind: 'primary', disabled: busy === 'start', onClick: () => control('start', { pages }) }, '开始后台探索'),
            h(Btn, { disabled: busy === 'pause', onClick: () => control('pause') }, '暂停'),
            h(Btn, { disabled: busy === 'resume', onClick: () => control('resume') }, '恢复'),
            h(Btn, { disabled: busy === 'stop', onClick: () => control('stop') }, '停止')),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 } },
            h(Btn, { disabled: !!busy, onClick: () => control('explore', { pages }) }, '单次探索'),
            h(Btn, { disabled: !!busy, onClick: () => control('random', { pages }) }, '随机探索'),
            h(Btn, { disabled: !!busy, onClick: () => control('comments', { pages }) }, '评论区探索'),
            h('span', { style: S.note }, '每次页数'),
            h('input', { type: 'number', min: 1, max: 20, value: pages, style: S.input, onChange: (e) => setPages(Number(e.target.value)) }))),
        h(Card, null, h('h3', { style: S.h3 }, '当前状态'),
          data ? h('div', { style: S.note },
            '运行：' + (data.running ? (data.paused ? '已暂停' : '探索中') : '空闲') + ' · 本轮已完成 ' + (data.pagesDone || 0) + ' 页 · 队列 ' + ((data.stats && data.stats.frontier) || 0) + ' 条') : h('div', { style: S.note }, '加载中…')));
    }

    function SettingsTab({ settings, onChange, onSave, busy }) {
      const [study, setStudy] = React.useState(null);
      const [minutes, setMinutes] = React.useState(10);
      const [studyError, setStudyError] = React.useState('');
      const [work, setWork] = React.useState(null);
      const [workScore, setWorkScore] = React.useState('');
      const [workSug, setWorkSug] = React.useState('');
      const [workBusy, setWorkBusy] = React.useState(false);
      const [workError, setWorkError] = React.useState('');
      const [dia, setDia] = React.useState(null);
      const [diaPrompt, setDiaPrompt] = React.useState('此时我正在跟你对话，如果我说：「我想把你配了」，你该怎么回复？');
      const [diaScore, setDiaScore] = React.useState('');
      const [diaSug, setDiaSug] = React.useState('');
      const [diaBusy, setDiaBusy] = React.useState(false);
      const [diaError, setDiaError] = React.useState('');
      const workIdRef = React.useRef(null);
      const diaIdRef = React.useRef(null);
      React.useEffect(() => {
        if (settings && Number(settings.studyMinutes) > 0) setMinutes(Number(settings.studyMinutes));
      }, [settings && settings.studyMinutes]);
      React.useEffect(() => {
        let alive = true;
        const tick = () => {
          api('/learn').then((d) => { if (alive) setStudy(d.study); }).catch(() => {});
        };
        tick();
        const timer = setInterval(tick, 1200);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      React.useEffect(() => {
        let alive = true;
        const tick = () => {
          api('/homework').then((d) => {
            if (!alive) return;
            setWork(d.latest || null);
            // 只有换成另一篇作业时才回填输入框，避免轮询把正在输入的建议冲掉
            const id = d.latest && d.latest.id ? d.latest.id : null;
            if (id !== workIdRef.current) {
              workIdRef.current = id;
              setWorkScore(d.latest && d.latest.score !== null && d.latest.score !== undefined ? String(d.latest.score) : '');
              setWorkSug(d.latest ? String(d.latest.suggestion || '') : '');
            }
          }).catch(() => {});
        };
        tick();
        const timer = setInterval(tick, 3000);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      const submitWork = async () => {
        if (!work || !work.id) return;
        setWorkBusy(true);
        setWorkError('');
        try {
          const d = await api('/homework', { method: 'POST', body: JSON.stringify({ action: 'review', id: work.id, score: workScore === '' ? null : Number(workScore), suggestion: workSug }) });
          setWork(d.homework);
          workIdRef.current = d.homework && d.homework.id ? d.homework.id : workIdRef.current;
        } catch (e) { setWorkError(e.message || String(e)); }
        setWorkBusy(false);
      };
      React.useEffect(() => {
        let alive = true;
        const tick = () => {
          api('/dialogue').then((d) => {
            if (!alive) return;
            setDia(d.latest || null);
            const id = d.latest && d.latest.id ? d.latest.id : null;
            if (id !== diaIdRef.current) {
              diaIdRef.current = id;
              setDiaScore(d.latest && d.latest.score !== null && d.latest.score !== undefined ? String(d.latest.score) : '');
              setDiaSug(d.latest ? String(d.latest.suggestion || '') : '');
            }
          }).catch(() => {});
        };
        tick();
        const timer = setInterval(tick, 3000);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      const askDialogue = async () => {
        setDiaBusy(true); setDiaError('');
        try {
          const d = await api('/dialogue', { method: 'POST', body: JSON.stringify({ action: 'ask', prompt: diaPrompt }) });
          setDia(d.dialogue);
          diaIdRef.current = d.dialogue && d.dialogue.id ? d.dialogue.id : null;
          setDiaScore(''); setDiaSug('');
        } catch (e) { setDiaError(e.message || String(e)); }
        setDiaBusy(false);
      };
      const submitDialogue = async () => {
        if (!dia || !dia.id) return;
        setDiaBusy(true); setDiaError('');
        try {
          const d = await api('/dialogue', { method: 'POST', body: JSON.stringify({ action: 'review', id: dia.id, score: diaScore === '' ? null : Number(diaScore), suggestion: diaSug }) });
          setDia(d.dialogue);
          diaIdRef.current = d.dialogue && d.dialogue.id ? d.dialogue.id : diaIdRef.current;
        } catch (e) { setDiaError(e.message || String(e)); }
        setDiaBusy(false);
      };
      const regenWork = async () => {
        setWorkBusy(true);
        setWorkError('');
        try {
          const d = await api('/homework', { method: 'POST', body: JSON.stringify({ action: 'generate' }) });
          setWork(d.homework);
          workIdRef.current = d.homework && d.homework.id ? d.homework.id : null;
          setWorkScore('');
          setWorkSug('');
        } catch (e) { setWorkError(e.message || String(e)); }
        setWorkBusy(false);
      };
      const startStudy = async () => {
        setStudyError('');
        try {
          const d = await api('/learn', { method: 'POST', body: JSON.stringify({ minutes: Number(minutes) || 10 }) });
          setStudy(d.study);
        } catch (e) { setStudyError(e.message || String(e)); }
      };
      const stopStudy = async () => {
        try {
          const d = await api('/learn', { method: 'POST', body: JSON.stringify({ action: 'stop' }) });
          setStudy(d.study);
        } catch (e) { setStudyError(e.message || String(e)); }
      };
      if (!settings) return h('div', { style: S.note }, '加载中…');
      const mix = settings.mix || {};
      const set = (patch) => onChange(Object.assign({}, settings, patch));
      const setMix = (k, v) => set({ mix: Object.assign({}, mix, { [k]: v }) });
      const st = study || { running: false, minutes: 0, pages: 0, comments: 0, patterns: 0, progress: 0, elapsedMs: 0, remainingMs: 0 };
      const pct = Math.round((Number(st.progress) || 0) * 100);
      const secs = Math.ceil((Number(st.remainingMs) || 0) / 1000);
      const mmss = Math.floor(secs / 60) + ' 分 ' + String(secs % 60).padStart(2, '0') + ' 秒';
      const pw = settings.platformWeights || {};
      const platformList = [['bilibili', '哔哩哔哩'], ['douban-group', '豆瓣小组'], ['hupu', '虎扑'], ['github-cn', 'GitHub 议题'], ['douban', '豆瓣']];
      const setPw = (k, v) => set({ platformWeights: Object.assign({}, pw, { [k]: v }) });
      const byP = st.byPlatform || {};
      const totalPages = Object.values(byP).reduce((n, x) => n + (Number(x.pages) || 0), 0);
      const shareText = totalPages
        ? platformList.map(([id, name]) => name + ' ' + Math.round(((byP[id] && byP[id].pages) || 0) * 100 / totalPages) + '%').join(' · ')
        : '还没学习过';
      return h(React.Fragment, null,
        h(Card, null,
          h('h3', { style: S.h3 }, '这次学习的作业'),
          work ? h('div', null,
            h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 } },
              work.status === 'writing' ? '正在写…'
                : work.status === 'reviewing' ? '正在写自我反思…'
                : work.status === 'failed' ? ('出错了：' + (work.error || '未知原因'))
                : work.status === 'done' ? ('已完成 · 得分 ' + (work.score === null ? '未打分' : work.score))
                : '等你打分和评价'),
            work.topic ? h('div', { style: { fontWeight: 600, margin: '6px 0' } }, work.topic) : null,
            work.content ? h('div', { style: { whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.7, maxHeight: 260, overflow: 'auto', padding: 8, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)' } }, work.content) : null,
            work.status === 'pending_review' ? h('div', { style: { marginTop: 8 } },
              h('div', { style: S.row }, h('span', { style: S.grow }, '打分（0–100）'),
                h('input', { type: 'number', min: 0, max: 100, value: workScore, style: S.input, onChange: (e) => setWorkScore(e.target.value) })),
              h('div', { style: { marginTop: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '老师的建议（可以不写）'),
              h('textarea', {
                value: workSug, rows: 3,
                style: { width: '100%', marginTop: 4, padding: 8, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit', fontSize: 13 },
                onChange: (e) => setWorkSug(e.target.value),
              }),
              h('div', { style: { marginTop: 8, display: 'flex', gap: 8 } },
                h(Btn, { kind: 'primary', disabled: workBusy, onClick: submitWork }, workBusy ? '提交中…' : '提交评价'),
                h(Btn, { disabled: workBusy, onClick: regenWork }, '重写一篇'))) : null,
            work.selfReview ? h('div', { style: { marginTop: 10, padding: 8, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)', fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap' } },
              h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '我的反思与复习'),
              work.selfReview) : null,
            work.status === 'failed' ? h('div', { style: { marginTop: 8 } }, h(Btn, { disabled: workBusy, onClick: regenWork }, '重写一篇')) : null)
            : h('div', { style: S.note }, '还没有作业。点上面的「开始学习」，学完会自动写一篇中文文章，等你打分。'),
          workError ? h('div', { style: S.err }, '出错了：' + workError) : null),
        h(Card, null,
          h('h3', { style: S.h3 }, '对话测试'),
          h('div', { style: S.note }, '作业完成之后进入这一阶段：写一句假设对话或场景，系统用积累的说话习惯回一句，你再打分。'),
          h('textarea', {
            value: diaPrompt, rows: 2,
            style: { width: '100%', marginTop: 6, padding: 8, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit', fontSize: 13 },
            onChange: (e) => setDiaPrompt(e.target.value),
          }),
          h('div', { style: { marginTop: 8 } },
            h(Btn, { kind: 'primary', disabled: diaBusy || (dia && dia.status === 'pending_review'), onClick: askDialogue }, diaBusy ? '生成中…' : '生成回复')),
          dia ? h('div', { style: { marginTop: 10 } },
            h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '老师的话：' + String(dia.prompt || '').slice(0, 80)),
            h('div', { style: { margin: '6px 0', padding: 8, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)', fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap' } }, dia.reply || '（还没有回复）'),
            dia.status === 'pending_review' ? h('div', null,
              h('div', { style: S.row }, h('span', { style: S.grow }, '打分（0–100）'),
                h('input', { type: 'number', min: 0, max: 100, value: diaScore, style: S.input, onChange: (e) => setDiaScore(e.target.value) })),
              h('div', { style: { marginTop: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '建议（可以不写）'),
              h('textarea', {
                value: diaSug, rows: 2,
                style: { width: '100%', marginTop: 4, padding: 8, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit', fontSize: 13 },
                onChange: (e) => setDiaSug(e.target.value),
              }),
              h('div', { style: { marginTop: 8 } }, h(Btn, { kind: 'primary', disabled: diaBusy, onClick: submitDialogue }, diaBusy ? '提交中…' : '提交评价'))) : null,
            dia.selfReview ? h('div', { style: { marginTop: 10, padding: 8, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)', fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap' } },
              h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '我的反思与复习'),
              dia.selfReview) : null,
            dia.status === 'failed' ? h('div', { style: S.err }, '出错了：' + (dia.error || '未知原因')) : null) : null,
          diaError ? h('div', { style: S.err }, '出错了：' + diaError) : null),
        h(Card, null,
          h('h3', { style: S.h3 }, '平台占比（学习时）'),
          h('div', { style: S.note }, '设为 0 表示这次不学该平台；不用凑满 100，按数值分配，学完会记录实际占比。'),
          platformList.map(([id, name]) => h(Field, {
            key: id, label: name, value: Number(pw[id]) || 0, min: 0, max: 100, step: 5,
            onChange: (v) => setPw(id, v),
          })),
          h('div', { style: { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '上次学习实际：' + shareText),
          totalPages ? h('div', { style: { marginTop: 6, display: 'flex', gap: 2, height: 8, borderRadius: 999, overflow: 'hidden', background: 'var(--dsw-alias-bg-layer-3)' } },
            platformList.map(([id, name]) => {
              const p = Math.round(((byP[id] && byP[id].pages) || 0) * 100 / totalPages);
              return p > 0 ? h('div', { key: id, title: name + ' ' + p + '%', style: { width: p + '%', height: '100%', background: 'var(--dsw-alias-brand-primary)', opacity: 0.9 } }) : null;
            })) : null),
        h(Card, null,
          h('h3', { style: S.h3 }, '学习一次'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 13 } }, '学习时长'),
            h('input', {
              type: 'number', min: 1, max: 120, value: minutes, style: S.input,
              onChange: (e) => setMinutes(Number(e.target.value)),
              disabled: st.running,
            }),
            h('span', { style: S.note }, '分钟'),
            h(Btn, { kind: 'primary', disabled: st.running, onClick: startStudy }, st.running ? '学习中…' : '开始学习'),
            st.running ? h(Btn, { onClick: stopStudy }, '停止') : null),
          h('div', { style: { marginTop: 10, height: 10, borderRadius: 999, background: 'var(--dsw-alias-bg-layer-3)', overflow: 'hidden' } },
            h('div', { style: { width: pct + '%', height: '100%', background: 'var(--dsw-alias-brand-primary)', transition: 'width .4s ease' } })),
          h('div', { style: { marginTop: 6, display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            h('span', null, st.running ? ('学习中 · 剩余 ' + mmss) : (st.pages ? ('上次学习：' + (st.minutes || 0) + ' 分钟') : '还没学习过')),
            h('span', null, (st.pages || 0) + ' 页 · ' + (st.comments || 0) + ' 条评论 · ' + (st.patterns || 0) + ' 条规律')),
          studyError ? h('div', { style: S.err }, '出错了：' + studyError) : null),
        h(Card, null, h('h3', { style: S.h3 }, '中文内容优先级'),
          h('div', { style: S.row }, h('span', { style: S.grow }, '优先探索中文内容'), h(Toggle, { on: settings.chinesePriority !== false, onChange: (v) => set({ chinesePriority: v }) }))),
        h(Card, null, h('h3', { style: S.h3 }, '内容配比（%）'),
          h(Field, { label: '视频平台与评论区', value: mix.video || 0, min: 0, max: 100, onChange: (v) => setMix('video', v) }),
          h(Field, { label: '论坛与社区', value: mix.forum || 0, min: 0, max: 100, onChange: (v) => setMix('forum', v) }),
          h(Field, { label: '博客与文章', value: mix.blog || 0, min: 0, max: 100, onChange: (v) => setMix('blog', v) }),
          h(Field, { label: '新闻科普与其他', value: mix.other || 0, min: 0, max: 100, onChange: (v) => setMix('other', v) })),
        h(Card, null, h('h3', { style: S.h3 }, '探索节奏'),
          h(Field, { label: '每轮页数', value: settings.pagesPerCycle || 6, min: 1, max: 20, onChange: (v) => set({ pagesPerCycle: v }) }),
          h(Field, { label: '每页评论采样数', value: settings.commentsPerPage || 30, min: 5, max: 80, onChange: (v) => set({ commentsPerPage: v }) }),
          h(Field, { label: '重复过滤（天）', value: settings.revisitCooldownDays || 3, min: 0, max: 30, onChange: (v) => set({ revisitCooldownDays: v }) }),
          h(Field, { label: '探索间隔（分钟）', value: (settings.schedule && settings.schedule.intervalMinutes) || 360, min: 5, max: 1440, onChange: (v) => set({ schedule: Object.assign({}, settings.schedule, { intervalMinutes: v }) }) }),
          h('div', { style: S.row }, h('span', { style: S.grow }, '定时探索'), h(Toggle, { on: !!(settings.schedule && settings.schedule.enabled), onChange: (v) => set({ schedule: Object.assign({}, settings.schedule, { enabled: v }) }) }))),
        h('div', null, h(Btn, { kind: 'primary', disabled: busy === 'save', onClick: () => onSave(settings) }, '保存设置')));
    }

    function LanguageTab({ settings, onChange, onSave, busy }) {
      if (!settings) return h('div', { style: S.note }, '加载中…');
      const learn = settings.learn || {};
      const inject = settings.inject || {};
      const setLearn = (k, v) => onChange(Object.assign({}, settings, { learn: Object.assign({}, learn, { [k]: v }) }));
      const setInject = (patch) => onChange(Object.assign({}, settings, { inject: Object.assign({}, inject, patch) }));
      const items = [
        ['colloquial', '日常口语学习'], ['internet', '网络语言学习'], ['humor', '幽默表达学习'],
        ['emotion', '情绪表达学习'], ['dialogue', '对话交流学习'], ['narrative', '叙事表达学习'],
        ['antiAi', '反 AI 机械化优化'],
      ];
      return h(React.Fragment, null,
        h(Card, null, h('h3', { style: S.h3 }, '学什么'),
          items.map(([k, label]) => h('div', { key: k, style: S.row }, h('span', { style: S.grow }, label), h(Toggle, { on: learn[k] !== false, onChange: (v) => setLearn(k, v) })))),
        h(Card, null, h('h3', { style: S.h3 }, '注入到 Agent'),
          h('div', { style: S.row }, h('span', { style: S.grow }, '全局注入（关闭后所有 Agent 都不再收到经验）'), h(Toggle, { on: inject.global !== false, onChange: (v) => setInject({ global: v }) })),
          h(Field, { label: '注入字数上限', value: inject.maxChars || 700, min: 200, max: 2000, step: 50, onChange: (v) => setInject({ maxChars: v }) }),
          h(Field, { label: '规律最少出现次数', value: inject.minHits || 2, min: 1, max: 10, onChange: (v) => setInject({ minHits: v }) }),
          h('div', { style: S.note }, '注入只加一段运行上下文，不改任何角色卡或预设文件。')),
        h('div', null, h(Btn, { kind: 'primary', disabled: busy === 'save', onClick: () => onSave(settings) }, '保存设置')));
    }

    function AgentsTab({ data, setData, fail, toast }) {
      if (!data) return h('div', { style: S.note }, '加载中…');
      const toggle = async (agent) => {
        try {
          const out = await api('/agents', { method: 'POST', body: JSON.stringify({ action: 'toggle', id: agent.id, enabled: !agent.enabled }) });
          setData(Object.assign({}, data, { agents: out.agents, stats: out.stats }));
          toast((agent.enabled ? '已关闭：' : '已启用：') + (agent.title || agent.id));
        } catch (e) { fail(e); }
      };
      const globalToggle = async (on) => {
        try {
          await api('/agents', { method: 'POST', body: JSON.stringify({ action: 'global', enabled: on }) });
          setData(Object.assign({}, data, { global: on }));
          toast(on ? '已开启全局注入' : '已关闭全局注入');
        } catch (e) { fail(e); }
      };
      return h(React.Fragment, null,
        h(Card, null, h('h3', { style: S.h3 }, '全局'),
          h('div', { style: S.row }, h('span', { style: S.grow }, '所有 Agent 自动接入（不改人格，只加语言能力）'), h(Toggle, { on: data.global !== false, onChange: globalToggle }))),
        h(Card, null, h('h3', { style: S.h3 }, '已接入的 Agent（' + (data.stats ? data.stats.enabled + ' 开 / ' + data.stats.disabled + ' 关' : '') + '）'),
          (data.agents || []).length === 0 ? h('div', { style: S.note }, '还没见过 Agent。打开任意会话后会自动登记。') :
            data.agents.map((a) => h('div', { key: a.id, style: S.row },
              h('div', { style: S.grow },
                h('div', { style: { fontSize: 13 } }, a.title || a.preset || a.id),
                h('div', { style: S.mono }, a.preset ? '预设：' + a.preset : '会话：' + a.id.slice(0, 18))),
              h('span', { style: S.chip(a.enabled ? 'ok' : '') }, a.enabled ? '已接入' : '已关闭'),
              h(Toggle, { on: a.enabled, onChange: () => toggle(a) })))),
        h('div', null, h(Btn, { onClick: () => api('/agents').then(setData).catch(fail) }, '刷新列表')));
    }

    function DiaryTab({ data }) {
      if (!data) return h('div', { style: S.note }, '加载中…');
      return h(React.Fragment, null,
        h(Card, null, h('h3', { style: S.h3 }, '最近讨论区'),
          (data.discussions || []).length === 0 ? h('div', { style: S.note }, '还没有抓到可解析的评论区。') :
            data.discussions.map((d) => h('div', { key: d.id, style: S.row },
              h('div', { style: S.grow }, h('div', { style: { fontSize: 13 } }, d.title || d.url), h('div', { style: S.mono }, d.platform + ' · ' + d.sampled + ' 条评论'))))),
        h(Card, null, h('h3', { style: S.h3 }, '语言趋势'),
          (data.trends || []).length === 0 ? h('div', { style: S.note }, '暂无。') :
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } }, data.trends.map((t) => h('span', { key: t.term, style: S.chip(t.hits > 2 ? 'ok' : '') }, t.term + ' ×' + t.hits)))),
        (data.diaries || []).map((d) => h(Card, { key: d.id },
          h('h3', { style: S.h3 }, '探索日记 · ' + new Date(d.at).toLocaleString('zh-CN', { hour12: false })),
          h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.7, margin: 0, color: 'var(--dsw-alias-label-secondary)' } }, d.body))));
    }

    function PatternsTab({ data }) {
      if (!data) return h('div', { style: S.note }, '加载中…');
      return h(React.Fragment, null,
        h(Card, null, h('h3', { style: S.h3 }, '分类统计'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } }, Object.entries(data.categories || {}).map(([k, v]) => h('span', { key: k, style: S.chip('ok') }, k + ' ' + v)))),
        (data.patterns || []).map((p) => h(Card, { key: p.id },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } },
            h('span', { style: S.chip('ok') }, p.category || p.kind),
            h('span', { style: S.sub }, '命中 ' + p.hits + ' · 置信 ' + p.confidence)),
          h('div', { style: { fontSize: 13, lineHeight: 1.6 } }, p.pattern),
          p.example ? h('div', { style: { ...S.mono, marginTop: 4 } }, '例：' + p.example) : null)));
    }

    function DataTab({ onDone, fail }) {
      const [scope, setScope] = React.useState('language');
      const run = async (action, extra) => {
        try {
          const out = await api('/data', { method: 'POST', body: JSON.stringify(Object.assign({ action }, extra || {})) });
          onDone(out.file ? '完成：' + out.file : '完成：' + action);
        } catch (e) { fail(e); }
      };
      return h(React.Fragment, null,
        h(Card, null, h('h3', { style: S.h3 }, '备份与导出'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h(Btn, { onClick: () => run('export') }, '导出全部经验 JSON'),
            h(Btn, { onClick: () => run('backup') }, '生成数据库快照'),
            h(Btn, { onClick: () => run('prune') }, '清理超限数据'),
            h(Btn, { onClick: () => run('vacuum') }, '压缩数据库'))),
        h(Card, null, h('h3', { style: S.h3 }, '删除学习记录'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            h('select', { value: scope, onChange: (e) => setScope(e.target.value), style: Object.assign({}, S.input, { width: 180 }) },
              [['language', '语言经验'], ['knowledge', '知识'], ['visits', '探索记录'], ['prefs', '用户偏好'], ['eval', '自评'], ['diary', '日记'], ['logs', '日志'], ['all', '全部']]
                .map(([v, l]) => h('option', { key: v, value: v }, l))),
            h(Btn, { onClick: () => run('delete', { scope }) }, '删除所选范围')),
          h('div', { style: S.note }, '删除不可恢复，建议先导出或备份。')),
        h(Card, null, h('h3', { style: S.h3 }, '重建'),
          h(Btn, { onClick: () => run('rebuild') }, '重建语言经验库（先自动备份）'),
          h('div', { style: S.note }, '会清空语言规律、知识与讨论记录，保留探索记录。')));
    }

    function PlatformsTab({ data }) {
      if (!data) return h('div', { style: S.note }, '加载中…');
      return h(React.Fragment, null,
        h(Card, null, h('h3', { style: S.h3 }, '已接入'),
          data.platforms.map((p) => h('div', { key: p.id, style: S.row },
            h('div', { style: S.grow },
              h('div', { style: { fontSize: 13 } }, p.name + '  ', h('span', { style: S.chip(p.status === 'ok' ? 'ok' : '') }, p.status === 'ok' ? '可读' : '部分可读')),
              h('div', { style: S.mono }, (data.groups[p.group] || p.group) + ' · 评论：' + ({ 'js-rendered': '前端渲染', 'login-required': '需登录', none: '无公开评论', unknown: '未知', 'api-closed': '接口关闭' }[p.comments] || p.comments)),
              p.note ? h('div', { style: S.sub }, p.note) : null)))),
        h(Card, null, h('h3', { style: S.h3 }, '未接入（明确原因）'),
          data.unsupported.map((p) => h('div', { key: p.id, style: S.row },
            h('div', { style: S.grow }, h('div', { style: { fontSize: 13 } }, p.name), h('div', { style: S.sub }, p.reason))))));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'hles-evolution', order: 12, label: () => '语言进化',
        }, EvolutionIcon));
        ctx.slots.inject('main', function* () {
          yield ctx.slots.register({ name: 'main', key: 'hles-evolution' }, Panel);
        });
        // 页内自检：证明客户端模块真的在浏览器里加载并注册成功，并把每个面板页的接口都探一遍
        try {
          const paths = ['/overview', '/settings', '/agents', '/diary', '/patterns', '/platforms', '/data', '/preview', '/learn'];
          Promise.all(paths.map(async (p) => {
            try {
              const r = await fetch(API + p, { credentials: 'same-origin' });
              return { path: p, status: r.status };
            } catch (e) {
              return { path: p, status: 0 };
            }
          })).then((endpoints) => fetch(API + '/diag', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              at: Date.now(),
              slots: ['sidebar.panellist:hles-evolution', 'main:hles-evolution'],
              endpoints,
              ua: String(navigator.userAgent || '').slice(0, 120),
              path: String(location && location.pathname || ''),
            }),
          })).catch(() => {});
        } catch (_) { /* 自检失败不影响面板 */ }
      },
    };
  },
});
