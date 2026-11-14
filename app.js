/* 画画网站 —— 画板 / 涂鸦笔 / 颜色 / 橡皮擦 / 撤回 / 填色桶 */
(function () {
  'use strict';

  /* ============ 常量 ============ */

  const W = 1280;   // 画布内部宽度
  const H = 800;    // 画布内部高度
  // 画布本身是透明的（CSS 里垫了一层白底当纸），所以导出的 PNG 天然带透明背景

  const PALETTE = [
    '#000000', '#4b5563', '#9ca3af', '#ffffff',
    '#ef4444', '#f97316', '#f59e0b', '#facc15',
    '#84cc16', '#22c55e', '#10b981', '#14b8a6',
    '#06b6d4', '#3b82f6', '#4f46e5', '#8b5cf6',
    '#a855f7', '#ec4899', '#f43f5e', '#78350f',
  ];

  /* ============ 元素 ============ */

  const canvas = document.getElementById('board');
  // 注意：不要加 willReadFrequently，那会让 Chrome 退回软件渲染，落笔会明显发涩。
  // 填色只在点击时读一次像素，代价可以忽略。
  const ctx = canvas.getContext('2d');
  const boardWrap = canvas.parentElement;
  const cursorEl = document.getElementById('brushCursor');

  const swatchesEl = document.getElementById('swatches');
  const colorPicker = document.getElementById('colorPicker');
  const colorPreview = document.getElementById('colorPreview');

  const sizeSlider = document.getElementById('sizeSlider');
  const sizeValue = document.getElementById('sizeValue');
  const sizeGroup = document.getElementById('sizeGroup');

  const tolSlider = document.getElementById('tolSlider');
  const tolValue = document.getElementById('tolValue');
  const tolGroup = document.getElementById('tolGroup');

  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');
  const clearBtn = document.getElementById('clearBtn');
  const saveBtn = document.getElementById('saveBtn');

  canvas.width = W;
  canvas.height = H;

  /* ============ 状态 ============ */

  const state = {
    tool: 'brush',
    color: '#111827',
    sizes: { brush: 10, eraser: 44 },
    tolerance: 32,
  };

  let ops = [];          // 全部可重放的操作，是画面的唯一真相
  let redoStack = [];
  let currentOp = null;  // 正在绘制的笔画
  let drawing = false;

  /* ============ 工具函数 ============ */

  function hexToRgb(hex) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /** 把屏幕坐标换算成画布内部坐标 */
  function toCanvas(e) {
    const r = canvasRect();
    return {
      x: (e.clientX - r.left) * (W / r.width),
      y: (e.clientY - r.top) * (H / r.height),
    };
  }

  /* 画布位置只在窗口尺寸变化时才会变，缓存起来，
     否则每次 pointermove 读一次 getBoundingClientRect 都会强制重排，手感就变钝了 */
  let rectCache = null;
  function canvasRect() {
    if (!rectCache) rectCache = canvas.getBoundingClientRect();
    return rectCache;
  }
  function invalidateRect() { rectCache = null; }
  window.addEventListener('resize', invalidateRect);
  window.addEventListener('scroll', invalidateRect, true);

  /** 一笔开始时设置一次画笔状态；之后逐段绘制不再 save/restore，省掉每段的两次状态栈操作 */
  function applyStrokeStyle(op) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = op.size;
    if (op.tool === 'eraser') {
      // destination-out：把像素真正擦成透明，而不是盖一层白色，
      // 这样导出的 PNG 里擦掉的地方就是透明的
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = '#000000';
      ctx.fillStyle = '#000000';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = op.color;
      ctx.fillStyle = op.color;
    }
  }

  function dot(x, y, size) {
    ctx.beginPath();
    ctx.arc(x, y, size / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function segment(x0, y0, x1, y1) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  /** 重放一笔完整的笔画（撤回/重做时用），逐段绘制以保证与实时绘制结果一致 */
  function replayStroke(op) {
    applyStrokeStyle(op);
    const p = op.points;
    if (p.length === 2) {
      dot(p[0], p[1], op.size);
      return;
    }
    for (let i = 2; i < p.length; i += 2) {
      segment(p[i - 2], p[i - 1], p[i], p[i + 1]);
    }
  }

  /* ============ 填色桶：扫描线漫水填充 ============ */

  function floodFill(sx, sy, rgb, tolerance) {
    sx = Math.floor(sx);
    sy = Math.floor(sy);
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) return false;

    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;

    const s = (sy * W + sx) * 4;
    const tr = d[s], tg = d[s + 1], tb = d[s + 2], ta = d[s + 3];
    const [fr, fg, fb] = rgb;

    // 目标色与填充色完全一致，无事可做
    if (tr === fr && tg === fg && tb === fb && ta === 255) return false;

    const tol = tolerance;
    const visited = new Uint8Array(W * H);

    function match(px, py) {
      const i = py * W + px;
      if (visited[i]) return false;
      const o = i * 4;
      return Math.abs(d[o] - tr) <= tol
        && Math.abs(d[o + 1] - tg) <= tol
        && Math.abs(d[o + 2] - tb) <= tol
        && Math.abs(d[o + 3] - ta) <= tol;
    }

    const stack = [sx, sy];
    let changed = false;

    while (stack.length) {
      const y = stack.pop();
      const x = stack.pop();
      if (visited[y * W + x] || !match(x, y)) continue;

      // 向左右扩展出这一行的连续可填充区间（left / right 都是闭区间端点）
      let left = x;
      while (left > 0 && match(left - 1, y)) left--;
      let right = x;
      while (right < W - 1 && match(right + 1, y)) right++;

      for (let i = left; i <= right; i++) {
        const o = (y * W + i) * 4;
        d[o] = fr;
        d[o + 1] = fg;
        d[o + 2] = fb;
        d[o + 3] = 255;
        visited[y * W + i] = 1;
        changed = true;
      }

      for (let k = 0; k < 2; k++) {
        const ny = k === 0 ? y - 1 : y + 1;
        if (ny < 0 || ny >= H) continue;
        let i = left;
        while (i <= right) {
          while (i <= right && !match(i, ny)) i++;
          if (i > right) break;
          stack.push(i, ny);
          while (i <= right && match(i, ny)) i++;
        }
      }
    }

    if (changed) ctx.putImageData(img, 0, 0);
    return changed;
  }

  /* ============ 重放 ============ */

  /** 清空成完全透明（白纸效果由 CSS 背景提供，不写进画布） */
  function clearBoard() {
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, W, H);
  }

  function replay(op) {
    if (op.type === 'stroke') replayStroke(op);
    else if (op.type === 'fill') floodFill(op.x, op.y, hexToRgb(op.color), op.tolerance);
    else if (op.type === 'clear') clearBoard();
  }

  function render() {
    clearBoard();
    for (const op of ops) replay(op);
  }

  /* ============ 操作历史 ============ */

  function push(op) {
    ops.push(op);
    redoStack.length = 0;
    syncHistoryButtons();
    scheduleSave();
  }

  function undo() {
    if (drawing || !ops.length) return;
    redoStack.push(ops.pop());
    render();
    syncHistoryButtons();
    scheduleSave();
  }

  function redo() {
    if (drawing || !redoStack.length) return;
    const op = redoStack.pop();
    ops.push(op);
    replay(op);
    syncHistoryButtons();
    scheduleSave();
  }

  /* ============ 本地自动保存（刷新/关闭页面后画作不丢） ============ */

  const STORAGE_KEY = 'huaban.ops.v1';
  let saveTimer = 0;

  function validOp(op) {
    if (!op || typeof op !== 'object') return false;
    if (op.type === 'stroke') {
      return Array.isArray(op.points) && op.points.length >= 2 && typeof op.size === 'number';
    }
    if (op.type === 'fill') {
      return typeof op.x === 'number' && typeof op.y === 'number' && typeof op.color === 'string';
    }
    return op.type === 'clear';
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveLocal, 300);
  }

  function saveLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ops));
    } catch (_) {
      // 隐私模式 / 超出配额 / file:// 被禁用：存不下就算了，不影响继续画
    }
  }

  function loadLocal() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (_) {
      return false;
    }
    if (!raw) return false;
    try {
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return false;
      const clean = data.filter(validOp);
      if (!clean.length) return false;
      ops = clean;
      return true;
    } catch (_) {
      return false;
    }
  }

  function syncHistoryButtons() {
    undoBtn.disabled = ops.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }

  /* ============ 指针交互 ============ */

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();

    const p = toCanvas(e);

    if (state.tool === 'fill') {
      const rgb = hexToRgb(state.color);
      if (floodFill(p.x, p.y, rgb, state.tolerance)) {
        push({ type: 'fill', x: Math.floor(p.x), y: Math.floor(p.y), color: state.color, tolerance: state.tolerance });
      }
      return;
    }

    canvas.setPointerCapture(e.pointerId);
    drawing = true;
    currentOp = {
      type: 'stroke',
      tool: state.tool,
      color: state.color,
      size: state.sizes[state.tool],
      points: [p.x, p.y],
    };
    ops.push(currentOp);
    redoStack.length = 0;
    syncHistoryButtons();
    applyStrokeStyle(currentOp);
    dot(p.x, p.y, currentOp.size);
  }

  function onPointerMove(e) {
    moveCursor(e);
    if (!drawing || !currentOp) return;

    // 浏览器会按帧合并 pointermove；取出合并掉的原始采样点，
    // 高刷新率鼠标/触控笔的笔迹就不会被削掉，跟手度明显更好
    const merged = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const list = merged.length ? merged : [e];

    for (let k = 0; k < list.length; k++) {
      const p = toCanvas(list[k]);
      const pts = currentOp.points;
      const lx = pts[pts.length - 2];
      const ly = pts[pts.length - 1];
      if (Math.abs(p.x - lx) < 0.5 && Math.abs(p.y - ly) < 0.5) continue;
      pts.push(p.x, p.y);
      segment(lx, ly, p.x, p.y);
    }
  }

  function endStroke(e) {
    if (!drawing) return;
    drawing = false;
    if (e && canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    // 只有落笔没有拖动时，那一笔已经由 dot() 画好了，直接保留
    currentOp = null;
    scheduleSave();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  // passive：告诉浏览器这段监听不会阻止滚动，事件分发更快
  canvas.addEventListener('pointermove', onPointerMove, { passive: true });
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  // 指针捕获期间离开画布不应中断笔画，只把光标圈藏起来
  canvas.addEventListener('pointerleave', moveCursorOut);
  // 兜底：万一捕获失败，抬起手指也要收笔
  window.addEventListener('pointerup', endStroke);

  /* ============ 光标预览 ============ */

  let cursorSize = 0;
  let cursorShown = false;

  function moveCursor(e) {
    if (state.tool === 'fill') return;

    // 只在尺寸真的变了的时候写样式，避免每次移动都触发样式重算
    const r = canvasRect();
    const size = Math.max(Math.round(state.sizes[state.tool] * (r.width / W)), 4);
    if (size !== cursorSize) {
      cursorSize = size;
      cursorEl.style.width = size + 'px';
      cursorEl.style.height = size + 'px';
    }
    if (!cursorShown) {
      cursorShown = true;
      cursorEl.style.opacity = '1';
    }

    // 用 transform 定位：不引起重排，鼠标跟手
    cursorEl.style.transform =
      'translate3d(' + e.clientX + 'px,' + e.clientY + 'px,0) translate(-50%,-50%)';
  }

  function moveCursorOut() {
    if (!cursorShown) return;
    cursorShown = false;
    cursorEl.style.opacity = '0';
  }

  /* ============ 界面同步 ============ */

  function buildSwatches() {
    const frag = document.createDocumentFragment();
    for (const c of PALETTE) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.dataset.color = c;
      b.style.background = c;
      b.title = c;
      b.setAttribute('aria-label', c);
      frag.appendChild(b);
    }
    swatchesEl.appendChild(frag);
  }

  function setColor(color, fromPicker) {
    state.color = color;
    colorPreview.style.background = color;
    if (!fromPicker) colorPicker.value = color;
    for (const el of swatchesEl.children) {
      el.classList.toggle('active', el.dataset.color.toLowerCase() === color.toLowerCase());
    }
  }

  function setTool(tool) {
    state.tool = tool;
    for (const el of document.querySelectorAll('.tool')) {
      el.classList.toggle('active', el.dataset.tool === tool);
    }
    const isFill = tool === 'fill';
    sizeGroup.classList.toggle('dim', isFill);
    sizeSlider.disabled = isFill;
    tolGroup.classList.toggle('dim', !isFill);
    tolSlider.disabled = !isFill;
    canvas.style.cursor = isFill ? 'crosshair' : 'none';
    if (isFill) moveCursorOut();
    if (!isFill) syncSizeSlider();
  }

  function syncSizeSlider() {
    sizeSlider.value = state.sizes[state.tool];
    sizeValue.textContent = state.sizes[state.tool];
    paintRange(sizeSlider);
  }

  function paintRange(el) {
    const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
    el.style.setProperty('--fill', pct + '%');
  }

  /* ============ 事件绑定 ============ */

  swatchesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.swatch');
    if (btn) setColor(btn.dataset.color);
  });

  colorPicker.addEventListener('input', () => setColor(colorPicker.value, true));

  for (const el of document.querySelectorAll('.tool')) {
    el.addEventListener('click', () => setTool(el.dataset.tool));
  }

  sizeSlider.addEventListener('input', () => {
    const v = +sizeSlider.value;
    state.sizes[state.tool] = v;
    sizeValue.textContent = v;
    paintRange(sizeSlider);
  });

  tolSlider.addEventListener('input', () => {
    state.tolerance = +tolSlider.value;
    tolValue.textContent = tolSlider.value;
    paintRange(tolSlider);
  });

  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);

  clearBtn.addEventListener('click', () => {
    if (!ops.length) return;
    push({ type: 'clear' });
    clearBoard();
  });

  function saveImage() {
    // 画布本身不铺白色底，toDataURL 导出的 PNG 就是透明背景
    const a = document.createElement('a');
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.download = `我的画-${ts}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
  }

  for (const btn of document.querySelectorAll('[data-action="save"]')) {
    btn.addEventListener('click', saveImage);
  }

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if ((e.ctrlKey || e.metaKey) && k === 'y') {
      e.preventDefault();
      redo();
    } else if ((e.ctrlKey || e.metaKey) && k === 's') {
      e.preventDefault();
      saveImage();
    } else if (k === 'b') {
      setTool('brush');
    } else if (k === 'e') {
      setTool('eraser');
    } else if (k === 'g') {
      setTool('fill');
    }
  });

  // 拖动滑块时避免触发画布手势
  boardWrap.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ============ AI 鉴定 ============ */

  const appraiseBtn = document.getElementById('appraiseBtn');
  const appraiseLabel = appraiseBtn.querySelector('span');
  const appraiseCard = document.getElementById('appraiseCard');
  const appraiseBody = document.getElementById('appraiseBody');
  const appraiseClose = document.getElementById('appraiseClose');
  const appraiseSettings = document.getElementById('appraiseSettings');

  const keyModal = document.getElementById('keyModal');
  const keyInput = document.getElementById('keyInput');
  const keySaveBtn = document.getElementById('keySave');
  const keyClearBtn = document.getElementById('keyClear');
  const keyCancelBtn = document.getElementById('keyCancel');
  const providerSelect = document.getElementById('providerSelect');
  const modelInput = document.getElementById('modelInput');
  const modalHint = document.getElementById('modalHint');
  const modalDesc = document.getElementById('modalDesc');
  const keyField = document.getElementById('keyField');

  // 三家中国大陆的模型都用 OpenAI 兼容接口，浏览器里可以直连（已确认带 CORS 头）
  const PROVIDERS = {
    qwen: {
      label: '通义千问 Qwen-VL（阿里云百炼）',
      kind: 'openai',
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      model: 'qwen-vl-max-latest',
      keyUrl: 'https://bailian.console.aliyun.com/',
      note: '国内直连，不用代理。key 在百炼控制台的「API-KEY」里。',
    },
    kimi: {
      label: 'Kimi（月之暗面）',
      kind: 'openai',
      endpoint: 'https://api.moonshot.cn/v1/chat/completions',
      model: 'moonshot-v1-8k-vision-preview',
      keyUrl: 'https://platform.moonshot.cn/console/api-keys',
      note: '国内直连，不用代理。请用支持看图的模型。',
    },
    local: {
      label: '本地小模型（不用 key · 不限次数）',
      kind: 'local',
      model: 'HuggingFaceTB/SmolVLM2-500M-Video-Instruct',
      keyUrl: '',
      note: '完全免费、不用 key、不限次数。第一次要下载约 500MB 模型，之后走浏览器缓存。'
        + '它只会描述画面内容，不会像在线大模型那样点评风格和估价。',
    },
    openrouter: {
      label: 'OpenRouter（免费模型）',
      kind: 'openai',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'openrouter/free',
      keyUrl: 'https://openrouter.ai/keys',
      note: '免费模型，注册即用；每天有调用次数上限，国内可能需要代理。模型名可以换成任意 :free 的视觉模型。',
    },
    claude: {
      label: 'Claude（Anthropic，需代理）',
      kind: 'anthropic',
      model: 'claude-opus-5-5',
      keyUrl: 'https://console.anthropic.com/settings/keys',
      note: '国内直连通常需要开代理 / VPN。',
    },
  };

  const PROVIDER_STORE = 'huaban.ai.provider';
  const KEY_STORE = 'huaban.apiKey';          // 旧版只有一个 key，迁移时读它
  const KEY_PREFIX = 'huaban.apiKey.';        // 新版：每家一个
  const MODEL_PREFIX = 'huaban.ai.model.';

  // 三个 CDN 依次兜底：某个被墙/抽风时还能从别处把 SDK 拉下来
  const SDK_URLS = [
    'https://esm.sh/@anthropic-ai/sdk',
    'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk/+esm',
    'https://unpkg.com/@anthropic-ai/sdk?module',
  ];

  const SYSTEM_PROMPT = [
    '你是一位既专业又幽默的艺术鉴定师，从幼儿园涂鸦到抽象表现主义都鉴过。',
    '用户会给你一幅用鼠标或手指画出来的画（白底，可能很简单、很潦草，也可能只是一团线）。',
    '请认真观察画面，然后用中文按下面的格式输出，总长度控制在 300 字以内：',
    '',
    '【画面内容】客观描述你真正看到的东西；如果很抽象，就说它让你联想到什么。',
    '【风格定位】用艺术流派或艺术史的语言给它归类，可以调侃，但要贴切。',
    '【技法点评】谈构图、线条、用色、留白，指出一个亮点和一个可以改进的地方。',
    '【鉴定结论】一句话下结论，要有态度。',
    '【参考估价】给一个玩笑式的价格，并说明理由。',
    '',
    '要求：只用纯文本和上面的【】标题，不要使用 Markdown 语法。',
    '语气要真诚有趣，不要一味吹捧，也不要刻薄伤人。',
  ].join('\n');

  // 顺序即弹窗里的下拉顺序：大陆的三家放前面
  // 顺序即弹窗里的下拉顺序
  // 注意：豆包（火山方舟）的接口不允许浏览器直接调用（实测 Failed to fetch），所以没有放进来
  const PROVIDER_ORDER = ['qwen', 'kimi', 'local', 'openrouter', 'claude'];

  const keyMemory = {};   // localStorage 不可用（隐私模式）时的兜底

  function currentProvider() {
    let id = '';
    try { id = localStorage.getItem(PROVIDER_STORE) || ''; } catch (_) {}
    if (PROVIDERS[id]) return id;
    // 老版本只存过一个 Claude key，有它就默认继续用 Claude
    try { if (localStorage.getItem(KEY_STORE)) return 'claude'; } catch (_) {}
    return 'qwen';
  }

  function setProviderId(id) {
    if (!PROVIDERS[id]) return;
    try { localStorage.setItem(PROVIDER_STORE, id); } catch (_) {}
  }

  function getKey(id) {
    const pid = id || currentProvider();
    try {
      const v = localStorage.getItem(KEY_PREFIX + pid);
      if (v) return v;
      if (pid === 'claude') return localStorage.getItem(KEY_STORE) || '';
      return '';
    } catch (_) {
      return keyMemory[pid] || '';
    }
  }

  function setKey(v, id) {
    const pid = id || currentProvider();
    keyMemory[pid] = v;
    try {
      if (v) localStorage.setItem(KEY_PREFIX + pid, v);
      else localStorage.removeItem(KEY_PREFIX + pid);
    } catch (_) { /* 隐私模式下存不了，本次会话仍可用 */ }
  }

  function getModel(id) {
    const pid = id || currentProvider();
    try { return localStorage.getItem(MODEL_PREFIX + pid) || PROVIDERS[pid].model; }
    catch (_) { return PROVIDERS[pid].model; }
  }

  function setModel(v, id) {
    const pid = id || currentProvider();
    try {
      if (v && v !== PROVIDERS[pid].model) localStorage.setItem(MODEL_PREFIX + pid, v);
      else localStorage.removeItem(MODEL_PREFIX + pid);
    } catch (_) {}
  }

  function syncProviderUI() {
    const pid = currentProvider();
    const p = PROVIDERS[pid];
    const isLocal = p.kind === 'local';

    providerSelect.value = pid;
    modelInput.value = getModel(pid);
    modelInput.placeholder = p.model;

    // 本地模型不要 key：把输入框藏起来，按钮文案也换掉
    keyField.hidden = isLocal;
    keyClearBtn.hidden = isLocal || !getKey(pid);
    keySaveBtn.textContent = isLocal ? '开始鉴定' : '保存并鉴定';
    modalDesc.textContent = isLocal
      ? '本地模型就跑在你自己的浏览器里：不用 key、不限次数，只有第一次要联网下载模型文件。'
      : '密钥只保存在你自己的浏览器里（localStorage），不会上传到别处，也不会写进这个网站的文件。';

    modalHint.textContent = '';
    modalHint.appendChild(document.createTextNode(p.note + (isLocal ? '' : ' 还没有 key？到 ')));
    if (!isLocal) {
      const a = document.createElement('a');
      a.href = p.keyUrl;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.textContent = new URL(p.keyUrl).hostname;
      modalHint.appendChild(a);
      modalHint.appendChild(document.createTextNode(' 创建一个，然后粘贴到这里。'));
    }
  }

  function openKeyModal() {
    syncProviderUI();
    keyInput.value = '';
    keyModal.hidden = false;
    if (keyField.hidden) setTimeout(() => providerSelect.focus(), 30);
    else setTimeout(() => keyInput.focus(), 30);
  }

  function closeKeyModal() {
    keyModal.hidden = true;
  }

  /** 画布是透明的，发给模型前先压成白底，尺寸也降一档省 token */
  function snapshotBase64() {
    const maxW = 1024;
    const scale = Math.min(1, maxW / W);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(W * scale));
    c.height = Math.max(1, Math.round(H * scale));
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(canvas, 0, 0, c.width, c.height);
    return c.toDataURL('image/png').split(',')[1];
  }

  function boardIsEmpty() {
    const d = ctx.getImageData(0, 0, W, H).data;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] > 8) return false;
    }
    return true;
  }

  let loadingTextEl = null;
  let loadingActive = false;

  function renderLoading(message) {
    const msg = message || '鉴定师正在端详你的大作……';
    loadingActive = true;
    // 已经在转圈了：只换文字，别整块重建（下载进度会一直变）
    if (loadingTextEl && appraiseBody.contains(loadingTextEl)) {
      loadingTextEl.textContent = msg;
      return;
    }
    appraiseBody.textContent = '';
    const row = document.createElement('div');
    row.className = 'appraise-loading';
    const sp = document.createElement('span');
    sp.className = 'spinner';
    const txt = document.createElement('span');
    txt.textContent = msg;
    row.appendChild(sp);
    row.appendChild(txt);
    appraiseBody.appendChild(row);
    loadingTextEl = txt;
  }

  function renderText(text) {
    loadingTextEl = null;
    loadingActive = false;
    appraiseBody.textContent = text;
  }

  function renderError(message) {
    loadingTextEl = null;
    loadingActive = false;
    appraiseBody.textContent = '';
    const p = document.createElement('p');
    p.className = 'appraise-error';
    p.textContent = message;
    appraiseBody.appendChild(p);

    // 不管什么原因失败，都要留一条「换模型」的退路，不然就卡死在这家了
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = '换个模型 / 设置 API Key';
    b.addEventListener('click', () => {
      appraiseCard.hidden = true;
      openKeyModal();
    });
    appraiseBody.appendChild(b);
  }

  function describeError(err, providerId) {
    if (!err) return '鉴定失败，请稍后再试。';
    const pid = providerId || currentProvider();
    const name = PROVIDERS[pid] ? PROVIDERS[pid].label : 'AI';
    if (err.message === 'SDK_LOAD_FAILED') {
      return '加载 Anthropic SDK 失败：说明 esm.sh / jsdelivr / unpkg 这几个 CDN 都连不上。'
        + '请先确认代理 / VPN 已经连上，再点一次「鉴定」。'
        + '（如果不想折腾代理，可以在「设置 API Key」里改用通义千问或 Kimi。）';
    }
    if (err.message === 'REFUSAL') {
      return '鉴定师这次婉拒了。换一幅画再试试？';
    }
    if (err.message === 'LOCAL_CDN_FAILED') {
      return '加载本地模型的运行库失败：jsdelivr / esm.sh / unpkg 都连不上。'
        + '第一次用本地模型需要联网下载，下好之后才完全离线。检查网络后再试。';
    }
    if (err.message === 'LOCAL_LOAD_FAILED') {
      return '本地模型下载失败：可能是网络断了，或者镜像站 hf-mirror.com 连不上。'
        + '检查网络后再点一次「鉴定」，已经下好的部分不会重下。';
    }
    if (err.message === 'LOCAL_INFER_FAILED') {
      return '本地模型没能跑起来：可能是内存不够，或这个浏览器不支持 WebGPU/WASM 推理。'
        + '换一个浏览器（新版 Chrome / Edge）试试，或者在「设置 API Key」里改用在线模型。';
    }
    const status = err.status || err.statusCode;
    if (status === 401 || status === 403) {
      return name + ' 的 API Key 无效或没有权限，请在「设置 API Key」里重新填。';
    }
    if (status === 404) {
      return '找不到模型：模型名可能写错了（当前填的是「' + getModel(pid) + '」）。'
        + '在「设置 API Key」里改一下模型名再试。';
    }
    if (status === 429) return '请求太频繁或额度用完了，休息一下再试。';
    if (typeof status === 'number' && status >= 500) return '服务暂时不可用，请稍后重试。';
    // 连不上：最常见的元凶是代理/VPN 没连、断网，而不是 key 写错了
    if (err.message === 'NETWORK' || err.name === 'APIConnectionError'
      || /connection error|failed to fetch|network ?error|load failed/i.test(err.message || '')) {
      if (pid === 'claude') {
        return '连不上 Anthropic 服务器：请先确认代理 / VPN 已经连上，再点一次「鉴定」。'
          + '如果代理正常还是不行，可能是拿 file:// 直接打开的页面被浏览器跨域策略挡住了，'
          + '在项目目录运行 python -m http.server 8000，然后用 http://localhost:8000 打开。';
      }
      return '连不上 ' + name + ' 的服务器：检查一下网络，再点一次「鉴定」。'
        + '如果一直不行，可能是拿 file:// 直接打开的页面被浏览器跨域策略挡住了，'
        + '在项目目录运行 python -m http.server 8000，然后用 http://localhost:8000 打开。';
    }
    if (err instanceof TypeError) {
      return '网络请求失败：可能断网，或浏览器以 file:// 打开时被跨域策略拦截。'
        + '如果一直失败，可以用 python -m http.server 起个本地服务器再打开。';
    }
    return '鉴定失败：' + (err.message || String(err));
  }

  // SDK 只加载一次，成功后就复用；失败则清空缓存，下次点击可以重试
  let sdkPromise = null;

  function loadSdk() {
    if (sdkPromise) return sdkPromise;
    sdkPromise = (async () => {
      for (const url of SDK_URLS) {
        try {
          const mod = await import(url);
          const Anthropic = mod && (mod.default || mod.Anthropic);
          if (typeof Anthropic === 'function') return Anthropic;
        } catch (_) { /* 换下一个 CDN */ }
      }
      sdkPromise = null;
      throw new Error('SDK_LOAD_FAILED');
    })();
    return sdkPromise;
  }

  async function callClaude(imageB64) {
    let Anthropic;
    try {
      Anthropic = await loadSdk();
    } catch (_) {
      throw new Error('SDK_LOAD_FAILED');
    }

    const client = new Anthropic({
      apiKey: getKey('claude'),
      // 允许在浏览器里直接调用；SDK 会带上 anthropic-dangerous-direct-browser-access 头
      dangerouslyAllowBrowser: true,
      defaultHeaders: { 'anthropic-dangerous-direct-browser-access': 'true' },
    });

    const params = {
      model: getModel('claude'),
      max_tokens: 4096,
      // 轻松的小任务，用低 effort 换速度和成本
      output_config: { effort: 'low' },
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageB64 } },
          { type: 'text', text: '请鉴定这幅画。' },
        ],
      }],
    };

    let res;
    try {
      // 服务端兜底：万一被安全策略拦下，API 会自动换模型接着答
      res = await client.beta.messages.create(Object.assign({}, params, {
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      }));
    } catch (err) {
      // 少数账号/代理不支持这个 beta，就退回普通请求
      if (err && (err.status || err.statusCode) === 400) {
        res = await client.messages.create(params);
      } else {
        throw err;
      }
    }

    if (res.stop_reason === 'refusal') throw new Error('REFUSAL');

    const text = res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    return text || '鉴定师端详良久，什么也没说。';
  }

  /** 通义千问 / Kimi / 豆包 都是 OpenAI 兼容的 chat/completions，一套代码搞定 */
  async function callOpenAICompatible(pid, imageB64) {
    const p = PROVIDERS[pid];
    const body = {
      model: getModel(pid),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,' + imageB64 } },
            { type: 'text', text: '请鉴定这幅画。' },
          ],
        },
      ],
      max_tokens: 800,
      temperature: 0.9,
    };

    let res;
    try {
      res = await fetch(p.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + getKey(pid),
        },
        body: JSON.stringify(body),
      });
    } catch (_) {
      throw new Error('NETWORK');
    }

    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = (j && j.error && (j.error.message || j.error.code)) || '';
      } catch (_) { /* 错误体不是 JSON 就算了 */ }
      const e = new Error(detail || ('HTTP ' + res.status));
      e.status = res.status;
      throw e;
    }

    const data = await res.json();
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    let text = msg && msg.content;
    if (Array.isArray(text)) text = text.map((x) => (x && x.text) || '').join('');
    text = (text || '').trim();
    return text || '鉴定师端详良久，什么也没说。';
  }

  function callAI(imageB64) {
    const pid = currentProvider();
    const kind = PROVIDERS[pid].kind;
    if (kind === 'local') return callLocal(imageB64);
    return kind === 'anthropic'
      ? callClaude(imageB64)
      : callOpenAICompatible(pid, imageB64);
  }

  /* ---- 本地小模型：模型跑在浏览器里，不联网、不要 key ---- */

  const TF_URLS = [
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2',
    'https://esm.sh/@huggingface/transformers@4.3.2',
    'https://unpkg.com/@huggingface/transformers@4.3.2',
  ];
  const TRANSLATOR = 'Xenova/opus-mt-en-zh';

  // 第一次用完就把 promise 清掉，失败后可以重试
  function cacheOnce(make) {
    let p = null;
    const run = () => {
      if (!p) {
        p = Promise.resolve().then(make);
        p.catch(() => { p = null; });
      }
      return p;
    };
    return run;
  }

  const loadTF = cacheOnce(async () => {
    for (const url of TF_URLS) {
      try {
        const T = await import(url);
        T.env.remoteHost = 'https://hf-mirror.com';   // 国内镜像，直连可用
        T.env.allowLocalModels = false;
        return T;
      } catch (_) { /* 换下一个 CDN */ }
    }
    throw new Error('LOCAL_CDN_FAILED');
  });

  function downloadText(p) {
    if (!p || p.status !== 'progress' || !p.total) return '';
    const mb = (n) => (n / 1048576).toFixed(0);
    return '（' + mb(p.loaded) + '/' + mb(p.total) + ' MB）';
  }

  /** 真的能拿到 GPU 适配器才用 WebGPU；否则老实走 CPU */
  async function pickDevice() {
    if (typeof navigator === 'undefined' || !navigator.gpu) return 'wasm';
    try {
      const adapter = await navigator.gpu.requestAdapter();
      return adapter ? 'webgpu' : 'wasm';
    } catch (_) { return 'wasm'; }
  }

  const loadCaptioner = cacheOnce(async () => {
    const T = await loadTF();
    const id = getModel('local');
    // 结束后（成功或报错）就别再让进度覆盖报告内容
    const progress_callback = (p) => {
      if (loadingActive && p && p.status === 'progress') {
        renderLoading('正在下载本地模型 ' + downloadText(p));
      }
    };

    const processor = await T.AutoProcessor.from_pretrained(id, { progress_callback });

    const device = await pickDevice();
    let model = null;
    let used = 'wasm';
    if (device === 'webgpu') {
      try {
        model = await T.AutoModelForVision2Seq.from_pretrained(id, {
          dtype: 'q4f16', device: 'webgpu', progress_callback,
        });
        used = 'webgpu';
      } catch (_) { model = null; }
    }
    if (!model) {
      // CPU 推理：慢，但没有显卡也能跑
      model = await T.AutoModelForVision2Seq.from_pretrained(id, {
        dtype: 'q4', device: 'wasm', progress_callback,
      });
      used = 'wasm';
    }
    return { T, processor, model, device: used };
  });

  const loadTranslator = cacheOnce(async () => {
    const T = await loadTF();
    return T.pipeline('translation', TRANSLATOR, {
      dtype: 'q8',
      progress_callback: (p) => {
        if (loadingActive && p && p.status === 'progress') {
          renderLoading('正在下载翻译模型 ' + downloadText(p));
        }
      },
    });
  });

  /** 画布本身的统计：用了几种颜色、覆盖了多少面积 —— 这个是本地算的，免费又准确 */
  function canvasStats() {
    const d = ctx.getImageData(0, 0, W, H).data;
    const colors = new Set();
    let painted = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 40) continue;
      painted++;
      // 每个通道 64 一档：抗锯齿的过渡色不会被算成一堆「新颜色」
      colors.add((d[i] >> 6) * 256 + (d[i + 1] >> 6) * 16 + (d[i + 2] >> 6));
    }
    const pct = Math.round((painted / (W * H)) * 100);
    return { colors: colors.size, pct };
  }

  async function callLocal(imageB64) {
    let T, processor, model, device;
    try {
      renderLoading('正在准备本地模型（第一次要下载，稍等）…');
      ({ T, processor, model, device } = await loadCaptioner());
    } catch (err) {
      throw new Error((err && err.message) || 'LOCAL_LOAD_FAILED');
    }

    const stats = canvasStats();

    renderLoading(device === 'webgpu'
      ? '本地模型正在看图……'
      : '本地模型正在看图……（没有显卡加速，可能要等几分钟）');

    let caption = '';
    try {
      const image = await T.RawImage.read('data:image/png;base64,' + imageB64);
      const messages = [{
        role: 'user',
        content: [
          { type: 'image' },
          { type: 'text', text: 'Describe this drawing: the shapes, objects, colors and what it seems to show.' },
        ],
      }];
      const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
      const inputs = await processor(text, [image]);
      const out = await model.generate({ ...inputs, max_new_tokens: 48, do_sample: false });
      const decoded = processor.batch_decode(
        out.slice(null, [inputs.input_ids.dims.at(-1), null]),
        { skip_special_tokens: true },
      );
      caption = (decoded && decoded[0] ? String(decoded[0]) : '').trim();
    } catch (_) {
      throw new Error('LOCAL_INFER_FAILED');
    }

    if (!caption) throw new Error('LOCAL_INFER_FAILED');

    // 小小模型只会说英文，再翻成中文
    let zh = '';
    try {
      renderLoading('正在把模型的话翻成中文……');
      const tr = await loadTranslator();
      const r = await tr(caption);
      zh = (r && r[0] && r[0].translation_text ? r[0].translation_text : '').trim();
    } catch (_) { /* 翻译挂了就直接给英文 */ }

    const lines = [];
    lines.push('【画面内容】' + (zh || caption));
    lines.push('');
    lines.push('【画面数据】用了约 ' + stats.colors + ' 种颜色，覆盖了 ' + stats.pct + '% 的画布。');
    lines.push('');
    lines.push('【说明】这份报告来自跑在你浏览器里的小模型（SmolVLM 0.5B）：免费、离线、不限次数，'
      + '但它只会描述看到的东西，不会像在线大模型那样点评风格、给出估价。'
      + '想要更专业（也更贫嘴）的鉴定，可以在「设置 API Key」里换成在线模型。');
    if (zh && zh !== caption) lines.push('\n（模型原文：' + caption + '）');
    return lines.join('\n');
  }

  let appraising = false;

  function setAppraising(on) {
    appraising = on;
    appraiseBtn.disabled = on;
    appraiseBtn.classList.toggle('loading', on);
    appraiseLabel.textContent = on ? '鉴定中…' : '鉴定';
  }

  async function appraise() {
    if (appraising) return;

    // 本地模型不需要 key
    if (PROVIDERS[currentProvider()].kind !== 'local' && !getKey()) {
      openKeyModal();
      return;
    }

    appraiseCard.hidden = false;

    if (boardIsEmpty()) {
      renderText('画布还是空的。先画点什么，我才有得鉴定。');
      return;
    }

    setAppraising(true);
    renderLoading();

    const pid = currentProvider();

    try {
      const b64 = snapshotBase64();
      renderText(await callAI(b64));
    } catch (err) {
      renderError(describeError(err, pid));
    } finally {
      setAppraising(false);
    }
  }

  appraiseBtn.addEventListener('click', appraise);

  appraiseClose.addEventListener('click', () => {
    appraiseCard.hidden = true;
  });

  appraiseSettings.addEventListener('click', () => {
    appraiseCard.hidden = true;
    openKeyModal();
  });

  // 下拉框：选择用哪家的模型
  PROVIDER_ORDER.forEach((id) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = PROVIDERS[id].label;
    providerSelect.appendChild(opt);
  });

  let prevProvider = currentProvider();

  providerSelect.addEventListener('change', () => {
    // 保存上一家已经填过的模型名，再切到新的一家
    setModel(modelInput.value.trim(), prevProvider);
    prevProvider = providerSelect.value;
    setProviderId(prevProvider);
    syncProviderUI();
    keyInput.value = '';
    keyClearBtn.hidden = !getKey();
    keyInput.focus();
  });

  modelInput.addEventListener('change', () => {
    setModel(modelInput.value.trim(), currentProvider());
  });

  keySaveBtn.addEventListener('click', () => {
    // 以弹窗里选中的那家为准
    const pid = providerSelect.value;
    setProviderId(pid);
    setModel(modelInput.value.trim(), pid);

    if (PROVIDERS[pid].kind !== 'local') {
      const v = keyInput.value.trim();
      if (!v) {
        keyInput.focus();
        return;
      }
      setKey(v, pid);
    }

    closeKeyModal();
    appraise();
  });

  keyClearBtn.addEventListener('click', () => {
    const pid = providerSelect.value;
    setKey('', pid);
    keyInput.value = '';
    keyClearBtn.hidden = true;
    keyInput.focus();
  });

  keyCancelBtn.addEventListener('click', closeKeyModal);

  keyModal.addEventListener('click', (e) => {
    if (e.target === keyModal) closeKeyModal();
  });

  keyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') keySaveBtn.click();
    if (e.key === 'Escape') closeKeyModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !keyModal.hidden) closeKeyModal();
  });

  /* ============ 启动 ============ */

  buildSwatches();
  setColor(state.color);
  syncSizeSlider();
  paintRange(tolSlider);
  setTool('brush');
  loadLocal();   // 有上次没画完的画就恢复回来
  render();
  syncHistoryButtons();
})();
