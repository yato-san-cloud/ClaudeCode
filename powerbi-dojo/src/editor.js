/* ============================================================
 * Power BI 道場 v2 — editor.js
 * window.DojoEditor: highlight / mount / normalize / check
 * highlight / normalize / check は純関数(DOM非依存・Nodeでもテスト可)。
 * mount のみ DOM を使用する。
 * ============================================================ */
(function (global) {
  "use strict";

  /* ---------------- HTMLエスケープ ---------------- */
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* ---------------- ハイライター ----------------
   * 各言語ごとに「1本の結合正規表現+グループ番号→トークン種別」で走査。
   * マッチ間の地の文もマッチ本体もすべて escapeHtml を通す。
   * span class: tok-kw / tok-fn / tok-str / tok-num / tok-com / tok-pun
   */

  // M (Power Query)
  //  1: コメント  2: 文字列  3: 関数(大文字始まり.名前( )  4: キーワード(#date系含む)
  //  5: 数値  6: 記号
  var M_RE = new RegExp(
    "(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)" +
      "|(\"(?:\"\"|[^\"])*\"?)" +
      "|(#?[A-Z][A-Za-z0-9]*(?:\\.[A-Za-z][A-Za-z0-9]*)+(?=\\s*\\())" +
      "|(#(?:datetimezone|datetime|date|duration|time|table|binary|infinity|nan)\\b" +
      "|\\b(?:let|in|each|if|then|else|try|otherwise|type|as|and|or|not|true|false|null|meta|error|is|section|shared)\\b)" +
      "|(\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)" +
      "|([()\\[\\]{}=,;.*+\\-\\/<>&^%@?:!])",
    "g"
  );
  var M_GROUPS = ["tok-com", "tok-str", "tok-fn", "tok-kw", "tok-num", "tok-pun"];

  // DAX
  //  1: コメント(// -- /* */)  2: 文字列  3: メジャー/列参照 [...](tok-fn系の色)
  //  4: 関数(大文字英字列( )  5: キーワード  6: 数値  7: 記号
  var DAX_RE = new RegExp(
    "(\\/\\/[^\\n]*|--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)" +
      "|(\"(?:\"\"|[^\"])*\"?)" +
      "|(\\[[^\\]\\r\\n]*\\]?)" +
      "|([A-Z][A-Z0-9._]*(?=\\s*\\())" +
      "|(\\b(?:VAR|RETURN|TRUE|FALSE|BLANK|IN|NOT|EVALUATE|DEFINE|MEASURE|ORDER|BY|ASC|DESC" +
      "|var|return|true|false|blank|in|not)\\b)" +
      "|(\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)" +
      "|([()\\[\\]{}=,;.*+\\-\\/<>&^%@?:!])",
    "g"
  );
  var DAX_GROUPS = ["tok-com", "tok-str", "tok-fn", "tok-fn", "tok-kw", "tok-num", "tok-pun"];

  function highlight(code, lang) {
    var src = String(code == null ? "" : code);
    var re = lang === "dax" ? DAX_RE : M_RE;
    var groups = lang === "dax" ? DAX_GROUPS : M_GROUPS;
    re.lastIndex = 0;

    var out = "";
    var last = 0;
    var m;
    while ((m = re.exec(src)) !== null) {
      if (m.index > last) out += escapeHtml(src.slice(last, m.index));
      var cls = null;
      for (var g = 1; g < m.length; g++) {
        if (m[g] !== undefined) {
          cls = groups[g - 1];
          break;
        }
      }
      out += '<span class="' + cls + '">' + escapeHtml(m[0]) + "</span>";
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++; // 安全弁(空マッチで無限ループしない)
    }
    if (last < src.length) out += escapeHtml(src.slice(last));
    return out;
  }

  /* ---------------- normalize ----------------
   * 全角英数記号→半角 / 全角スペース→半角 / 各種引用符→半角 /
   * 改行は空白扱い / trim / 連続空白圧縮 /
   * ()[]{}=,*+-/<>&^ の前後空白除去 / 小文字化
   */
  function normalize(code) {
    var s = String(code == null ? "" : code);

    // 全角英数記号(U+FF01-FF5E)→半角、全角スペース→半角
    s = s.replace(/[！-～]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
    });
    s = s.replace(/　/g, " ");

    // 各種引用符→半角
    s = s.replace(/[“”„‟«»「」『』〝〞〟]/g, '"');
    s = s.replace(/[‘’‚‛]/g, "'");

    // 改行・タブ等は空白扱い → 連続空白圧縮 → trim
    s = s.replace(/\s+/g, " ").trim();

    // 記号の前後空白除去
    s = s.replace(/\s*([()\[\]{}=,*+\-\/<>&^])\s*/g, "$1");

    return s.toLowerCase();
  }

  /* ---------------- check ---------------- */
  function levenshtein(a, b) {
    var la = a.length;
    var lb = b.length;
    if (la === 0) return lb;
    if (lb === 0) return la;
    var prev = new Array(lb + 1);
    var cur = new Array(lb + 1);
    var i, j;
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      cur[0] = i;
      var ca = a.charCodeAt(i - 1);
      for (j = 1; j <= lb; j++) {
        var cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        var v = prev[j] + 1;
        if (cur[j - 1] + 1 < v) v = cur[j - 1] + 1;
        if (prev[j - 1] + cost < v) v = prev[j - 1] + cost;
        cur[j] = v;
      }
      var tmp = prev;
      prev = cur;
      cur = tmp;
    }
    return prev[lb];
  }

  function check(user, answer, accept) {
    var u = normalize(user);
    var list = [answer].concat(accept || []);
    var ok = false;
    var best = 0;
    for (var i = 0; i < list.length; i++) {
      var c = normalize(list[i]);
      if (u === c) ok = true;
      var maxLen = Math.max(u.length, c.length);
      var closeness = maxLen === 0 ? 1 : 1 - levenshtein(u, c) / maxLen;
      if (closeness > best) best = closeness;
    }
    if (ok) best = 1;
    return { ok: ok, closeness: best };
  }

  /* ---------------- mount ----------------
   * 透明textareaをハイライトpreに重ねる方式。
   * スクロール同期 / Tab=空白2つ(Escで次のTabを素通し=フォーカストラップ回避) /
   * 自動高さ(最低3行) / 日本語IMEは textarea ネイティブ入力なので崩れない
   * (pre と textarea に同一フォント・同一メトリクスを指定)。
   */
  var MONO_FONT = 'ui-monospace, "SF Mono", Consolas, monospace';

  // iOS Safariは16px未満の入力欄フォーカスでページを自動ズームするため、
  // モバイル幅では16pxを採用する(pre/textarea 両方に同値を適用し重ね合わせを維持)。
  function editorFontPx() {
    try {
      if (
        typeof global.matchMedia === "function" &&
        global.matchMedia("(max-width: 420px)").matches
      ) {
        return 16;
      }
    } catch (e) {
      /* matchMedia非対応環境はデスクトップ既定にフォールバック */
    }
    return 13;
  }

  function applyCommonMetrics(st, fontPx) {
    st.margin = "0";
    st.padding = "10px 12px";
    st.border = "0";
    st.fontFamily = MONO_FONT;
    st.fontSize = fontPx + "px";
    st.lineHeight = "1.6";
    st.whiteSpace = "pre-wrap";
    st.wordBreak = "break-all";
    st.overflowWrap = "break-word";
    st.boxSizing = "border-box";
    st.tabSize = "2";
    st.textAlign = "left";
  }

  function mount(el, opts) {
    opts = opts || {};
    var lang = opts.lang || "m";
    var doc = el.ownerDocument || (typeof document !== "undefined" ? document : null);
    if (!doc) throw new Error("DojoEditor.mount requires a DOM document");

    var wrap = doc.createElement("div");
    wrap.className = "dojo-editor dojo-editor-" + lang;
    wrap.style.position = "relative";

    var pre = doc.createElement("pre");
    pre.className = "dojo-editor-hl";
    pre.setAttribute("aria-hidden", "true");
    var codeEl = doc.createElement("code");
    codeEl.className = "dojo-editor-code";
    pre.appendChild(codeEl);

    var ta = doc.createElement("textarea");
    ta.className = "dojo-editor-input";
    ta.setAttribute("spellcheck", "false");
    ta.setAttribute("autocapitalize", "off");
    ta.setAttribute("autocomplete", "off");
    ta.setAttribute("autocorrect", "off");
    ta.value = opts.value != null ? String(opts.value) : "";

    // 同一メトリクスで重ね合わせ(IME・全角文字でもズレない)
    var fontPx = editorFontPx();
    applyCommonMetrics(pre.style, fontPx);
    applyCommonMetrics(ta.style, fontPx);
    pre.style.position = "absolute";
    pre.style.top = "0";
    pre.style.left = "0";
    pre.style.width = "100%";
    pre.style.height = "100%";
    pre.style.overflow = "hidden";
    pre.style.pointerEvents = "none";

    ta.style.position = "relative";
    ta.style.display = "block";
    ta.style.width = "100%";
    ta.style.background = "transparent";
    ta.style.color = "transparent";
    ta.style.caretColor = "#e8641b"; // アクセント(安全ベスト橙)
    ta.style.resize = "none";
    ta.style.outline = "none";
    ta.style.overflow = "hidden";

    wrap.appendChild(pre);
    wrap.appendChild(ta);
    el.appendChild(wrap);

    var MIN_ROWS = 3;
    var LINE_PX = fontPx * 1.6; // fontSize * lineHeight
    var PAD_PX = 20; // 上下パディング合計

    function render() {
      // 末尾改行分の高さを確保するためゼロ幅の改行を足す
      codeEl.innerHTML = highlight(ta.value, lang) + "\n";
    }

    function resize() {
      var min = Math.ceil(MIN_ROWS * LINE_PX + PAD_PX);
      try {
        ta.style.height = "auto";
        var sh = ta.scrollHeight;
        var h = Math.max(min, sh || 0);
        ta.style.height = h + "px";
        wrap.style.height = h + "px";
      } catch (e) {
        ta.style.height = min + "px";
        wrap.style.height = min + "px";
      }
    }

    function syncScroll() {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    }

    var escapeNextTab = false; // Escで次のTabを素通し(フォーカストラップしない)

    if (ta.addEventListener) {
      ta.addEventListener("input", function () {
        render();
        resize();
        syncScroll();
        if (typeof opts.onInput === "function") opts.onInput(ta.value);
      });
      ta.addEventListener("scroll", syncScroll);
      ta.addEventListener("keydown", function (ev) {
        if (ev.key === "Escape") {
          escapeNextTab = true;
          return;
        }
        if (ev.key === "Tab" && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey) {
          if (escapeNextTab) {
            escapeNextTab = false;
            return; // 素通し=フォーカス移動を許可
          }
          ev.preventDefault();
          var start = ta.selectionStart;
          var end = ta.selectionEnd;
          if (typeof ta.setRangeText === "function") {
            ta.setRangeText("  ", start, end, "end");
          } else {
            ta.value = ta.value.slice(0, start) + "  " + ta.value.slice(end);
            ta.selectionStart = ta.selectionEnd = start + 2;
          }
          render();
          resize();
          if (typeof opts.onInput === "function") opts.onInput(ta.value);
        } else {
          escapeNextTab = false;
        }
      });
    }

    render();
    resize();

    return {
      getValue: function () {
        return ta.value;
      },
      setValue: function (v) {
        ta.value = v != null ? String(v) : "";
        render();
        resize();
        syncScroll();
      },
      focus: function () {
        if (typeof ta.focus === "function") ta.focus();
      },
      el: wrap
    };
  }

  /* ---------------- 公開 ---------------- */
  var API = {
    highlight: highlight,
    normalize: normalize,
    check: check,
    mount: mount,
    escapeHtml: escapeHtml
  };

  global.DojoEditor = API;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = API;
  }
})(typeof window !== "undefined" ? window : globalThis);
