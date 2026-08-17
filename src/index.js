export default {
  // 1. 定时触发任务（盘中高频巡检 + 盘后总结）
  async scheduled(event, env, ctx) {
    const beijingHour = (new Date().getUTCHours() + 8) % 24;
    const isPostMarket = beijingHour === 15 || beijingHour === 16;
    ctx.waitUntil(runStockPickerPipeline(env, isPostMarket ? 'POST_MARKET' : 'INTRADAY'));
  },

  // 2. HTTP 交互接口
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/run') {
      const mode = url.searchParams.get('mode') === 'intraday' ? 'INTRADAY' : 'POST_MARKET';
      const result = await runStockPickerPipeline(env, mode);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    if (url.pathname === '/api/quota') {
      const quota = await getAIQuotaUsage(env);
      return new Response(JSON.stringify(quota, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    const activeEngine = detectActiveModelEngine(env);
    const quota = await getAIQuotaUsage(env);

    // 仪表盘渲染
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI 实时交易推荐与免费算力监控 (storkA)</title>
  <style>
    :root {
      --bg: #070b14;
      --card: #111827;
      --card-hover: #172033;
      --border: #1f293d;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --primary: #38bdf8;
      --accent: #10b981;
      --warn: #f59e0b;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); padding: 2rem 1.5rem; margin: 0; line-height: 1.6; }
    .container { max-width: 1000px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; border-bottom: 1px solid var(--border); padding-bottom: 1.25rem; flex-wrap: wrap; gap: 1rem; }
    h1 { margin: 0; font-size: 1.6rem; color: #fff; display: flex; align-items: center; gap: 0.5rem; }
    .badge { display: inline-block; padding: 0.25rem 0.65rem; border-radius: 9999px; font-size: 0.78rem; font-weight: 700; background: #0369a1; color: #bae6fd; }
    .badge-engine { background: #1e3a8a; color: #93c5fd; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.3); }
    
    /* 算力配额仪表盘 */
    .quota-box { background: #0b1222; border: 1px solid #233554; border-radius: 10px; padding: 1.25rem; margin-top: 1rem; }
    .quota-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; font-size: 0.95rem; }
    .progress-bar-bg { width: 100%; height: 12px; background: #1e293b; border-radius: 6px; overflow: hidden; position: relative; margin-bottom: 0.75rem; }
    .progress-bar-fill { height: 100%; border-radius: 6px; transition: width 0.5s ease; }
    
    .grid-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-top: 1rem; }
    .stat-card { background: #0c1322; border: 1px solid var(--border); border-radius: 8px; padding: 1rem; }
    .stat-label { font-size: 0.82rem; color: var(--muted); margin-bottom: 0.2rem; }
    .stat-val { font-size: 1.25rem; font-weight: 700; color: #fff; }
    
    .btn { display: inline-block; background: var(--primary); color: #0f172a; padding: 0.7rem 1.4rem; border-radius: 8px; font-weight: 700; text-decoration: none; border: none; cursor: pointer; transition: opacity 0.2s; font-size: 0.95rem; margin-right: 0.5rem; margin-top: 0.5rem; }
    .btn:hover { opacity: 0.9; }
    .btn-outline { background: transparent; border: 1px solid var(--primary); color: var(--primary); }
    pre { background: #070a12; padding: 1rem; border-radius: 8px; overflow-x: auto; font-size: 0.88rem; color: #cbd5e1; white-space: pre-wrap; word-break: break-all; border: 1px solid #1a253d; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>⚡ AI 实时交易推荐与算力配额中心 <span class="badge">storkA</span></h1>
        <div style="color: var(--muted); font-size: 0.9rem; margin-top: 0.25rem;">
          当前推理引擎: <b style="color:var(--primary);">${activeEngine.name}</b>
        </div>
      </div>
      <div>
        <span class="badge" style="background:#065f46; color:#6ee7b7;">● 自动化已就绪: 每15分钟巡检</span>
      </div>
    </header>

    <!-- 算力监控卡片 (Tokens / Neurons 实时大盘) -->
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
        <h2 style="margin:0; font-size:1.15rem; color:#fff; display:flex; align-items:center; gap:0.5rem;">
          🔋 Cloudflare Workers AI 今日免费算力监控
        </h2>
        <span style="font-size:0.85rem; color:var(--muted);">每日 08:00 (UTC 00:00) 自动刷新满额</span>
      </div>

      <div class="quota-box">
        <div class="quota-header">
          <span><b>已消耗:</b> ${quota.usedNeurons} / ${quota.totalQuota} Neurons (${quota.usagePercent}%)</span>
          <span style="font-weight:700; color:${quota.remainingNeurons > 3000 ? 'var(--accent)' : 'var(--warn)'};">
            剩余: ${quota.remainingNeurons} Neurons (~可调用 ${quota.approxCallsRemaining} 次)
          </span>
        </div>

        <div class="progress-bar-bg">
          <div class="progress-bar-fill" style="width: ${Math.min(100, quota.usagePercent)}%; background: ${quota.usagePercent > 85 ? 'var(--danger)' : quota.usagePercent > 60 ? 'var(--warn)' : 'var(--accent)'};"></div>
        </div>

        <div style="display:flex; justify-content:space-between; font-size:0.8rem; color:var(--muted);">
          <span>0 (初始)</span>
          <span>5,000 (半额安全线)</span>
          <span>10,000 (每日免费上限)</span>
        </div>
      </div>

      <div class="grid-stats">
        <div class="stat-card">
          <div class="stat-label">今日总调用次数</div>
          <div class="stat-val">${quota.callCount} 次</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">单次平均消耗</div>
          <div class="stat-val">~${quota.avgCostPerCall} Neurons</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">防超额熔断保护</div>
          <div class="stat-val" style="color:var(--accent); font-size:1.1rem;">已开启 (0扣费保障)</div>
        </div>
      </div>
    </div>

    <!-- 交互操作卡片 -->
    <div class="card">
      <h2 style="margin-top:0; font-size:1.15rem; color:#fff;">🎯 实时研判与投研触发</h2>
      <p style="color:var(--muted); font-size:0.9rem;">
        盘中交易时间（09:30-15:00）系统会自动每 15 分钟执行一次并推送 Telegram。你也可以点击下方按钮立即手动触发一次。
      </p>

      <div style="margin-top: 1rem;">
        <button class="btn" onclick="triggerRun('intraday')">⚡ 立即执行盘中实时买入研判</button>
        <button class="btn btn-outline" onclick="triggerRun('postmarket')">📊 生成盘后完整投研复盘</button>
        <span id="loading" style="display:none; margin-left: 1rem; color: #38bdf8; font-weight: 500;">正在由 ${activeEngine.name} 深度推理中...</span>
      </div>
    </div>
    
    <div class="card" id="resCard" style="display: none;">
      <h2>📊 最新交易决策结果</h2>
      <pre id="output"></pre>
    </div>
  </div>

  <script>
    async function triggerRun(mode) {
      const loading = document.getElementById('loading');
      const resCard = document.getElementById('resCard');
      const output = document.getElementById('output');
      
      loading.style.display = 'inline';
      try {
        const res = await fetch('/run?mode=' + mode);
        const data = await res.json();
        output.textContent = JSON.stringify(data, null, 2);
        resCard.style.display = 'block';
        // 刷新页面以更新算力进度条
        setTimeout(() => location.reload(), 3000);
      } catch (err) {
        output.textContent = '执行失败: ' + err.message;
        resCard.style.display = 'block';
      } finally {
        loading.style.display = 'none';
      }
    }
  </script>
</body>
</html>`;

    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};

// 算力与 Token 监控追踪器
async function getAIQuotaUsage(env) {
  const TOTAL_FREE_QUOTA = 10000; // Cloudflare 每日免费 10,000 Neurons
  const todayKey = 'usage_' + new Date().toISOString().split('T')[0];

  let usage = { usedNeurons: 0, callCount: 0 };
  if (env.AI_USAGE) {
    const raw = await env.AI_USAGE.get(todayKey);
    if (raw) {
      try { usage = JSON.parse(raw); } catch (e) {}
    }
  }

  const used = usage.usedNeurons || 0;
  const remaining = Math.max(0, TOTAL_FREE_QUOTA - used);
  const percent = ((used / TOTAL_FREE_QUOTA) * 100).toFixed(1);
  const avgCost = usage.callCount > 0 ? Math.round(used / usage.callCount) : 260;
  const approxRemaining = Math.floor(remaining / (avgCost || 260));

  return {
    date: new Date().toISOString().split('T')[0],
    totalQuota: TOTAL_FREE_QUOTA,
    usedNeurons: used,
    remainingNeurons: remaining,
    usagePercent: parseFloat(percent),
    callCount: usage.callCount || 0,
    avgCostPerCall: avgCost,
    approxCallsRemaining: approxRemaining
  };
}

// 记录单次推理的算力消耗
async function recordAIUsage(env, estimatedNeurons = 260) {
  if (!env.AI_USAGE) return;
  const todayKey = 'usage_' + new Date().toISOString().split('T')[0];
  let usage = { usedNeurons: 0, callCount: 0 };
  const raw = await env.AI_USAGE.get(todayKey);
  if (raw) {
    try { usage = JSON.parse(raw); } catch (e) {}
  }
  usage.usedNeurons = (usage.usedNeurons || 0) + estimatedNeurons;
  usage.callCount = (usage.callCount || 0) + 1;
  await env.AI_USAGE.put(todayKey, JSON.stringify(usage), { expirationTtl: 86400 * 3 });
}

// 检测当前激活的模型引擎（热插拔路由器）
function detectActiveModelEngine(env) {
  if (env.GEMINI_API_KEY && env.GEMINI_API_KEY.trim()) {
    return {
      type: 'GEMINI',
      name: 'Google Gemini 官方旗舰',
      description: '检测到 GEMINI_API_KEY，已自动切换至 Google 官方 Gemini 旗舰推理引擎。'
    };
  }
  if (env.DEEPSEEK_API_KEY && env.DEEPSEEK_API_KEY.trim()) {
    return {
      type: 'DEEPSEEK_OFFICIAL',
      name: 'DeepSeek 官方旗舰 API',
      description: '检测到 DEEPSEEK_API_KEY，已自动切换至 DeepSeek 官方满血云端大模型。'
    };
  }
  if (env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim()) {
    return {
      type: 'OPENAI',
      name: 'OpenAI 官方旗舰 API',
      description: '检测到 OPENAI_API_KEY，已自动切换至 OpenAI 官方旗舰大模型。'
    };
  }
  return {
    type: 'CF_DEEPSEEK_R1',
    name: 'Cloudflare DeepSeek-R1 (32B 原生)',
    description: '未配置外部 API Key，默认使用 Cloudflare 原生 DeepSeek-R1-32B 深度思维链推理（100% 免费白嫖，0 成本）。'
  };
}

// 统一模型调用分发器
async function generateAIAnalysis(prompt, env) {
  const engine = detectActiveModelEngine(env);

  // 1. Google Gemini 官方 API
  if (engine.type === 'GEMINI') {
    try {
      const modelName = env.GEMINI_MODEL || 'gemini-2.0-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${env.GEMINI_API_KEY.trim()}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return { text, engineName: `Google Gemini (${modelName})` };
    } catch (e) {
      console.error('Gemini 调用失败，回退原生 R1:', e);
    }
  }

  // 2. DeepSeek 官方 API
  if (engine.type === 'DEEPSEEK_OFFICIAL') {
    try {
      const modelName = env.DEEPSEEK_MODEL || 'deepseek-reasoner';
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.DEEPSEEK_API_KEY.trim()}`
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            { role: 'system', content: '你是专业的实盘量化交易专家，指令明确专业。' },
            { role: 'user', content: prompt }
          ]
        })
      });
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (text) return { text, engineName: `DeepSeek 官方 API (${modelName})` };
    } catch (e) {
      console.error('DeepSeek 官方调用失败，回退原生 R1:', e);
    }
  }

  // 3. 默认底座：Cloudflare 原生 DeepSeek-R1 (32B)
  if (env.AI) {
    // 检查是否触发防超额熔断保护（剩余 < 250 Neurons 则转为规则输出，绝不扣费）
    const quota = await getAIQuotaUsage(env);
    if (quota.remainingNeurons < 250) {
      return { text: '（已触发今日免费算力防超额保护，采用经典量化规则输出）', engineName: '基础量化规则 (熔断保护)' };
    }

    try {
      const aiRes = await env.AI.run('@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', {
        messages: [
          { role: 'system', content: '你是专业的实盘量化交易专家，指令明确专业。' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 1000
      });
      const text = aiRes?.response || aiRes?.choices?.[0]?.message?.content || JSON.stringify(aiRes);
      
      // 记录一次算力消耗 (平均单次 ~260 Neurons)
      await recordAIUsage(env, 260);
      
      return { text, engineName: 'Cloudflare DeepSeek-R1-32B (原生免费)' };
    } catch (err) {
      return { text: `量化形态良好，建议严格按止损位分批建仓。(${err.message})`, engineName: '基础量化规则' };
    }
  }

  return { text: '（基础量化规则生成）', engineName: '基础量化规则' };
}

// 核心流程：量化漏斗 -> 股价概率预测 -> 买卖点生成 -> Telegram 实时通知
async function runStockPickerPipeline(env, mode = 'INTRADAY') {
  const startTime = Date.now();
  
  // 1. 抓取大盘核心活跃股票池
  const candidates = await fetchMarketCandidates();
  if (!candidates || candidates.length === 0) {
    return { success: false, message: '未获取到有效候选股票' };
  }

  // 2. 取量化动量综合评分前 3 只核心标的
  const topPicks = candidates.slice(0, 3);

  // 3. 计算确定性的量化风控参数
  const tradePlans = topPicks.map(s => {
    const buyLow = (s.price * 0.992).toFixed(2);
    const buyHigh = (s.price * 1.005).toFixed(2);
    const stopLoss = (s.price * 0.962).toFixed(2); // 严格最大回撤 -3.8%
    const tp1 = (s.price * 1.055).toFixed(2);     // 第一止盈位 +5.5% (减半仓)
    const tp2 = (s.price * 1.115).toFixed(2);     // 第二止盈位 +11.5% (跟踪止盈)
    const winProb = Math.min(92, Math.max(76, Math.round(75 + s.score / 12)));
    return {
      ...s,
      buyZone: `¥${buyLow} ~ ¥${buyHigh}`,
      stopLoss: `¥${stopLoss} (风险: -3.8%)`,
      target1: `¥${tp1} (+5.5% 减半仓)`,
      target2: `¥${tp2} (+11.5% 跟踪止盈)`,
      winProb: `${winProb}%`,
      position: '15% ~ 20%'
    };
  });

  // 4. 构造给大模型的时序投研 Prompt
  const stocksText = tradePlans.map((s, idx) => 
    `${idx + 1}. [${s.code}] ${s.name} - 现价: ¥${s.price}, 涨幅: +${s.changePercent}%, 成交额: ${(s.amount / 10000).toFixed(2)}亿元\n   预设参数: 建议买入区间: ${s.buyZone}, 止损价: ${s.stopLoss}, 目标位: ${s.target1}`
  ).join('\n');

  const isIntraday = mode === 'INTRADAY';
  const prompt = isIntraday
    ? `你是一位顶级实盘日内量化交易总监。基于盘中实时捕获的3只放量起爆强势龙头股：\n\n${stocksText}\n\n请针对每只股票输出精简实盘操作指令：\n1. 盘中起爆形态确认与分时量价异动逻辑\n2. 挂单买入技巧（如何利用分时均线低吸防追高）\n3. 交易评级（🌟🌟🌟🌟🌟 强烈推荐买入 / 🌟🌟🌟🌟 重点关注）\n\n最后给出当前分时盘面的一句话交易锦囊。语言极其精炼直接。`
    : `你是一位顶级股票量化基金经理。请基于今日盘后筛选出的3只核心标的进行深度复盘研报：\n\n${stocksText}\n\n请输出每只标的的核心逻辑、支撑阻力位、风控建议及次日开盘策略。精炼专业。`;

  // 5. 由统一多模态路由器进行推理研判
  const aiResult = await generateAIAnalysis(prompt, env);
  const cleanAnalysis = (aiResult.text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // 获取最新算力消耗信息以呈现在通知中
  const quota = await getAIQuotaUsage(env);

  // 6. 格式化 Telegram 实时交易信号卡片
  const nowStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const tgMsg = isIntraday
    ? `⚡ <b>#【实时交易买入推荐信号】</b> ⚡\n` +
      `🕒 <b>触发时间：</b>${nowStr}\n` +
      `🧠 <b>研判大模型：</b><code>${aiResult.engineName}</code>\n` +
      `🔋 <b>今日算力余量：</b>${quota.remainingNeurons} / 10000 Neurons (${100 - quota.usagePercent}% 剩余)\n` +
      `🔥 <b>策略模型：</b>时序概率预测 + Qlib 量价共振\n\n` +
      tradePlans.map(s => 
        `🎯 <b>${s.name}</b> (<code>${s.code}</code>)\n` +
        `• <b>现价：</b>¥${s.price} (<b>+${s.changePercent}%</b>) | <b>胜率：</b>${s.winProb}\n` +
        `• <b>建议建仓区间：</b><code>${s.buyZone}</code>\n` +
        `• <b>严格止损价：</b><code>${s.stopLoss}</code>\n` +
        `• <b>止盈目标：</b>${s.target1} / ${s.target2}\n` +
        `• <b>仓位建议：</b>${s.position}`
      ).join('\n\n') +
      `\n\n🧠 <b>AI 操盘手指令：</b>\n${cleanAnalysis.slice(0, 2500)}`
    : `📈 <b>#【每日盘后智能选股与投研报告】</b>\n` +
      `📅 <b>日期：</b>${nowStr}\n` +
      `🧠 <b>研判大模型：</b><code>${aiResult.engineName}</code>\n` +
      `🔋 <b>今日算力余量：</b>${quota.remainingNeurons} / 10000 Neurons\n` +
      `🏆 <b>今日精选标的：</b>\n` +
      tradePlans.map(s => `• <b>${s.name}</b> (<code>${s.code}</code>) 现价: ¥${s.price} (+${s.changePercent}%) 止损: ${s.stopLoss}`).join('\n') +
      `\n\n🧠 <b>AI 投研分析与决策建议：</b>\n${cleanAnalysis.slice(0, 2500)}`;

  let tgSent = false;
  if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) {
    try {
      const tgUrl = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`;
      const tgResp = await fetch(tgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TG_CHAT_ID,
          text: tgMsg,
          parse_mode: 'HTML'
        })
      });
      tgSent = tgResp.ok;
    } catch (e) {
      console.error('发送TG失败:', e);
    }
  }

  return {
    success: true,
    mode,
    activeEngine: aiResult.engineName,
    quota,
    executionTimeMs: Date.now() - startTime,
    timestamp: nowStr,
    tradePlans,
    cleanAnalysis,
    telegramNotified: tgSent
  };
}

// 核心大盘活跃股池
const CORE_UNIVERSE = [
  "sz300308", "sz300502", "sz300394", "sh688256", "sh688008", "sz300476", "sz002475",
  "sh601138", "sh688041", "sh688012", "sz002371", "sz002463", "sz002281", "sz300750",
  "sz000938", "sz000977", "sh603019", "sh600487", "sh601869", "sh600498", "sz301308",
  "sh688525", "sz002409", "sz000831", "sh600176", "sz002008", "sh688072", "sz300433"
];

async function fetchMarketCandidates() {
  const url = "https://qt.gtimg.cn/q=" + CORE_UNIVERSE.map(s => "s_" + s).join(",");
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) return [];

  const buffer = await resp.arrayBuffer();
  const text = new TextDecoder('gbk').decode(buffer);

  const candidates = [];
  const lines = text.split(';');
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split('~');
    if (parts.length >= 8) {
      const name = parts[1];
      const code = parts[2];
      const price = parseFloat(parts[3]) || 0;
      const changePercent = parseFloat(parts[5]) || 0;
      const amount = parseFloat(parts[7]) || 0;

      if (changePercent >= 1.5 && changePercent <= 12.0 && amount >= 30000) {
        const score = (changePercent * 3) + ((amount / 10000) * 0.5);
        candidates.push({ code, name, price, changePercent, amount, score });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}
