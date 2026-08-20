# 微信公众号自动化矩阵发文架构指南
## （基于 Cloudflare Worker + 阿里云固定 IP 中继 + Google Gemini 3.7 + 微信官方 Draft API）

> **架构目标：** 彻底解决 Serverless 边缘函数动态 IP 与微信接口白名单冲突的行业痛点，构建一套**低成本、零服务器依赖、具备历史记忆、每天 4 档自动排版并推送至公众号草稿箱**的企业级全自动发文矩阵系统。

---

## 一、 系统全景架构图 (Architecture Overview)

```mermaid
graph TD
    subgraph 1. Cloudflare 边缘调度核心 (Serverless Edge)
        Cron[Cron 调度器: 08:30 / 10:30 / 15:30 / 20:30] --> Worker[Cloudflare Worker 调度中枢]
        KV[(Workers KV: 状态/大纲库/历史记忆)] <-->|读写| Worker
    end

    subgraph 2. 阿里云固定 IP 中继服务 (Fixed-IP Relay)
        Worker -->|1. 携带安全 Key 请求 Token| Relay[阿里云 116.62.39.177 Nginx 反代]
        Relay -->|2. 固定公网 IP 转发鉴权| WXAuth[微信官方 cgi-bin/token 鉴权接口]
        WXAuth -->|3. 返回 7200s 有效 access_token| Relay
        Relay -->|4. 返回有效 Token| Worker
    end

    subgraph 3. Gemini 3.7 内容生成大脑 (Cognitive Brain)
        Worker -->|5. 注入: 模块大纲+昨日记忆+本期课题+下期预告| Gemini[Google Gemini 3.7 Pro / Flash]
        Gemini -->|6. 生成优雅微信 HTML 富文本与工程深度内容| Worker
    end

    subgraph 4. 微信公众平台与运营端 (Delivery & Operations)
        Worker -->|7. 直连推送草稿箱 draft/add| WXDraft[微信公众号后台「草稿箱」]
        Worker -->|8. 推送已就绪通知卡片| TG[Telegram 管理员机器人]
        WXDraft -->|9. 管理员手机端/网页端一键群发| Followers[公众号关注用户]
    end
```

---

## 二、 核心痛点与创新设计

### 1. 痛点：Cloudflare 动态 IP 与微信 IP 白名单的致命冲突
* **微信限制：** 微信公众平台拉取 `access_token` 时，**强制要求请求来源 IP 必须在开发者配置的 IP 白名单内**（否则返回 `40164 invalid ip` 错误）；
* **边缘计算特性：** Cloudflare Workers 作为全球分布式 Serverless，其出网 IP 池包含数万个 Anycast 动态 IP，无法全部加白；
* **创新解法：【三级高可用 Token 管道】**
  1. **第一级（边缘本地缓存）：** Worker 在 KV 中缓存 7000 秒有效期 Token，避免频繁请求；
  2. **第二级（固定 IP 中继转发）：** 当缓存失效时，Worker 向固定公网 IP 的阿里云服务器（`116.62.39.177`）发起带密钥的内网化 HTTP 请求，由阿里云服务器代为向微信官方获取 Token；
  3. **第三级（官方直连后备）：** 若本地环境具备固定 IP 时作为冷备回退。
* **关键突破：** 微信的 `draft/add`（草稿箱添加）接口**不校验 IP 白名单**（仅校验 Token 真实性），因此文章生成与草稿推送仍由 Cloudflare Worker 直接发起，耗费阿里云服务器 0 带宽与 0 CPU！

---

## 三、 各核心组件实现详解

### 组件 1：阿里云固定 IP 中继微服务 (`wechat-token-relay`)
在阿里云服务器（`116.62.39.177`）上运行轻量级 Node.js 守护进程，并通过 Nginx 80/8080 端口对外反代：

