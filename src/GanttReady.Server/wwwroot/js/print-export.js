// print-export.js — GanttReady fork 补丁 #2：打印出图（校核版可打印）
// 功能：纸张(A3/A4 横向) + 列组(当前/交付5列) + 配色(原色/交付品红浅绿/暗标灰阶) + 高清无损 PDF
// 说明：关系线/今日线/资源直方图/网格线沿用工具栏既有开关（直接作用于导出内容）；
//       列组在导出克隆里按表头文本索引隐藏，不改动项目的列设置数据。
(function () {
  'use strict';

  // ---- 配色样式（一次性注入，作用域限定在克隆容器的 palette 类上）----
  var PALETTE_CSS = [
    '.print-palette-delivery .bar-plan{background:#a9d18e!important}',
    '.print-palette-delivery .bar-critical .bar-plan{background:#d63384!important}',
    '.print-palette-delivery .parent-task .bar-plan{background:#595959!important}',
    '.print-palette-delivery .bar-act{display:none!important}',
    '.print-palette-delivery .gantt-bar.bar-milestone-flag{background:#c00000!important}',
    '.print-palette-delivery .task-status-badge{background:#fff!important;color:#333!important;border:1px solid #999!important}',
    '.print-palette-delivery .gantt-left-row.zebra{background:#fff!important}',
    '.print-palette-mono .bar-plan{background:#bfbfbf!important}',
    '.print-palette-mono .bar-critical .bar-plan{background:#404040!important}',
    '.print-palette-mono .parent-task .bar-plan{background:#808080!important}',
    '.print-palette-mono .bar-act{display:none!important}',
    '.print-palette-mono .gantt-bar.bar-milestone-flag{background:#404040!important}',
    '.print-palette-mono .task-status-badge{background:#fff!important;color:#000!important;border:1px solid #666!important}',
    '.print-palette-mono .gantt-left-row.zebra{background:#fff!important}',
    '.print-palette-delivery .gantt-left-row.selected,.print-palette-mono .gantt-left-row.selected{background:#fff!important}',
    '.print-palette-delivery .gantt-left-row.selected .col-code,.print-palette-mono .gantt-left-row.selected .col-code{color:#000!important}',
    '.print-palette-delivery .gantt-left-row.parent,.print-palette-mono .gantt-left-row.parent{box-shadow:none!important;background:#fff!important;font-weight:700!important}',
    '.print-palette-delivery .gantt-bar-frame.parent-task,.print-palette-mono .gantt-bar-frame.parent-task{box-shadow:none!important}',
    '.print-palette-delivery .gantt-bar-frame,.print-palette-mono .gantt-bar-frame{box-shadow:none!important}',
    '.print-export-hide{display:none!important}'
  ].join('\n');

  function ensurePaletteStyle(doc) {
    var style = doc.getElementById('print-palette-css');
    if (!style) {
      style = doc.createElement('style');
      style.id = 'print-palette-css';
      style.textContent = PALETTE_CSS;
      doc.head.appendChild(style);
    }
  }

  // ---- 交付 5 列：按表头文本计算需隐藏的列索引 ----
  var DELIVERY5_HEADERS = ['任务代码', '任务名称', '工期', '计划开始', '计划完成'];
  function computeHideIndexes(doc) {
    var headerRow = doc.querySelector('.gantt-left-header');
    if (!headerRow) return [];
    var hide = [];
    Array.prototype.forEach.call(headerRow.children, function (cell, i) {
      var text = (cell.textContent || '').trim();
      if (DELIVERY5_HEADERS.indexOf(text) === -1) hide.push(i);
    });
    return hide;
  }

  function applyColumnHiding(doc, hideIdx) {
    if (!hideIdx || !hideIdx.length) return;
    var rows = doc.querySelectorAll('.gantt-left-header, .gantt-left-row');
    Array.prototype.forEach.call(rows, function (row) {
      Array.prototype.forEach.call(row.children, function (cell, i) {
        if (hideIdx.indexOf(i) !== -1) cell.classList.add('print-export-hide');
      });
    });
  }

  // ---- 打开克隆的滚动/裁剪，保证全幅内容入图（横+纵）----
  // 两遍展开：内层先撑开（.gantt-bars 等），外层（.gantt-container）才能取到真实 scrollWidth。
  // 注意 querySelectorAll 不含克隆根自身，.gantt-container 需显式加入（否则其 100vh 高度撑出大片空白）。
  function expandForCapture(doc) {
    var root = doc.querySelector('.gantt-container');
    var els = Array.prototype.slice.call(doc.querySelectorAll(
      '.gantt-chart,.gantt-right,.gantt-main,.gantt-left,' +
      '.gantt-left-body,.gantt-left-header,.header-scroll,.gantt-bars,.gantt-grid-lines,.gantt-relation-lines,.gantt-hgrid'));
    if (root) els.unshift(root);
    for (var pass = 0; pass < 2; pass++) {
      Array.prototype.forEach.call(els, function (el) {
        el.style.height = 'auto';
        el.style.maxHeight = 'none';
        el.style.minHeight = '0';   // 压掉 min-height:calc(100vh-…) 留白
        el.style.overflow = 'visible';
        el.style.flex = 'none';
        try { el.scrollLeft = 0; el.scrollTop = 0; } catch (e) { }
        if (el.scrollWidth > el.clientWidth) {
          el.style.width = el.scrollWidth + 'px';
        }
      });
    }
  }

  function addTitle(doc, paletteName) {
    var name = '';
    var sb = doc.querySelector('.gantt-statusbar');
    if (sb) {
      var m = (sb.textContent || '').match(/项目：([^｜|]+)/);
      if (m) name = m[1].trim();
    }
    if (!name) name = document.title || '甘特图';
    var div = doc.createElement('div');
    div.style.cssText = 'font:bold 20px/1.4 sans-serif;text-align:center;padding:6px 0 10px 0;color:#000;';
    div.textContent = name + ' —— 施工进度横道图（校核版·' + paletteName + '）  打印时间：' +
      new Date().toLocaleDateString('zh-CN');
    var container = doc.querySelector('.gantt-container');
    if (container) container.insertBefore(div, container.firstChild);
  }

  // ---- 出图缩放（fork 补丁 #2.1）：dayWidth = 40 × zoom%，内容宽随缩放线性变化 ----
  function setZoom(z) {
    var slider = document.querySelector('.zoom-slider');
    if (!slider) return;
    slider.value = String(z);
    ['input', 'change'].forEach(function (ev) {
      slider.dispatchEvent(new Event(ev, { bubbles: true }));
    });
  }
  function waitForRender(prevW, cb, tries) {
    var right = document.querySelector('.gantt-right');
    var w = right ? right.scrollWidth : 0;
    if (tries <= 0 || (prevW >= 0 && Math.abs(w - prevW) < 2)) { setTimeout(cb, 120); return; }
    setTimeout(function () { waitForRender(w, cb, tries - 1); }, 150);
  }
  function autoFitZoom() {
    var slider = document.querySelector('.zoom-slider');
    var right = document.querySelector('.gantt-right');
    var left = document.querySelector('.gantt-left');
    if (!slider || !right) return null;
    var barsW = Math.max(right.scrollWidth, 1);
    var leftW = left ? left.clientWidth : 700;
    var targetBars = Math.max(900, 3600 - leftW);   // 目标总宽 ≈3600px（A3@scale3 视觉最佳区间）
    var cur = parseFloat(slider.value) || 100;
    var z = Math.round(Math.min(100, Math.max(5, cur * targetBars / barsW)) / 5) * 5;
    return z < cur ? z : null;                      // 只缩不放
  }

  function exportPdf(opts) {
    var container = document.querySelector('.gantt-container');
    if (!container) { alert('未找到甘特图容器'); return; }
    ensurePaletteStyle(document);

    // 自适应清晰度：画布宽超 ~8000px 会触及浏览器 canvas 尺寸上限导致 PNG 损坏。
    // 注意：条形为绝对定位，滚动宽度记在其包含块（.gantt-right/.gantt-chart）上，
    // html2canvas 又按 onclone 展开后的克隆尺寸×scale 定画布 —— 故必须取真包含块的 scrollWidth。
    var parts = ['.gantt-chart', '.gantt-right', '.gantt-main', '.gantt-left-body'];
    var contentW = container.scrollWidth || 0;
    parts.forEach(function (sel) {
      var el = document.querySelector(sel);
      if (el && el.scrollWidth > contentW) contentW = el.scrollWidth;
    });
    contentW = contentW || 1600;
    // 允许 scale<1：超宽项目把画布压到 ~8000px（420mm 上≈484dpi，仍远超打印需求）
    var scale = Math.min(3, Math.max(0.25, 8000 / contentW));

    // 自动出图缩放：宽项目先降 zoom（改 dayWidth）再捕获，截完还原屏幕缩放
    var restoreZoomTo = null;
    if (opts.exportZoom === 'auto') {
      var z = autoFitZoom();
      if (z !== null) {
        var slider0 = document.querySelector('.zoom-slider');
        restoreZoomTo = slider0 ? slider0.value : null;
        setZoom(z);
      }
    }
    var finishRestore = function () {
      if (restoreZoomTo !== null) {
        var z = restoreZoomTo;
        restoreZoomTo = null;
        setZoom(z);
      }
    };

    console.debug('[print-export] start', JSON.stringify({ opts: opts, contentW: contentW, scale: scale,
      hideCount: opts.columns === 'delivery5' ? computeHideIndexes(document).length : 0,
      palInHead: !!document.getElementById('print-palette-css') }));
    var doCapture = function () { html2canvas(container, {
      useCORS: true,
      scale: scale,                   // 高清 PNG 无损；宽项目自适应降档
      backgroundColor: '#fff',
      onclone: function (doc) {
        try {
          var pal = doc.getElementById('print-palette-css');
          var probeBar = doc.querySelector('.gantt-bar-frame.parent-task .bar-plan');
          window.__peOnclone = {
            styleTags: doc.querySelectorAll('style').length,
            paletteInClone: !!pal,
            paletteLen: pal ? pal.textContent.length : 0,
            stylesheetLinks: doc.querySelectorAll('link[rel=stylesheet]').length,
            headChildren: doc.head ? doc.head.children.length : -1,
            headTail: doc.head ? [...doc.head.children].slice(-4).map(function (e) { return e.tagName + (e.id ? '#' + e.id : ''); }) : null,
            parentBarPal: (function () { if (!probeBar) return 'no-bar'; for (var i = 0; i < doc.styleSheets.length; i++) { try { var rules = doc.styleSheets[i].cssRules; for (var j = 0; j < rules.length; j++) { if (rules[j].selectorText && rules[j].selectorText.indexOf('.print-palette-delivery .parent-task') !== -1) return 'found@sheet' + i; } } catch (e) { return 'sheetErr@' + i; } } return 'NOT-FOUND'; })()
          };
        } catch (e) { window.__peOnclone = { err: e.message }; }
        var root = doc.querySelector('.gantt-container');
        if (root && opts.palette === 'delivery') root.classList.add('print-palette-delivery');
        if (root && opts.palette === 'mono') root.classList.add('print-palette-mono');
        if (opts.columns === 'delivery5') applyColumnHiding(doc, computeHideIndexes(doc));
        expandForCapture(doc);
        if (opts.includeTitle) addTitle(doc, opts.paletteName || '');
      }
    }).then(function (canvas) {
      finishRestore();
      try {
        var jsPdfCtor = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
        if (!jsPdfCtor) { alert('jsPDF 未加载'); return; }
        var pdf = new jsPdfCtor({ orientation: 'l', unit: 'mm', format: opts.paper });
        var pw = pdf.internal.pageSize.getWidth();
        var ph = pdf.internal.pageSize.getHeight();
        var ratio = Math.min(pw / canvas.width, ph / canvas.height);
        var w = canvas.width * ratio, h = canvas.height * ratio;
        pdf.addImage(canvas.toDataURL('image/png'), 'PNG', (pw - w) / 2, (ph - h) / 2, w, h);
        pdf.save('甘特图_' + opts.paper.toUpperCase() + '_' + new Date().toISOString().slice(0, 10) + '.pdf');
      } catch (e) {
        console.error('print-export PDF error:', e);
        alert('PDF 生成失败：' + e.message);
      }
    }).catch(function (e) {
      finishRestore();
      console.error('html2canvas error:', e);
      alert('渲染失败：' + e.message);
    });
    };
    if (restoreZoomTo !== null) { waitForRender(-1, function () { doCapture(); }, 12); }
    else { doCapture(); }
  }

  // ---- 对话框 ----
  function openDialog() {
    var old = document.getElementById('print-export-overlay');
    if (old) old.remove();

    var overlay = document.createElement('div');
    overlay.id = 'print-export-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:99999;display:flex;align-items:center;justify-content:center;';

    var box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.25);width:400px;padding:18px 20px;font:13px/1.7 sans-serif;color:#222;';

    box.innerHTML =
      '<div style="font-size:15px;font-weight:700;margin-bottom:10px;">打印出图（校核版）</div>' +
      '<div style="margin-bottom:8px;"><b>纸张：</b>' +
      '<label style="margin-right:12px;"><input type="radio" name="pe-paper" value="a3" checked> A3 横向</label>' +
      '<label><input type="radio" name="pe-paper" value="a4"> A4 横向</label></div>' +
      '<div style="margin-bottom:8px;"><b>列组：</b>' +
      '<label style="margin-right:12px;"><input type="radio" name="pe-columns" value="current" checked> 当前列设置</label>' +
      '<label><input type="radio" name="pe-columns" value="delivery5"> 交付5列（代码/名称/工期/开始/完成）</label></div>' +
      '<div style="margin-bottom:8px;"><b>配色：</b>' +
      '<label style="margin-right:8px;"><input type="radio" name="pe-palette" value="screen" checked> 屏幕原色</label>' +
      '<label style="margin-right:8px;"><input type="radio" name="pe-palette" value="delivery"> 交付配色</label>' +
      '<label><input type="radio" name="pe-palette" value="mono"> 暗标灰阶</label></div>' +
      '<div style="margin-bottom:8px;"><b>出图缩放：</b>' +
      '<label style="margin-right:12px;"><input type="radio" name="pe-ezoom" value="auto" checked> 自动适配（推荐）</label>' +
      '<label><input type="radio" name="pe-ezoom" value="current"> 当前屏幕缩放</label></div>' +
      '<div style="margin-bottom:8px;"><label><input type="checkbox" id="pe-title" checked> 含项目名标题</label></div>' +
      '<div style="color:#888;font-size:12px;margin-bottom:10px;">提示：关系线/今日线/资源直方图/网格线由工具栏开关控制；导出为高清无损 PNG 入 PDF；未显示的交付列不会被补出。自动缩放会在出图瞬间按内容宽调整 dayWidth 并在完成后还原屏幕缩放。</div>' +
      '<div style="text-align:right;">' +
      '<button id="pe-cancel" style="padding:5px 14px;margin-right:8px;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer;">取消</button>' +
      '<button id="pe-ok" style="padding:5px 16px;border:0;border-radius:4px;background:#2b6cb0;color:#fff;cursor:pointer;">生成 PDF</button></div>';

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    box.querySelector('#pe-cancel').addEventListener('click', function () { overlay.remove(); });
    box.querySelector('#pe-ok').addEventListener('click', function () {
      var paper = box.querySelector('input[name="pe-paper"]:checked').value;
      var columns = box.querySelector('input[name="pe-columns"]:checked').value;
      var palette = box.querySelector('input[name="pe-palette"]:checked').value;
      var includeTitle = box.querySelector('#pe-title').checked;
      var exportZoom = box.querySelector('input[name="pe-ezoom"]:checked').value;
      var paletteName = palette === 'delivery' ? '交付配色' : palette === 'mono' ? '暗标灰阶' : '原色';
      overlay.remove();
      exportPdf({ paper: paper, columns: columns, palette: palette, includeTitle: includeTitle, paletteName: paletteName, exportZoom: exportZoom });
    });
  }

  // ---- loading 提示 ----
  function loading(show, text) {
    var el = document.getElementById('pe-loading');
    if (show) {
      if (!el) {
        el = document.createElement('div');
        el.id = 'pe-loading';
        el.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:100000;background:#1a73e8;color:#fff;padding:8px 22px;border-radius:20px;font:13px sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.3);';
        document.body.appendChild(el);
      }
      el.textContent = text || '正在生成…';
    } else if (el) el.remove();
  }

  // ---- 内容 bbox 裁边：扫掉轴尾部等纯空白（html2canvas 画布→canvas 裁剪）----
  function trimCanvas(c) {
    try {
      var ctx = c.getContext('2d');
      var d = ctx.getImageData(0, 0, c.width, c.height).data;
      var w = c.width, h = c.height;
      var x0 = w, x1 = -1, y0 = h, y1 = -1;
      var step = 4;                       // 采样步长加速
      for (var y = 0; y < h; y += step) {
        for (var x = 0; x < w; x += step) {
          if (d[(y * w + x) * 4 + 3] > 8 && !(d[(y * w + x) * 4] > 245 && d[(y * w + x) * 4 + 1] > 245 && d[(y * w + x) * 4 + 2] > 245)) {
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) return c;
      var m = 12;                          // 留白边距(px)
      x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m);
      x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
      var out = document.createElement('canvas');
      out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
      out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
      return out;
    } catch (e) { return c; }
  }

  // ---- 共享捕获引擎（供本文件与原生 PNG/PDF 通道复用）----
  window.peCaptureCanvas = function (opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var container = document.querySelector('.gantt-container');
      if (!container) { reject(new Error('未找到甘特图容器')); return; }
      var main = document.querySelector('.gantt-main');
      var right = document.querySelector('.gantt-right');
      var leftBody = document.querySelector('.gantt-left-body');
      var contentW = Math.max(container.scrollWidth || 0, main ? main.scrollWidth : 0,
                              right ? right.scrollWidth : 0, leftBody ? leftBody.scrollWidth : 0) || 1600;
      var scale = Math.min(3, Math.max(0.25, (opts.scaleCap || 8000) / contentW));
      html2canvas(container, {
        useCORS: true, scale: scale, backgroundColor: '#fff',
        onclone: function (doc) { expandForCapture(doc); }
      }).then(function (canvas) {
        resolve(opts.trim === false ? canvas : trimCanvas(canvas));
      }).catch(reject);
    });
  };

  // ---- 接管原生导出通道（本文件在 netplan.js 之后加载，覆盖同名全局）----
  function downloadCanvasPng(canvas, name) {
    var link = document.createElement('a');
    link.download = name; link.href = canvas.toDataURL('image/png'); link.click();
  }
  window.exportGanttToPng = function () {
    loading(true, '正在导出图片…');
    window.peCaptureCanvas({}).then(function (canvas) {
      loading(false);
      downloadCanvasPng(canvas, '甘特图_' + new Date().toISOString().slice(0, 10) + '.png');
    }).catch(function (e) { loading(false); alert('导出图片失败：' + e.message); });
  };
  window.exportGanttToPdf = function () {
    loading(true, '正在生成 PDF…');
    window.peCaptureCanvas({}).then(function (canvas) {
      try {
        var jsPdfCtor = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
        if (!jsPdfCtor) { loading(false); alert('jsPDF 未加载'); return; }
        var pdf = new jsPdfCtor({ orientation: 'l', unit: 'mm', format: 'a3' });
        var pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
        var ratio = Math.min(pw / canvas.width, ph / canvas.height);
        var w = canvas.width * ratio, h = canvas.height * ratio;
        pdf.addImage(canvas.toDataURL('image/png'), 'PNG', (pw - w) / 2, (ph - h) / 2, w, h);
        pdf.save('甘特图_' + new Date().toISOString().slice(0, 10) + '.pdf');
        loading(false);
      } catch (e) { loading(false); alert('PDF 生成失败：' + e.message); }
    }).catch(function (e) { loading(false); alert('PDF 生成失败：' + e.message); });
  };

  window.printExportDialog = openDialog;
})();
