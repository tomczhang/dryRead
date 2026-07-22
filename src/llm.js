// DryRead 核心纯逻辑：URL 规整、提示词构建、SSE 解析、模型输出解析。
// 同时支持浏览器（挂到 globalThis.DryReadLLM）与 Node（module.exports），便于单测。
(function (root) {
  'use strict';

  var MAX_CONTENT_CHARS = 24000;

  var DEFAULT_SETTINGS = {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini'
  };

  var VERDICTS = ['值得精读', '可略读', '不值得读'];

  /**
   * 把用户填写的请求地址规整为 chat/completions 完整端点。
   * 约定：填到 /v1 这一级（如 https://api.openai.com/v1）；
   * 若已填完整 /chat/completions 端点则原样使用。
   */
  function normalizeBaseUrl(baseUrl) {
    var url = String(baseUrl || '').trim();
    if (!url) return '';
    // 去掉末尾的斜杠
    url = url.replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(url)) return url;
    return url + '/chat/completions';
  }

  var SYSTEM_PROMPT = [
    '你是 DryRead，一个严格、专业、不客套的中文阅读分析师。',
    '你的使命：脱去文章水分，留下真正有用的东西。',
    '用户会给你一个网页的标题、URL 和正文。你要：',
    '1. 判断这篇文章值不值得读，以及哪些部分值得读（指出具体的章节、段落或关键词位置）；',
    '2. 用一句话概括全文（不超过 40 个字，抓最核心的主张，不要空话）；',
    '3. 提炼最精华的观点（文中论证最扎实、信息密度最高的内容）；',
    '4. 挑出最新奇的观点（反直觉、少见、让人眼前一亮的；如果没有就返回空数组，不要硬编）；',
    '5. 给出对读者的启发（读完之后思维或行动上可以改变什么）；',
    '6. 沉淀可复用的知识（可以直接抄进笔记的事实、数据、方法、模型）；',
    '7. 给出干货浓度 dry_score（0-100 整数：100 = 全是干货，0 = 全是水）。',
    '',
    '要求：',
    '- 全部使用简体中文；每条要点独立成句、具体、可信，禁止“作者认为很重要”这类空话；',
    '- JSON 字符串内部如需引号，使用中文引号“”或「」，绝不要出现未转义的英文双引号；',
    '- 如果正文是登录墙、验证码、空页面或无实质内容，dry_score 给 0，verdict 给“不值得读”，并在 one_line 里说明原因；',
    '- 严格只输出一个 JSON 对象，不要 markdown 代码块，不要任何多余文字。',
    '',
    'JSON 结构如下：',
    '{',
    '  "one_line": "一句话总结，<=40字",',
    '  "dry_score": 0,',
    '  "worth_reading": { "verdict": "值得精读|可略读|不值得读", "parts": ["值得读的部分1", "..."] },',
    '  "essence": ["最精华的观点，2-5条"],',
    '  "novel": ["最新奇的观点，0-3条"],',
    '  "insights": ["启发，1-3条"],',
    '  "knowledge": ["可沉淀的知识，1-3条"]',
    '}'
  ].join('\n');

  /**
   * 构建 chat messages。page: { title, url, text }
   */
  function buildMessages(page) {
    var text = String((page && page.text) || '');
    var truncated = false;
    if (text.length > MAX_CONTENT_CHARS) {
      // 头部为主、结尾兜底：很多文章的结论在结尾
      var head = text.slice(0, Math.floor(MAX_CONTENT_CHARS * 0.8));
      var tail = text.slice(text.length - Math.floor(MAX_CONTENT_CHARS * 0.2));
      text = head + '\n……（中间部分因过长被省略）……\n' + tail;
      truncated = true;
    }
    var userContent = [
      '标题：' + ((page && page.title) || '（无标题）'),
      'URL：' + ((page && page.url) || '（未知）'),
      truncated ? '（注意：正文过长已截断，请基于可见部分分析）' : '',
      '正文：',
      text
    ]
      .filter(Boolean)
      .join('\n');

    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent }
    ];
  }

  /**
   * 从模型输出中稳健地取出 JSON 对象。
   * 兼容：裸 JSON、```json 代码块、前后夹杂说明文字。
   */
  function extractJson(text) {
    var s = String(text || '').trim();
    if (!s) throw new Error('模型返回为空');
    // 优先直接解析
    try {
      return JSON.parse(s);
    } catch (e) {
      /* 继续尝试 */
    }
    // 去掉 markdown 代码围栏
    var fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch (e) {
        /* 继续尝试 */
      }
    }
    // 扫描第一个配平的大括号块（考虑字符串与转义）
    var start = s.indexOf('{');
    while (start !== -1) {
      var depth = 0;
      var inStr = false;
      var esc = false;
      for (var i = start; i < s.length; i++) {
        var ch = s[i];
        if (esc) {
          esc = false;
          continue;
        }
        if (ch === '\\') {
          if (inStr) esc = true;
          continue;
        }
        if (ch === '"') {
          inStr = !inStr;
          continue;
        }
        if (inStr) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            var candidate = s.slice(start, i + 1);
            try {
              return JSON.parse(candidate);
            } catch (e) {
              break; // 该块不合法，尝试下一个 '{'
            }
          }
        }
      }
      start = s.indexOf('{', start + 1);
    }
    throw new Error('无法从模型输出中解析出 JSON');
  }

  function toStrArray(v, max) {
    if (!Array.isArray(v)) return [];
    return v
      .map(function (x) {
        return typeof x === 'string' ? x.trim() : x == null ? '' : String(x).trim();
      })
      .filter(Boolean)
      .slice(0, max || 8);
  }

  /**
   * 把模型输出的 JSON 规整成 UI 需要的结构，缺字段给安全兜底。
   */
  function normalizeResult(raw) {
    var obj = raw && typeof raw === 'object' ? raw : {};
    var worth = obj.worth_reading && typeof obj.worth_reading === 'object' ? obj.worth_reading : {};
    var verdict = typeof worth.verdict === 'string' ? worth.verdict.trim() : '';
    if (VERDICTS.indexOf(verdict) === -1) verdict = '可略读';
    var score = Number(obj.dry_score);
    if (!isFinite(score)) score = 0;
    score = Math.max(0, Math.min(100, Math.round(score)));
    var oneLine = typeof obj.one_line === 'string' ? obj.one_line.trim() : '';
    if (!oneLine) oneLine = '（模型未给出一句话总结）';
    return {
      oneLine: oneLine,
      dryScore: score,
      verdict: verdict,
      parts: toStrArray(worth.parts, 5),
      essence: toStrArray(obj.essence, 6),
      novel: toStrArray(obj.novel, 4),
      insights: toStrArray(obj.insights, 4),
      knowledge: toStrArray(obj.knowledge, 4)
    };
  }

  /**
   * 增量 SSE 解析器：push(chunk) 返回本次新增的 content 片段数组。
   * 兼容 \n 与 \r\n，兼容跨 chunk 断行，忽略 [DONE] 与非法行。
   */
  function SseParser() {
    this._buf = '';
    this.done = false;
  }
  SseParser.prototype.push = function (chunk) {
    var deltas = [];
    this._buf += chunk;
    var lines = this._buf.split(/\r?\n/);
    this._buf = lines.pop(); // 最后一段可能不完整，留到下次
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.indexOf('data:') !== 0) continue;
      var data = line.slice(5).trim();
      if (data === '[DONE]') {
        this.done = true;
        continue;
      }
      try {
        var json = JSON.parse(data);
        var choice = json.choices && json.choices[0];
        var piece =
          (choice && choice.delta && choice.delta.content) ||
          (choice && choice.message && choice.message.content) ||
          '';
        if (piece) deltas.push(piece);
      } catch (e) {
        /* 忽略无法解析的行 */
      }
    }
    return deltas;
  };

  var api = {
    MAX_CONTENT_CHARS: MAX_CONTENT_CHARS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    VERDICTS: VERDICTS,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    normalizeBaseUrl: normalizeBaseUrl,
    buildMessages: buildMessages,
    extractJson: extractJson,
    normalizeResult: normalizeResult,
    SseParser: SseParser
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.DryReadLLM = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
