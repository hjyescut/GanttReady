// print-export.js — GanttReady fork：打印出图 + 原生 PNG/PDF 通道接管（v2.5）
// 功能：纸张(A3/A4/A2/A1 横向) + 列组(当前/交付5列) + 配色(原色/交付品红浅绿/暗标灰阶)
//       + 自动出图缩放(dayWidth 适配) + 高清无损 PNG 入 PDF + 像素级空白裁边 + loading 反馈
// 已修坑：html2canvas iframe 克隆根元素/绝对定位真宽/inset box-shadow 蓝块/
//         repeating 渐变小尺寸瓦片 createPattern 崩溃（汇总条斜纹实色化）
(function () {
  'use strict';

  // ================= html2canvas createPattern 运行时补丁 =================
  // repeating 渐变在小尺寸元素上（dayWidth 2px 级）会让 html2canvas 内部算出 0 尺寸瓦片画布，
  // createPattern 直接抛 InvalidStateError。0 尺寸图案本就不可见 → 替换 1×1 透明画布，全路径免疫。
  (function patchCreatePattern() {
    if (typeof CanvasRenderingContext2D === 'undefined') return;
    var orig = CanvasRenderingContext2D.prototype.createPattern;
    CanvasRenderingContext2D.prototype.createPattern = function (img, rep) {
      try {
        if (img && (img.width === 0 || img.height === 0)) {
          var fix = document.createElement('canvas');
          fix.width = 1; fix.height = 1;
          return orig.call(this, fix, rep);
        }
      } catch (e) { }
      return orig.call(this, img, rep);
    };
  })();

  // ================= 色板 =================
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
    // 选中行/汇总行中和（html2canvas 对 inset box-shadow 渲染异常：3px 左缘条会被画成整行色块）
    '.print-palette-delivery .gantt-left-row.selected,.print-palette-mono .gantt-left-row.selected{background:#fff!important}',
    '.print-palette-delivery .gantt-left-row.parent,.print-palette-mono .gantt-left-row.parent{box-shadow:none!important;background:#fff!important;font-weight:700!important}',
    '.print-palette-delivery .gantt-bar-frame,.print-palette-mono .gantt-bar-frame{box-shadow:none!important}',
    '.print-export-hide{display:none!important}'
  ].join('\n');

  function ensurePaletteStyle(doc) {
    var style = doc.getElementById('print-palette-css');
    if (!style) {
      style = doc.createElement('style');
      style.id = 'print-palette-css';
      doc.head.appendChild(style);
    }
    style.textContent = PALETTE_CSS;   // 幂等：无论新旧都重写
  }

  // ================= 列组 =================
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
  // 隐藏列后收缩左表容器宽度：18 列的容器宽度不会自动缩，条形区被顶到右边留出大空档
  function shrinkLeftTable(doc) {
    var header = doc.querySelector('.gantt-left-header');
    var left = doc.querySelector('.gantt-left');
    if (!header || !left) return;
    var sum = 0;
    Array.prototype.forEach.call(header.children, function (cell) {
      if (cell.classList.contains('print-export-hide')) return;
      sum += cell.offsetWidth || 0;
    });
    if (sum < 50) return;
    var w = Math.ceil(sum) + 2;
    left.style.width = w + 'px';
    left.style.flex = 'none';
    var lb = doc.querySelector('.gantt-left-body');
    var lh = doc.querySelector('.gantt-left-header');
    if (lb) lb.style.width = w + 'px';
    if (lh) lh.style.width = w + 'px';
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

  // ================= 克隆净化 =================
  // 汇总条斜纹实色化：repeating-linear-gradient 是全文档唯一的 repeating 渐变，
  // 小尺寸（dayWidth 2px 级）下 html2canvas 的瓦片画布算出 0 尺寸 → createPattern 崩溃。
  // 换实色蓝（视觉等价）；插入在色板之前，色板同特异性 !important 靠后者胜，不干扰三色板。
  function neutralizeHatch(doc) {
    var st = doc.createElement('style');
    st.textContent = '.gantt-bar-frame.parent-task .bar-plan{background:#1890ff!important}';
    var pal = doc.getElementById('print-palette-css');
    if (pal && pal.parentNode) pal.parentNode.insertBefore(st, pal);
    else doc.head.appendChild(st);
  }
  // 0 尺寸条隐藏（0 工期任务在缩放后宽度为 0）
  function hideZeroBars(doc) {
    // 含条形内部子元素（.bar-act 进度条在 0% 进度时宽度为 0，
    // 其绿色渐变 + 默认 background-repeat 会触发 html2canvas createPattern 0 尺寸崩溃）
    Array.prototype.forEach.call(doc.querySelectorAll('.gantt-bar-frame, .gantt-bar-frame *'), function (f) {
      if (f.offsetWidth === 0 || f.offsetHeight === 0) f.style.display = 'none';
    });
  }
  // 两遍展开（内层先撑开外层才能量到真宽）；querySelectorAll 不含克隆根，根须显式加入
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
        el.style.minHeight = '0';
        el.style.overflow = 'visible';
        el.style.flex = 'none';
        try { el.scrollLeft = 0; el.scrollTop = 0; } catch (e) { }
        if (el.scrollWidth > el.clientWidth) el.style.width = el.scrollWidth + 'px';
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

  // ================= 像素级裁边 =================
  function trimCanvas(c) {
    try {
      var ctx = c.getContext('2d');
      var d = ctx.getImageData(0, 0, c.width, c.height).data;
      var w = c.width, h = c.height;
      var x0 = w, x1 = -1, y0 = h, y1 = -1;
      var step = 4;
      for (var y = 0; y < h; y += step) {
        for (var x = 0; x < w; x += step) {
          var k = (y * w + x) * 4;
          if (d[k + 3] > 8 && !(d[k] > 245 && d[k + 1] > 245 && d[k + 2] > 245)) {
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) return c;
      var m = 12;
      x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m);
      x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
      var out = document.createElement('canvas');
      out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
      out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
      return out;
    } catch (e) { return c; }
  }

  // ================= 自动出图缩放（dayWidth = 40 × zoom%，线性）=================
  function setZoom(z) {
    var slider = document.querySelector('.zoom-slider');
    if (!slider) return;
    slider.value = String(z);
    ['input', 'change'].forEach(function (ev) {
      slider.dispatchEvent(new Event(ev, { bubbles: true }));
    });
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
    if (z >= cur) return null;                      // 只缩不放
    return { z: z, expected: barsW * z / cur };
  }
  function waitZoomApplied(expected, cb) {
    var t0 = Date.now();
    (function poll() {
      var right = document.querySelector('.gantt-right');
      var w = right ? right.scrollWidth : 0;
      if (expected > 0 && Math.abs(w - expected) < expected * 0.3) { setTimeout(cb, 250); return; }
      if (Date.now() - t0 > 4000) { setTimeout(cb, 250); return; }   // 超时兜底
      setTimeout(poll, 200);
    })();
  }

  // ================= loading =================
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

  // ================= 共享捕获引擎 =================
  window.peCaptureCanvas = function (opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var prevZoom = null;
      var finish = function () {
        if (prevZoom !== null) { var z = prevZoom; prevZoom = null; setZoom(z); }
      };
      var doCapture = function () {
        var container = document.querySelector('.gantt-container');
        if (!container) { finish(); reject(new Error('未找到甘特图容器')); return; }
        var main = document.querySelector('.gantt-main');
        var right = document.querySelector('.gantt-right');
        var leftBody = document.querySelector('.gantt-left-body');
        var contentW = Math.max(container.scrollWidth || 0, main ? main.scrollWidth : 0,
                                right ? right.scrollWidth : 0, leftBody ? leftBody.scrollWidth : 0) || 1600;
        var scale = Math.min(3, Math.max(0.25, (opts.scaleCap || 8000) / contentW));
        html2canvas(container, {
          useCORS: true, scale: scale, backgroundColor: '#fff',
          onclone: function (doc) {
            ensurePaletteStyle(doc);
            neutralizeHatch(doc);
            hideZeroBars(doc);
            if (opts.onclone) opts.onclone(doc);   // 列组隐藏+左表收缩必须先于展开，否则容器按 18 列宽展开
            expandForCapture(doc);
            try {   // 尺寸探针：定位上下留白来源
              var root = doc.querySelector('.gantt-container');
              var toDim = function (el) { return el ? Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height) : '-'; };
              window.__peDims = {
                container: toDim(root), main: toDim(doc.querySelector('.gantt-main')),
                left: toDim(doc.querySelector('.gantt-left')), right: toDim(doc.querySelector('.gantt-right')),
                leftBody: toDim(doc.querySelector('.gantt-left-body')), bars: toDim(doc.querySelector('.gantt-bars')),
                chart: toDim(doc.querySelector('.gantt-chart'))
              };
            } catch (e) { }
          }
        }).then(function (canvas) {
          finish();
          resolve(opts.trim === false ? canvas : trimCanvas(canvas));
        }).catch(function (e) { finish(); reject(e); });
      };
      if (opts.autoZoom) {
        var az = autoFitZoom();
        if (az !== null) {
          var slider = document.querySelector('.zoom-slider');
          prevZoom = slider ? slider.value : null;
          setZoom(az.z);
          waitZoomApplied(az.expected, doCapture);
          return;
        }
      }
      doCapture();
    });
  };

  // ================= 打印出图对话框 =================
  function exportPdf(opts) {
    loading(true, '正在渲染（含自动缩放）…');
    window.peCaptureCanvas({
      autoZoom: opts.exportZoom === 'auto',
      scaleCap: 8000,
      onclone: function (doc) {
        var root = doc.querySelector('.gantt-container');
        if (root && opts.palette === 'delivery') root.classList.add('print-palette-delivery');
        if (root && opts.palette === 'mono') root.classList.add('print-palette-mono');
        if (opts.columns === 'delivery5') { applyColumnHiding(doc, computeHideIndexes(doc)); shrinkLeftTable(doc); }
        if (opts.includeTitle) addTitle(doc, opts.paletteName || '');
      }
    }).then(function (canvas) {
      try {
        var jsPdfCtor = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
        if (!jsPdfCtor) { loading(false); alert('jsPDF 未加载'); return; }
        var pdf = new jsPdfCtor({ orientation: 'l', unit: 'mm', format: opts.paper });
        var pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
        var ratio = Math.min(pw / canvas.width, ph / canvas.height);
        var w = canvas.width * ratio, h = canvas.height * ratio;
        pdf.addImage(canvas.toDataURL('image/png'), 'PNG', (pw - w) / 2, (ph - h) / 2, w, h);
        pdf.save('甘特图_' + opts.paper.toUpperCase() + '_' + new Date().toISOString().slice(0, 10) + '.pdf');
        loading(false);
      } catch (e) { loading(false); alert('PDF 生成失败：' + e.message); }
    }).catch(function (e) { loading(false); alert('渲染失败：' + e.message); });
  }

  function openDialog() {
    var old = document.getElementById('print-export-overlay');
    if (old) old.remove();

    var overlay = document.createElement('div');
    overlay.id = 'print-export-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:99999;display:flex;align-items:center;justify-content:center;';

    var box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.25);width:430px;padding:18px 20px;font:13px/1.7 sans-serif;color:#222;';

    box.innerHTML =
      '<div style="font-size:15px;font-weight:700;margin-bottom:10px;">打印出图（校核版）</div>' +
      '<div style="margin-bottom:8px;"><b>纸张：</b>' +
      '<label style="margin-right:10px;"><input type="radio" name="pe-paper" value="a3" checked> A3</label>' +
      '<label style="margin-right:10px;"><input type="radio" name="pe-paper" value="a4"> A4</label>' +
      '<label style="margin-right:10px;"><input type="radio" name="pe-paper" value="a2"> A2</label>' +
      '<label><input type="radio" name="pe-paper" value="a1"> A1（超长工期推荐）</label></div>' +
      '<div style="margin-bottom:8px;"><b>列组：</b>' +
      '<label style="margin-right:12px;"><input type="radio" name="pe-columns" value="delivery5" checked> 交付5列</label>' +
      '<label><input type="radio" name="pe-columns" value="current"> 当前列设置</label></div>' +
      '<div style="margin-bottom:8px;"><b>配色：</b>' +
      '<label style="margin-right:8px;"><input type="radio" name="pe-palette" value="screen" checked> 屏幕原色</label>' +
      '<label style="margin-right:8px;"><input type="radio" name="pe-palette" value="delivery"> 交付配色</label>' +
      '<label><input type="radio" name="pe-palette" value="mono"> 暗标灰阶</label></div>' +
      '<div style="margin-bottom:8px;"><b>出图缩放：</b>' +
      '<label style="margin-right:12px;"><input type="radio" name="pe-ezoom" value="auto" checked> 自动适配（推荐）</label>' +
      '<label><input type="radio" name="pe-ezoom" value="current"> 当前屏幕缩放</label></div>' +
      '<div style="margin-bottom:8px;"><label><input type="checkbox" id="pe-title" checked> 含项目名标题</label></div>' +
      '<div style="color:#888;font-size:12px;margin-bottom:10px;">提示：关系线/今日线/直方图/网格由工具栏开关控制；自动缩放会在出图瞬间按内容宽调整 dayWidth 并在完成后还原；跨 2 年以上工期建议选 A2/A1 纸张。</div>' +
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
      var exportZoom = box.querySelector('input[name="pe-ezoom"]:checked').value;
      var includeTitle = box.querySelector('#pe-title').checked;
      var paletteName = palette === 'delivery' ? '交付配色' : palette === 'mono' ? '暗标灰阶' : '原色';
      overlay.remove();
      exportPdf({ paper: paper, columns: columns, palette: palette, includeTitle: includeTitle, paletteName: paletteName, exportZoom: exportZoom });
    });
  }

  // ================= 接管原生导出通道（本文件在 netplan.js 之后加载）=================
  window.exportGanttToPng = function () {
    loading(true, '正在导出图片…');
    window.peCaptureCanvas({}).then(function (canvas) {
      loading(false);
      var link = document.createElement('a');
      link.download = '甘特图_' + new Date().toISOString().slice(0, 10) + '.png';
      link.href = canvas.toDataURL('image/png');
      link.click();
    }).catch(function (e) { loading(false); alert('导出图片失败：' + e.message); });
  };
  window.exportGanttToPdf = function () {
    loading(true, '正在生成 PDF…');
    window.peCaptureCanvas({ autoZoom: true }).then(function (canvas) {
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
