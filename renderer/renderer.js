const openPdfBtn = document.getElementById('openPdfBtn');
const prevPageBtn = document.getElementById('prevPageBtn');
const nextPageBtn = document.getElementById('nextPageBtn');
const pageIndicator = document.getElementById('pageIndicator');
const zoomOutBtn = document.getElementById('zoomOutBtn');
const zoomInBtn = document.getElementById('zoomInBtn');
const zoomIndicator = document.getElementById('zoomIndicator');
const pagerPositionSelect = document.getElementById('pagerPositionSelect');
const statusBar = document.getElementById('statusBar');
const pageHost = document.getElementById('pageHost');
const viewerContainer = document.getElementById('viewerContainer');
const hoverTooltip = document.getElementById('hoverTooltip');
const fileMeta = document.getElementById('fileMeta');

const LOCAL_MODEL_ID = 'Xenova/opus-mt-en-zh';

const FAST_DICTIONARY = new Map([
  ['the', '这/该'],
  ['a', '一个'],
  ['an', '一个'],
  ['of', '的'],
  ['to', '到/用于'],
  ['and', '并且'],
  ['in', '在'],
  ['for', '用于'],
  ['with', '与'],
  ['from', '来自'],
  ['model', '模型'],
  ['models', '模型（复）'],
  ['method', '方法'],
  ['methods', '方法（复）'],
  ['result', '结果'],
  ['results', '结果（复）'],
  ['dataset', '数据集'],
  ['datasets', '数据集（复）'],
  ['algorithm', '算法'],
  ['algorithms', '算法（复）'],
  ['experiment', '实验'],
  ['experiments', '实验（复）'],
  ['performance', '性能'],
  ['accuracy', '准确率'],
  ['analysis', '分析'],
  ['figure', '图'],
  ['table', '表'],
]);

let pdfjsLib = null;
let pdfDoc = null;
let currentPage = 1;
let renderScale = 1.25;
let rendering = false;
let hoverTimer = null;
let TextLayerClass = null;
let hoverSeq = 0;
let currentWordBoxes = [];
let swipeAccumX = 0;
let lastSwipeAt = 0;
let swipeResetTimer = null;

let translatorPromise = null;
let localModelUnavailable = false;

const pageTextCache = new Map();
const translationCache = new Map();
const inflightTranslation = new Map();
const PAGER_POSITION_KEY = 'pager-position';
const ZOOM_MIN = 0.75;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.25;

function setStatus(message) {
  statusBar.textContent = message;
}

function decodeBase64ToUint8(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildWordHitboxes(textContent, viewport) {
  const boxes = [];
  const vpScale = viewport?.scale || 1;
  const util = pdfjsLib?.Util;
  if (!util || !Array.isArray(textContent?.items)) return boxes;

  for (const item of textContent.items) {
    const raw = String(item?.str || '');
    if (!raw) continue;

    const words = [...raw.matchAll(/[A-Za-z0-9-]+/g)];
    if (!words.length) continue;

    const matrix = util.transform(viewport.transform, item.transform);
    const itemX = matrix[4];
    const itemY = matrix[5];
    const itemWidth = Math.max(1, Math.abs((item.width || 0) * vpScale));
    const itemHeight = Math.max(
      8,
      Math.abs((item.height || 0) * vpScale),
      Math.hypot(matrix[2] || 0, matrix[3] || 0) || 0
    );

    const top = itemY - itemHeight;
    const bottom = itemY + itemHeight * 0.2;
    const totalChars = Math.max(1, raw.length);

    for (const word of words) {
      const token = normalizeText(word[0]);
      if (!token) continue;
      const start = word.index || 0;
      const end = start + token.length;
      const left = itemX + (start / totalChars) * itemWidth;
      const right = itemX + (end / totalChars) * itemWidth;
      boxes.push({
        token,
        left: Math.min(left, right),
        right: Math.max(left, right),
        top,
        bottom,
      });
    }
  }

  return boxes;
}

function findTokenAtPoint(wordBoxes, x, y) {
  if (!wordBoxes.length) return '';

  for (const box of wordBoxes) {
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
      return box.token;
    }
  }

  let best = null;
  let bestScore = Infinity;
  for (const box of wordBoxes) {
    const dx = x < box.left ? box.left - x : x > box.right ? x - box.right : 0;
    const dy = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
    const score = dx + dy * 1.8;
    if (score < bestScore) {
      bestScore = score;
      best = box;
    }
  }

  return bestScore <= 10 && best ? best.token : '';
}