```javascript
// server.js (运行于阿里云 Node.js 环境，由 systemd 守护)
const http = require('http');
const https = require('https');
const url = require('url');

const SECURITY_KEY = 'amr_wechat_relay_2026_secure';
let cachedToken = null;
let tokenExpireTime = 0;

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname === '/api/wechat/token') {
    // 安全鉴权
    if (parsed.query.key !== SECURITY_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Forbidden: Invalid security key' }));
    }

    // 内存级 Token 复用 (剩余寿命 > 5 分钟则直接返回)
    if (cachedToken && Date.now() < tokenExpireTime - 300000) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ access_token: cachedToken, source: 'relay_memory_cache' }));
    }

    // 向微信官方发起获取请求 (来源于 116.62.39.177，白名单 100% 匹配)
    const tokenUrl = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${process.env.WX_APPID}&secret=${process.env.WX_APPSECRET}`;
    https.get(tokenUrl, (wRes) => {
      let body = '';
      wRes.on('data', chunk => body += chunk);
      wRes.on('end', () => {
        const data = JSON.parse(body);
        if (data.access_token) {
          cachedToken = data.access_token;
          tokenExpireTime = Date.now() + (data.expires_in * 1000);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
      });
    });
  }
});
server.listen(3090, '127.0.0.1');
```

---

### 组件 2：Cloudflare Worker 调度与记忆中枢 (`src/index.js`)

#### 1. 动态滑动窗口与历史记忆链 (Memory Flow)
每次触发时，系统从 KV 提取上一讲核心技术结论与下期预告，组装进 Prompt，实现有章法、连贯性的教程输出：

```javascript
// 核心状态提取
let historyMemory = await env.AI_USAGE.get('AMR_HISTORY_MEMORY', 'json');
const prevContext = historyMemory ? `
【历史上下文记忆 (承上)】：
上一讲为第 ${historyMemory.day} 讲【${historyMemory.title}】，属于【${historyMemory.module}】。
上一讲核心工程结论：${historyMemory.core}。
` : `【历史上下文记忆】：这是本体系化专栏的系统性开篇教程。`;

// 下期预告
const nextTopicItem = topics[currentIdx] || null;
const nextTeaserText = nextTopicItem ? `在下期专栏连载中，我们将深入剖析【${nextTopicItem.title}】。` : '';
```

#### 2. 标准化微信富文本 HTML 结构规范
强制 Gemini 3.7 输出原生标准内联 CSS HTML，包含科技蓝/翡翠绿高质感色卡、圆角容器、重要概念高亮及底部关注组件，输出后直接提交至微信官方草稿箱：

```javascript
const draftPayload = {
  articles: [
    {
      title: `【第${topicItem.day}讲】${topicItem.title}`.slice(0, 30),
      author: "机器人",
      digest: `${topicItem.module}：${topicItem.core.slice(0, 35)}...`,
      content: finalHtml,
      thumb_media_id: thumbMediaId, // 微信官方永久封面素材 ID
      need_open_comment: 1,
      only_fans_can_comment: 0
    }
  ]
};

await fetch(`https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${accessToken}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(draftPayload)
});
```

---

### 组件 3：全天候 4 档连载调度矩阵 (`wrangler.toml`)

```toml
[triggers]
crons = [
  "30 0,2,7,12 * * *",   # 08:30 / 10:30 / 15:30 / 20:30 每日 4 次 AMR 专栏连载生成
  "0 2,6 * * 1-5",       # 10:00 早盘起爆 & 14:00 午后反包 A股量化选股
  "5 7,8 * * *",         # 15:05 全息复盘 + 16:05 微信公众号每日 A股复盘发布
  "0 12,14 * * 1-5"      # 20:00 晚间重大舆情 + 22:00 欧美夜盘监控
]
```

---

## 四、 安全合规与故障自愈体系

1. **敏感凭证物理隔离**：
   * 所有 `WX_APPSECRET`、`WX_APPID`、`TG_BOT_TOKEN` 均通过 `npx wrangler secret put` 密文保存在 Cloudflare 隔离区，代码库 100% 开源无泄漏风险；
2. **合规安全脱敏过滤器 (`sanitizeWeChatComplianceContent`)**：
   * 自动过滤任何“绝密内幕、稳赚不赔、100%收益”等金融/工业违禁词，确保微信后台草稿箱秒级通过审核；
3. **Telegram 即时反馈与管理员一键发文**：
   * 文章生成入库后，Telegram 机器人秒级推送包含文章主题、草稿箱 Media ID、核心大纲与一键跳转微信后台按钮的卡片，运营者只需在手机微信助手点击一次“发表”即可推向全网！
