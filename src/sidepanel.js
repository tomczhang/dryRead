/* dryRead 侧栏主逻辑 */
(function () {
  'use strict';

  var LLM = globalThis.DryReadLLM;

  // ---------- DOM ----------
  var $ = function (id) {
    return document.getElementById(id);
  };

  var el = {
    viewMain: $('view-main'),
    viewSettings: $('view-settings'),
    tabChangedBar: $('tab-changed-bar'),
    btnAnalyzeNew: $('btn-analyze-new'),
    btnRerun: $('btn-rerun'),
    btnSettings: $('btn-settings'),
    btnBack: $('btn-back'),
    pageCard: $('page-card'),
    pageTitle: $('page-title'),
    pageUrl: $('page-url'),
    stateLoading: $('state-loading'),
    loadingText: $('loading-text'),
    stateError: $('state-error'),
    errorText: $('error-text'),
    btnRetry: $('btn-retry'),
    btnGotoSettings: $('btn-goto-settings'),
    stateWelcome: $('state-welcome'),
    btnWelcomeSettings: $('btn-welcome-settings'),
    stateResult: $('state-result'),
    scoreRing: $('score-ring'),
    scoreNum: $('score-num'),
    verdictBadge: $('verdict-badge'),
    oneLine: $('one-line'),
    secParts: $('sec-parts'),
    listParts: $('list-parts'),
    secEssence: $('sec-essence'),
    listEssence: $('list-essence'),
    secNovel: $('sec-novel'),
    listNovel: $('list-novel'),
    secInsights: $('sec-insights'),
    listInsights: $('list-insights'),
    secKnowledge: $('sec-knowledge'),
    listKnowledge: $('list-knowledge'),
    btnCopy: $('btn-copy'),
    inputBaseUrl: $('input-base-url'),
    inputApiKey: $('input-api-key'),
    inputModel: $('input-model'),
    btnToggleKey: $('btn-toggle-key'),
    btnSave: $('btn-save'),
    btnTest: $('btn-test'),
    settingsStatus: $('settings-status')
  };

  // ---------- 状态 ----------
  var settings = Object.assign({}, LLM.DEFAULT_SETTINGS);
  var currentAbort = null; // 当前请求的 AbortController
  var analyzedTab = null; // { id, url, title } 最近一次分析的页签
  var lastResult = null; // 最近一次规整后的结果
  var running = false;

  // ---------- 工具 ----------
  function show(node) {
    node.classList.remove('hidden');
  }

  function hide(node) {
    node.classList.add('hidden');
  }

  function setMainState(state) {
    // state: 'loading' | 'error' | 'welcome' | 'result' | 'none'
    hide(el.stateLoading);
    hide(el.stateError);
    hide(el.stateWelcome);
    hide(el.stateResult);
    if (state === 'loading') show(el.stateLoading);
    else if (state === 'error') show(el.stateError);
    else if (state === 'welcome') show(el.stateWelcome);
    else if (state === 'result') show(el.stateResult);
  }

  function isRestrictedUrl(url) {
    if (!url) return true;
    return /^(chrome|chrome-extension|edge|about|devtools|view-source|chrome-search|https:\/\/chromewebstore\.google\.com)/i.test(
      url
    );
  }

  function renderList(listEl, sectionEl, items) {
    listEl.textContent = '';
    if (!items || !items.length) {
      hide(sectionEl);
      return;
    }
    show(sectionEl);
    items.forEach(function (text) {
      var li = document.createElement('li');
      li.textContent = text; // textContent 防注入
      listEl.appendChild(li);
    });
  }

  // ---------- 设置存取 ----------
  function loadSettings() {
    return chrome.storage.local.get(['baseUrl', 'apiKey', 'model']).then(function (data) {
      settings.baseUrl = data.baseUrl || LLM.DEFAULT_SETTINGS.baseUrl;
      settings.apiKey = data.apiKey || '';
      settings.model = data.model || LLM.DEFAULT_SETTINGS.model;
      return settings;
    });
  }

  function saveSettings(next) {
    return chrome.storage.local.set(next).then(function () {
      Object.assign(settings, next);
    });
  }

  function fillSettingsForm() {
    el.inputBaseUrl.value = settings.baseUrl;
    el.inputApiKey.value = settings.apiKey;
    el.inputModel.value = settings.model;
  }

  function readSettingsForm() {
    return {
      baseUrl: el.inputBaseUrl.value.trim() || LLM.DEFAULT_SETTINGS.baseUrl,
      apiKey: el.inputApiKey.value.trim(),
      model: el.inputModel.value.trim() || LLM.DEFAULT_SETTINGS.model
    };
  }

  function setSettingsStatus(text, kind) {
    el.settingsStatus.textContent = text || '';
    el.settingsStatus.className = 'settings-status' + (kind ? ' ' + kind : '');
  }

  // ---------- 页面内容提取（注入到页面执行，必须自包含） ----------
  function pageExtractor() {
    function cleanText(s) {
      return s
        .replace(/[ \t\u00a0]+/g, ' ')
        .replace(/\n\s*\n\s*/g, '\n')
        .trim();
    }
    try {
      var doc = document;
      var root = null;
      // 微信公众号正文
      if (location.hostname === 'mp.weixin.qq.com') {
        root = doc.querySelector('#js_content') || doc.querySelector('#page-content');
      }
      if (!root) {
        var candidates = [
          'article',
          'main',
          '[role="main"]',
          '#content',
          '.article-content',
          '.post-content',
          '.markdown-body'
        ];
        var best = null;
        var bestLen = 0;
        for (var i = 0; i < candidates.length; i++) {
          var nodes = doc.querySelectorAll(candidates[i]);
          for (var j = 0; j < nodes.length; j++) {
            var len = (nodes[j].innerText || '').length;
            if (len > bestLen) {
              bestLen = len;
              best = nodes[j];
            }
          }
        }
        // 候选正文太短则退回 body
        root = bestLen > 400 ? best : doc.body;
      }
      var clone = root ? root.cloneNode(true) : null;
      if (clone) {
        var junk = clone.querySelectorAll(
          'script,style,noscript,iframe,svg,nav,header,footer,aside,form,button,input,select,textarea,[aria-hidden="true"]'
        );
        for (var k = 0; k < junk.length; k++) junk[k].remove();
      }
      // cloneNode 后的节点不在文档中，innerText 不可靠，用 textContent
      var text = clone ? cleanText(clone.textContent || '') : '';
      if (text.length < 200 && doc.body) {
        // 兜底：直接取整页可见文本
        text = cleanText(doc.body.innerText || doc.body.textContent || '');
      }
      var metaDesc = doc.querySelector('meta[name="description"]');
      return {
        ok: true,
        title: doc.title || '',
        url: location.href,
        description: metaDesc ? metaDesc.getAttribute('content') || '' : '',
        text: text
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function getActiveTab() {
    return chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      return tabs && tabs[0] ? tabs[0] : null;
    });
  }

  function extractFromTab(tab) {
    return chrome.scripting
      .executeScript({ target: { tabId: tab.id }, func: pageExtractor })
      .then(function (results) {
        var payload = results && results[0] && results[0].result;
        if (!payload || !payload.ok) {
          throw new Error('无法读取页面内容' + (payload && payload.error ? '：' + payload.error : ''));
        }
        return payload;
      });
  }

  // ---------- 调用模型 ----------
  function callModel(page, signal) {
    var endpoint = LLM.normalizeBaseUrl(settings.baseUrl);
    // 不携带 temperature/max_tokens：部分模型（如 o 系列）会拒绝这些参数
    var body = {
      model: settings.model,
      messages: LLM.buildMessages(page),
      stream: true
    };
    return fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + settings.apiKey
      },
      body: JSON.stringify(body),
      signal: signal
    }).then(function (resp) {
      if (!resp.ok) {
        return resp
          .text()
          .catch(function () {
            return '';
          })
          .then(function (detail) {
            var msg = 'HTTP ' + resp.status;
            if (resp.status === 401) msg = 'API Key 无效（401），请检查设置';
            else if (resp.status === 404) msg = '请求地址不存在（404），请检查设置里的请求地址';
            else if (resp.status === 429) msg = '请求过于频繁或额度不足（429）';
            if (detail) msg += '\n' + detail.slice(0, 300);
            throw new Error(msg);
          });
      }
      var ctype = (resp.headers.get('content-type') || '').toLowerCase();
      if (ctype.indexOf('text/event-stream') !== -1 && resp.body) {
        // 流式：增量解析 SSE
        var reader = resp.body.getReader();
        var decoder = new TextDecoder('utf-8');
        var parser = new LLM.SseParser();
        var full = '';
        var received = 0;
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) {
              // flush 残余
              var rest = parser.push('\n');
              rest.forEach(function (d) {
                full += d;
              });
              return full;
            }
            var chunkText = decoder.decode(r.value, { stream: true });
            parser.push(chunkText).forEach(function (d) {
              full += d;
            });
            received = full.length;
            el.loadingText.textContent = '正在拧干这篇文章… 已产出 ' + received + ' 字';
            return pump();
          });
        }
        return pump();
      }
      // 非流式（部分网关不支持 stream）
      return resp.json().then(function (json) {
        var choice = json.choices && json.choices[0];
        var content =
          (choice && choice.message && choice.message.content) ||
          (choice && choice.delta && choice.delta.content) ||
          '';
        if (!content) throw new Error('模型未返回内容');
        return content;
      });
    });
  }

  // ---------- 渲染结果 ----------
  var VERDICT_CLASS = {
    值得精读: 'good',
    可略读: 'mid',
    不值得读: 'bad'
  };

  function renderResult(result) {
    lastResult = result;
    el.scoreRing.style.setProperty('--pct', String(result.dryScore));
    el.scoreNum.textContent = String(result.dryScore);
    el.verdictBadge.textContent = result.verdict;
    el.verdictBadge.className = 'verdict-badge ' + (VERDICT_CLASS[result.verdict] || 'mid');
    el.oneLine.textContent = result.oneLine;
    renderList(el.listParts, el.secParts, result.parts);
    renderList(el.listEssence, el.secEssence, result.essence);
    renderList(el.listNovel, el.secNovel, result.novel);
    renderList(el.listInsights, el.secInsights, result.insights);
    renderList(el.listKnowledge, el.secKnowledge, result.knowledge);
    setMainState('result');
  }

  function resultToMarkdown(result, page) {
    var lines = [];
    lines.push('# ' + ((page && page.title) || '未命名页面'));
    if (page && page.url) lines.push('> ' + page.url);
    lines.push('');
    lines.push('**一句话总结**：' + result.oneLine);
    lines.push('**干货浓度**：' + result.dryScore + '/100 · ' + result.verdict);
    function section(title, items) {
      if (!items || !items.length) return;
      lines.push('');
      lines.push('## ' + title);
      items.forEach(function (t) {
        lines.push('- ' + t);
      });
    }
    section('值得读的部分', result.parts);
    section('最精华的观点', result.essence);
    section('最新奇的观点', result.novel);
    section('启发', result.insights);
    section('可沉淀的知识', result.knowledge);
    return lines.join('\n');
  }

  // ---------- 主流程 ----------
  function showError(message) {
    el.errorText.textContent = message;
    setMainState('error');
  }

  function analyzeCurrentTab() {
    if (!settings.apiKey) {
      setMainState('welcome');
      return;
    }
    if (currentAbort) currentAbort.abort();
    currentAbort = new AbortController();
    var signal = currentAbort.signal;
    running = true;
    hide(el.tabChangedBar);
    el.loadingText.textContent = '正在拧干这篇文章…';
    setMainState('loading');
    hide(el.pageCard);

    var pageRef = null;

    getActiveTab()
      .then(function (tab) {
        if (!tab) throw new Error('找不到当前页签');
        if (isRestrictedUrl(tab.url)) {
          throw new Error('这个页面（浏览器内置页/商店页）无法读取，请切换到普通网页再试');
        }
        analyzedTab = { id: tab.id, url: tab.url, title: tab.title };
        return extractFromTab(tab);
      })
      .then(function (page) {
        if (signal.aborted) return null;
        pageRef = page;
        el.pageTitle.textContent = page.title || page.url;
        el.pageUrl.textContent = page.url;
        show(el.pageCard);
        if (!page.text || page.text.length < 80) {
          throw new Error('页面正文太少（可能未加载完、登录墙或纯图片页），没什么可脱水的');
        }
        return callModel(page, signal);
      })
      .then(function (content) {
        if (signal.aborted || content == null) return;
        var parsed = LLM.extractJson(content);
        var result = LLM.normalizeResult(parsed);
        result._page = pageRef;
        renderResult(result);
      })
      .catch(function (err) {
        if (signal.aborted || (err && err.name === 'AbortError')) return;
        showError((err && err.message) || String(err));
      })
      .finally(function () {
        if (currentAbort && currentAbort.signal === signal) {
          currentAbort = null;
          running = false;
        }
      });
  }

  // ---------- 测试连接 ----------
  function testConnection() {
    var form = readSettingsForm();
    if (!form.apiKey) {
      setSettingsStatus('请先填写 API Key', 'err');
      return;
    }
    setSettingsStatus('正在测试连接…', '');
    el.btnTest.disabled = true;
    fetch(LLM.normalizeBaseUrl(form.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + form.apiKey
      },
      body: JSON.stringify({
        model: form.model,
        messages: [{ role: 'user', content: '回复"ok"两个字母即可' }],
        stream: false
      })
    })
      .then(function (resp) {
        if (resp.ok) {
          setSettingsStatus('✓ 连接成功，模型可用', 'ok');
          return null;
        }
        return resp
          .text()
          .catch(function () {
            return '';
          })
          .then(function (detail) {
            setSettingsStatus(
              '✗ 连接失败（HTTP ' + resp.status + '）' + (detail ? '：' + detail.slice(0, 160) : ''),
              'err'
            );
          });
      })
      .catch(function (err) {
        setSettingsStatus('✗ 网络错误：' + ((err && err.message) || err), 'err');
      })
      .finally(function () {
        el.btnTest.disabled = false;
      });
  }

  // ---------- 视图切换 ----------
  function openSettings() {
    fillSettingsForm();
    setSettingsStatus('');
    hide(el.viewMain);
    show(el.viewSettings);
  }

  function closeSettings() {
    hide(el.viewSettings);
    show(el.viewMain);
    // 从设置回来：若已配好 key 且还没有结果，自动开始分析
    if (settings.apiKey && !lastResult && !running) analyzeCurrentTab();
  }

  // ---------- 事件绑定 ----------
  el.btnSettings.addEventListener('click', openSettings);
  el.btnBack.addEventListener('click', closeSettings);
  el.btnWelcomeSettings.addEventListener('click', openSettings);
  el.btnGotoSettings.addEventListener('click', openSettings);
  el.btnRerun.addEventListener('click', analyzeCurrentTab);
  el.btnRetry.addEventListener('click', analyzeCurrentTab);
  el.btnAnalyzeNew.addEventListener('click', analyzeCurrentTab);

  el.btnToggleKey.addEventListener('click', function () {
    el.inputApiKey.type = el.inputApiKey.type === 'password' ? 'text' : 'password';
  });

  el.btnSave.addEventListener('click', function () {
    var form = readSettingsForm();
    saveSettings(form).then(function () {
      setSettingsStatus('✓ 已保存', 'ok');
    });
  });

  el.btnTest.addEventListener('click', testConnection);

  // 写剪贴板：优先 Clipboard API，失败时降级到 textarea + execCommand
  function copyText(text) {
    return navigator.clipboard.writeText(text).catch(function () {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      if (!ok) throw new Error('copy failed');
    });
  }

  el.btnCopy.addEventListener('click', function () {
    if (!lastResult) return;
    var md = resultToMarkdown(lastResult, lastResult._page);
    copyText(md)
      .then(function () {
        el.btnCopy.textContent = '✓ 已复制为 Markdown';
        setTimeout(function () {
          el.btnCopy.textContent = '复制全部要点';
        }, 1500);
      })
      .catch(function () {
        el.btnCopy.textContent = '复制失败';
      });
  });

  // 页签切换/跳转后提示重新脱水
  function onTabMaybeChanged() {
    getActiveTab().then(function (tab) {
      if (!tab || running) return;
      if (analyzedTab && tab.url === analyzedTab.url) {
        hide(el.tabChangedBar);
      } else if (analyzedTab) {
        show(el.tabChangedBar);
      }
    });
  }

  chrome.tabs.onActivated.addListener(onTabMaybeChanged);
  chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
    if (changeInfo.status === 'complete') onTabMaybeChanged();
  });

  // ---------- 启动 ----------
  loadSettings().then(function () {
    if (!settings.apiKey) {
      setMainState('welcome');
    } else {
      analyzeCurrentTab();
    }
  });
})();