function splitTextByLimit(text, maxLen) {
  const cleaned = normalizeText(text);
  if (!cleaned) return [];
  if (cleaned.length <= maxLen) return [cleaned];

  const segments = cleaned.split(/(?<=[.!?;:])\s+/);
  const chunks = [];
  let current = '';

  for (const segment of segments) {
    if (!segment) continue;
    const next = current ? `${current} ${segment}` : segment;
    if (next.length <= maxLen) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = '';
    }

    if (segment.length <= maxLen) {
      current = segment;
    } else {
      for (let i = 0; i < segment.length; i += maxLen) {
        chunks.push(segment.slice(i, i + maxLen));
      }
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

async function ensurePdfJs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import('../node_modules/pdfjs-dist/build/pdf.mjs');
  TextLayerClass = pdfjsLib.TextLayer;
  pdfjsLib.GlobalWorkerOptions.workerSrc = '../node_modules/pdfjs-dist/build/pdf.worker.mjs';
  return pdfjsLib;
}

async function ensureLocalTranslator() {
  if (localModelUnavailable) return null;
  if (translatorPromise) return translatorPromise;

  translatorPromise = (async () => {
    setStatus('正在加载本地翻译模型（首次可能需要 1-3 分钟）...');
    const tfModule = await import('../node_modules/@xenova/transformers/dist/transformers.min.js');
    const tf = tfModule?.pipeline
      ? tfModule
      : globalThis.transformers && typeof globalThis.transformers.pipeline === 'function'
        ? globalThis.transformers
        : null;
    if (!tf) {
      throw new Error('当前构建中本地模型运行时不可用');
    }

    tf.env.allowRemoteModels = true;
    tf.env.allowLocalModels = false;
    tf.env.useBrowserCache = true;

    if (tf.env.backends?.onnx?.wasm) {
      tf.env.backends.onnx.wasm.numThreads = 1;
    }

    const translator = await tf.pipeline('translation', LOCAL_MODEL_ID);
    setStatus('本地翻译模型已就绪');
    return translator;
  })().catch((error) => {
    localModelUnavailable = true;
    translatorPromise = null;
    setStatus(`本地模型不可用，已切换词典兜底：${error.message}`);
    throw error;
  });

  return translatorPromise;
}

function quickDictionaryTranslate(token) {
  const normalized = normalizeText(token).toLowerCase();
  return FAST_DICTIONARY.get(normalized) || '';
}

function fallbackTranslate(text, mode) {
  const cleaned = normalizeText(text);
  if (!cleaned) return '';
  if (mode === 'hover') {
    return quickDictionaryTranslate(cleaned) || cleaned;
  }
  const parts = cleaned.split(/(\W+)/);
  const translated = parts.map((part) => {
    if (!/^[A-Za-z][A-Za-z-]*$/.test(part)) return part;
    return FAST_DICTIONARY.get(part.toLowerCase()) || part;
  });
  return translated.join('');
}

async function requestTranslation(text, mode) {
  const cleaned = normalizeText(text);
  if (!cleaned) return '';

  const cacheKey = `${mode}::${cleaned}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);
  if (inflightTranslation.has(cacheKey)) return inflightTranslation.get(cacheKey);

  const task = (async () => {
    if (mode === 'hover') {
      const quick = quickDictionaryTranslate(cleaned);
      if (quick) return quick;
    }

    let translator = null;
    try {
      translator = await ensureLocalTranslator();
    } catch {
      return fallbackTranslate(cleaned, mode);
    }

    if (!translator) return fallbackTranslate(cleaned, mode);

    const maxLen = mode === 'hover' ? 140 : 700;
    const chunks = splitTextByLimit(cleaned, maxLen);
    const outputs = [];

    for (const chunk of chunks) {
      const response = await translator(chunk, {
        max_new_tokens: mode === 'hover' ? 96 : 420,
      });

      const translated = Array.isArray(response)
        ? response.map((item) => item.translation_text || '').join(' ')
        : response?.translation_text || '';

      outputs.push(normalizeText(translated));
    }

    return outputs.join(' ').trim() || fallbackTranslate(cleaned, mode);
  })()
    .then((translated) => {
      translationCache.set(cacheKey, translated);
      return translated;
    })
    .finally(() => {
      inflightTranslation.delete(cacheKey);
    });

  inflightTranslation.set(cacheKey, task);
  return task;
}

function updatePager() {
  const total = pdfDoc?.numPages || '--';
  pageIndicator.textContent = `第 ${currentPage} / ${total} 页`;
  prevPageBtn.disabled = !pdfDoc || currentPage <= 1;
  nextPageBtn.disabled = !pdfDoc || currentPage >= pdfDoc.numPages;
  updateZoomUi();
}

function updateZoomUi() {
  zoomIndicator.textContent = `${Math.round(renderScale * 100)}%`;
  const noPdf = !pdfDoc;
  zoomOutBtn.disabled = noPdf || renderScale <= ZOOM_MIN + 0.001;
  zoomInBtn.disabled = noPdf || renderScale >= ZOOM_MAX - 0.001;
}

function applyPagerPosition(position) {
  const valid = new Set(['bottom-right', 'bottom-left', 'top-right']);
  const next = valid.has(position) ? position : 'bottom-right';
  document.body.classList.remove('pager-pos-bottom-right', 'pager-pos-bottom-left', 'pager-pos-top-right');
  document.body.classList.add(`pager-pos-${next}`);
  pagerPositionSelect.value = next;
  localStorage.setItem(PAGER_POSITION_KEY, next);
}

function showTooltip(text, x, y) {
  hoverTooltip.textContent = text;
  hoverTooltip.classList.remove('hidden');
  const pad = 12;
  const left = Math.min(window.innerWidth - hoverTooltip.offsetWidth - pad, x + 16);
  const top = Math.min(window.innerHeight - hoverTooltip.offsetHeight - pad, y + 16);
  hoverTooltip.style.left = `${Math.max(pad, left)}px`;
  hoverTooltip.style.top = `${Math.max(pad, top)}px`;
}

function hideTooltip() {
  hoverTooltip.classList.add('hidden');
}

function bindHoverTranslation(textLayer, pageEl) {
  textLayer.addEventListener('pointerleave', () => {
    hideTooltip();
    hoverSeq += 1;
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  });

  textLayer.addEventListener('pointermove', (event) => {
    const pageRect = pageEl.getBoundingClientRect();
    const localX = event.clientX - pageRect.left;
    const localY = event.clientY - pageRect.top;
    const token = findTokenAtPoint(currentWordBoxes, localX, localY);
    if (!token || token.length > 36) {
      hideTooltip();
      return;
    }

    if (hoverTimer) clearTimeout(hoverTimer);

    const seq = ++hoverSeq;
    const x = event.clientX;
    const y = event.clientY;

    hoverTimer = setTimeout(async () => {
      try {
        const translated = await requestTranslation(token, 'hover');
        if (seq !== hoverSeq) return;
        showTooltip(`${token} → ${translated}`, x, y);
      } catch (error) {
        if (seq !== hoverSeq) return;
        showTooltip(`本地翻译失败：${error.message}`, x, y);
      }
    }, 120);
  });
}

async function renderCurrentPage() {
  if (!pdfDoc || rendering) return;
  rendering = true;
  setStatus(`正在渲染第 ${currentPage} 页...`);

  try {
    const page = await pdfDoc.getPage(currentPage);
    const viewport = page.getViewport({ scale: renderScale });

    pageHost.innerHTML = '';

    const pageEl = document.createElement('div');
    pageEl.className = 'page';
    pageEl.style.width = `${viewport.width}px`;
    pageEl.style.height = `${viewport.height}px`;

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * window.devicePixelRatio);
    canvas.height = Math.floor(viewport.height * window.devicePixelRatio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const context = canvas.getContext('2d', { alpha: false });
    context.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);

    pageEl.appendChild(canvas);

    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    pageEl.appendChild(textLayer);

    pageHost.appendChild(pageEl);

    await page.render({ canvasContext: context, viewport }).promise;

    const textContent = await page.getTextContent();
    pageTextCache.set(
      currentPage,
      textContent.items.map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim()
    );

    const textLayerRenderer = new TextLayerClass({
      textContentSource: textContent,
      container: textLayer,
      viewport,
    });
    await textLayerRenderer.render();

    currentWordBoxes = buildWordHitboxes(textContent, viewport);
    bindHoverTranslation(textLayer, pageEl);
    viewerContainer.scrollTop = 0;
    setStatus(`第 ${currentPage} 页已就绪（悬停词语可翻译）`);
  } catch (error) {
    setStatus(`渲染失败：${error.message}`);
  } finally {
    rendering = false;
    updatePager();
  }
}

async function loadPdfFromPath(filePath) {
  const { readPdfFile } = window.pdfTranslatorApi;
  setStatus('正在读取 PDF 文件...');
  const file = await readPdfFile(filePath);

  fileMeta.textContent = `${file.name} · ${(file.size / (1024 * 1024)).toFixed(2)} MB`;

  pageTextCache.clear();
  translationCache.clear();

  const bytes = decodeBase64ToUint8(file.bytesBase64);
  const lib = await ensurePdfJs();
  setStatus('正在加载 PDF 解析器...');
  const loadingTask = lib.getDocument({ data: bytes });
  pdfDoc = await loadingTask.promise;
  currentPage = 1;
  updatePager();
  await renderCurrentPage();

  ensureLocalTranslator().catch((error) => {
    setStatus(`本地模型预加载失败：${error.message}`);
  });
}

async function openPdf() {
  try {
    const { canceled, path } = await window.pdfTranslatorApi.pickPdfFile();
    if (canceled || !path) {
      setStatus('已取消文件选择');
      return;
    }
    await loadPdfFromPath(path);
  } catch (error) {
    setStatus(`打开失败：${error.message}`);
  }
}

openPdfBtn.addEventListener('click', openPdf);

prevPageBtn.addEventListener('click', async () => {
  if (!pdfDoc || currentPage <= 1) return;
  currentPage -= 1;
  updatePager();
  await renderCurrentPage();
});

nextPageBtn.addEventListener('click', async () => {
  if (!pdfDoc || currentPage >= pdfDoc.numPages) return;
  currentPage += 1;
  updatePager();
  await renderCurrentPage();
});

zoomOutBtn.addEventListener('click', async () => {
  const next = Math.max(ZOOM_MIN, renderScale - ZOOM_STEP);
  if (Math.abs(next - renderScale) < 0.001 || !pdfDoc) return;
  renderScale = next;
  updateZoomUi();
  await renderCurrentPage();
});

zoomInBtn.addEventListener('click', async () => {
  const next = Math.min(ZOOM_MAX, renderScale + ZOOM_STEP);
  if (Math.abs(next - renderScale) < 0.001 || !pdfDoc) return;
  renderScale = next;
  updateZoomUi();
  await renderCurrentPage();
});

pagerPositionSelect.addEventListener('change', () => {
  applyPagerPosition(pagerPositionSelect.value);
});

function normalizeWheelDelta(event) {
  if (event.deltaMode === 1) return event.deltaX * 16;
  if (event.deltaMode === 2) return event.deltaX * window.innerWidth;
  return event.deltaX;
}

function triggerFlipBySignedDelta(deltaX) {
  if (deltaX > 0) {
    nextPageBtn.click();
  } else {
    prevPageBtn.click();
  }
}

viewerContainer.addEventListener('wheel', (event) => {
  if (!pdfDoc) return;

  const now = Date.now();
  const cooldownMs = 260;
  if (now - lastSwipeAt < cooldownMs) return;

  let dx = normalizeWheelDelta(event);
  let dy = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 80 : event.deltaY;

  if (event.shiftKey && Math.abs(dx) < 4 && Math.abs(dy) > 10) {
    dx = dy;
  }

  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (absX < 6 || absX <= absY) return;

  if (swipeResetTimer) clearTimeout(swipeResetTimer);
  swipeResetTimer = setTimeout(() => {
    swipeAccumX = 0;
  }, 180);

  swipeAccumX += dx;
  const threshold = 90;
  if (Math.abs(swipeAccumX) < threshold) return;

  event.preventDefault();
  lastSwipeAt = now;
  triggerFlipBySignedDelta(swipeAccumX);
  swipeAccumX = 0;
}, { passive: false });

viewerContainer.addEventListener('mousedown', (event) => {
  if (!pdfDoc) return;
  if (event.button === 3) {
    event.preventDefault();
    prevPageBtn.click();
  } else if (event.button === 4) {
    event.preventDefault();
    nextPageBtn.click();
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft') prevPageBtn.click();
  if (event.key === 'ArrowRight') nextPageBtn.click();
});

updatePager();
updateZoomUi();
applyPagerPosition(localStorage.getItem(PAGER_POSITION_KEY) || 'bottom-right');
setStatus('准备就绪。打开 PDF 后，将鼠标悬停在英文词语上即可翻译。');
