/* ===== おションション — Notionみたいなイケてるメモアプリ ===== */
(() => {
  "use strict";

  const STORE_KEY = "oshonshon.v1";
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // ---- State ----
  /** @type {{pages: Array, currentId: string|null, theme: string, collapsed: boolean}} */
  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.warn("読み込みに失敗:", e);
    }
    return { pages: [], currentId: null, theme: "light", collapsed: false };
  }

  let saveTimer = null;
  function persistNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      toast("保存に失敗しました 😢");
      console.error(e);
    }
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistNow, 250);
  }
  // Flush any pending debounced save before the tab is hidden/closed so
  // quick edits are never lost.
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && saveTimer) persistNow();
  });
  window.addEventListener("pagehide", () => { if (saveTimer) persistNow(); });
  window.addEventListener("beforeunload", () => { if (saveTimer) persistNow(); });

  const newBlock = (type = "text", text = "") => ({ id: uid(), type, text, checked: false });

  function createPage() {
    const page = {
      id: uid(),
      emoji: "📄",
      title: "",
      cover: false,
      blocks: [newBlock()],
      updated: Date.now(),
    };
    state.pages.unshift(page);
    state.currentId = page.id;
    save();
    renderSidebar();
    renderEditor();
    focusTitle();
  }

  function currentPage() {
    return state.pages.find((p) => p.id === state.currentId) || null;
  }

  function deletePage(id) {
    const page = state.pages.find((p) => p.id === id);
    const label = page && (page.title || "無題");
    if (!confirm(`「${label}」を削除しますか？`)) return;
    state.pages = state.pages.filter((p) => p.id !== id);
    if (state.currentId === id) {
      state.currentId = state.pages[0] ? state.pages[0].id : null;
    }
    save();
    renderSidebar();
    renderEditor();
    toast("削除しました 🗑️");
  }

  function touch() {
    const p = currentPage();
    if (p) p.updated = Date.now();
  }

  // ---- DOM refs ----
  const $ = (id) => document.getElementById(id);
  const app = $("app");
  const sidebar = $("sidebar");
  const pageList = $("pageList");
  const editor = $("editor");
  const emptyState = $("emptyState");
  const blocksEl = $("blocks");
  const titleInput = $("titleInput");
  const emojiBtn = $("emojiBtn");
  const coverEl = $("cover");
  const slashMenu = $("slashMenu");
  const emojiPicker = $("emojiPicker");
  const searchInput = $("searchInput");

  // ---- Sidebar render ----
  function renderSidebar(filter = "") {
    const f = filter.trim().toLowerCase();
    pageList.innerHTML = "";
    const pages = f
      ? state.pages.filter((p) =>
          ((p.title || "無題") + " " + p.blocks.map((b) => b.text).join(" "))
            .toLowerCase()
            .includes(f)
        )
      : state.pages;

    if (!pages.length) {
      const empty = document.createElement("div");
      empty.className = "page-list__empty";
      empty.textContent = f ? "見つかりませんでした" : "まだページがありません";
      pageList.appendChild(empty);
      return;
    }

    for (const p of pages) {
      const item = document.createElement("div");
      item.className = "page-item" + (p.id === state.currentId ? " active" : "");
      item.dataset.id = p.id;
      item.innerHTML = `
        <span class="page-item__emoji">${p.emoji || "📄"}</span>
        <span class="page-item__title">${escapeHtml(p.title) || "無題"}</span>
        <button class="page-item__del" title="削除">✕</button>`;
      item.addEventListener("click", (e) => {
        if (e.target.classList.contains("page-item__del")) return;
        state.currentId = p.id;
        save();
        renderSidebar(searchInput.value);
        renderEditor();
      });
      item.querySelector(".page-item__del").addEventListener("click", (e) => {
        e.stopPropagation();
        deletePage(p.id);
      });
      pageList.appendChild(item);
    }
  }

  // ---- Editor render ----
  function renderEditor() {
    const p = currentPage();
    if (!p) {
      editor.hidden = true;
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;
    editor.hidden = false;
    editor.classList.toggle("has-cover", !!p.cover);
    emojiBtn.textContent = p.emoji || "📄";
    titleInput.textContent = p.title || "";
    renderBlocks();
  }

  function renderBlocks() {
    const p = currentPage();
    if (!p) return;
    blocksEl.innerHTML = "";
    let n = 0;
    for (const b of p.blocks) {
      if (b.type === "numbered") n++;
      else n = 0;
      blocksEl.appendChild(renderBlock(b, n));
    }
  }

  function renderBlock(b, number) {
    const el = document.createElement("div");
    el.className = "block" + (b.checked ? " checked" : "");
    el.dataset.id = b.id;
    el.dataset.type = b.type;
    if (b.type === "numbered") el.dataset.number = number;
    el.draggable = false;

    // drag handle
    const handle = document.createElement("div");
    handle.className = "block__handle";
    handle.textContent = "⠿";
    handle.title = "ドラッグで移動 / クリックでメニュー";
    handle.addEventListener("mousedown", () => (el.draggable = true));
    handle.addEventListener("mouseup", () => (el.draggable = false));
    handle.addEventListener("click", (e) => {
      e.stopPropagation();
      openBlockTypeMenu(b, el);
    });
    el.appendChild(handle);

    // todo checkbox
    if (b.type === "todo") {
      const check = document.createElement("div");
      check.className = "block__check";
      check.textContent = b.checked ? "✓" : "";
      check.addEventListener("click", () => {
        b.checked = !b.checked;
        el.classList.toggle("checked", b.checked);
        check.textContent = b.checked ? "✓" : "";
        touch();
        save();
      });
      el.appendChild(check);
    }

    // content
    const content = document.createElement("div");
    content.className = "block__content";
    if (b.type !== "divider") {
      content.contentEditable = "true";
      content.spellcheck = false;
      content.textContent = b.text;
      content.dataset.placeholder = placeholderFor(b.type);
      wireBlockEvents(content, b, el);
    }
    el.appendChild(content);

    wireDragEvents(el, b);
    return el;
  }

  function placeholderFor(type) {
    switch (type) {
      case "h1": return "見出し 1";
      case "h2": return "見出し 2";
      case "h3": return "見出し 3";
      case "todo": return "ToDo";
      case "quote": return "引用";
      case "callout": return "コールアウト";
      case "code": return "コード";
      case "bullet": return "リスト項目";
      case "numbered": return "番号付き項目";
      default: return "本文を入力、または「/」でコマンド";
    }
  }

  // ---- Block editing ----
  function wireBlockEvents(content, b, el) {
    content.addEventListener("input", () => {
      b.text = content.textContent;
      touch();
      maybeMarkdownShortcut(content, b, el);
      save();
    });

    content.addEventListener("keydown", (e) => {
      // Slash menu navigation handled separately when open
      if (!slashMenu.hidden) {
        if (handleSlashKeys(e, content, b, el)) return;
      }

      if (e.key === "Enter" && !e.shiftKey && b.type !== "code") {
        e.preventDefault();
        if (!slashMenu.hidden) return;
        // empty list item -> convert to text
        if (
          ["bullet", "numbered", "todo"].includes(b.type) &&
          content.textContent.trim() === ""
        ) {
          b.type = "text";
          el.replaceWith(renderBlock(b, 0));
          focusBlock(b.id);
          renderBlocks();
          focusBlock(b.id);
          save();
          return;
        }
        splitBlock(content, b);
      } else if (e.key === "Backspace" && getCaret(content) === 0) {
        const p = currentPage();
        const idx = p.blocks.findIndex((x) => x.id === b.id);
        if (b.type !== "text" && b.type !== "divider") {
          // first convert styled block to text
          e.preventDefault();
          b.type = "text";
          renderBlocks();
          focusBlock(b.id);
          save();
        } else if (idx > 0) {
          e.preventDefault();
          mergeWithPrevious(b, idx);
        }
      } else if (e.key === "ArrowUp") {
        moveCaretVertical(b, -1, e);
      } else if (e.key === "ArrowDown") {
        moveCaretVertical(b, 1, e);
      } else if (e.key === "/" && content.textContent === "") {
        // open slash menu next tick (after char inserted)
        setTimeout(() => openSlashMenu(content, b, el), 0);
      } else if (e.key === "Tab") {
        e.preventDefault();
        document.execCommand("insertText", false, "  ");
      }
    });

    content.addEventListener("focus", () => hideEmojiPicker());
  }

  function maybeMarkdownShortcut(content, b, el) {
    // contenteditable turns a trailing space into a non-breaking space; normalize it
    const text = content.textContent.replace(/ /g, " ");
    const map = {
      "# ": "h1", "## ": "h2", "### ": "h3",
      "- ": "bullet", "* ": "bullet",
      "1. ": "numbered",
      "[] ": "todo", "[ ] ": "todo",
      "> ": "quote",
      "``` ": "code",
    };
    for (const prefix in map) {
      if (text === prefix) {
        b.type = map[prefix];
        b.text = "";
        el.replaceWith(renderBlock(b, 0));
        renderBlocks();
        focusBlock(b.id);
        save();
        return;
      }
    }
    if (text === "--- " || text === "___ ") {
      b.type = "divider";
      b.text = "";
      const blk = renderBlock(b, 0);
      el.replaceWith(blk);
      // add a fresh text block after for continued typing
      splitBlock(null, b);
      save();
    }
  }

  function splitBlock(content, b) {
    const p = currentPage();
    const idx = p.blocks.findIndex((x) => x.id === b.id);
    let after = "";
    if (content) {
      const caret = getCaret(content);
      after = content.textContent.slice(caret);
      b.text = content.textContent.slice(0, caret);
      content.textContent = b.text;
    }
    // continue list types, else plain text
    const continueType = ["bullet", "numbered", "todo"].includes(b.type) ? b.type : "text";
    const nb = newBlock(continueType, after);
    p.blocks.splice(idx + 1, 0, nb);
    touch();
    renderBlocks();
    focusBlock(nb.id, 0);
    save();
  }

  function mergeWithPrevious(b, idx) {
    const p = currentPage();
    const prev = p.blocks[idx - 1];
    if (prev.type === "divider") {
      p.blocks.splice(idx - 1, 1);
      renderBlocks();
      focusBlock(b.id, 0);
      save();
      return;
    }
    const caretPos = prev.text.length;
    prev.text += b.text;
    p.blocks.splice(idx, 1);
    touch();
    renderBlocks();
    focusBlock(prev.id, caretPos);
    save();
  }

  function moveCaretVertical(b, dir, e) {
    // move between blocks at edges
    const p = currentPage();
    const idx = p.blocks.findIndex((x) => x.id === b.id);
    const target = p.blocks[idx + dir];
    if (!target) return;
    const content = e.target;
    const atEdge =
      dir < 0 ? isCaretOnFirstLine(content) : isCaretOnLastLine(content);
    if (atEdge) {
      e.preventDefault();
      focusBlock(target.id);
    }
  }

  // ---- Slash menu ----
  const SLASH_ITEMS = [
    { type: "text", icon: "📝", title: "テキスト", desc: "普通の本文", kw: "text honbun テキスト" },
    { type: "h1", icon: "🅷", title: "見出し1", desc: "大きな見出し", kw: "h1 heading 見出し" },
    { type: "h2", icon: "🇭", title: "見出し2", desc: "中くらいの見出し", kw: "h2 heading 見出し" },
    { type: "h3", icon: "ʜ", title: "見出し3", desc: "小さな見出し", kw: "h3 heading 見出し" },
    { type: "todo", icon: "☑️", title: "ToDoリスト", desc: "チェックボックス", kw: "todo task チェック" },
    { type: "bullet", icon: "•", title: "箇条書きリスト", desc: "・付きリスト", kw: "bullet list 箇条書き" },
    { type: "numbered", icon: "1.", title: "番号付きリスト", desc: "順序付きリスト", kw: "number list 番号" },
    { type: "quote", icon: "❝", title: "引用", desc: "引用ブロック", kw: "quote 引用" },
    { type: "callout", icon: "💡", title: "コールアウト", desc: "目立つメモ", kw: "callout note メモ" },
    { type: "code", icon: "</>", title: "コード", desc: "コードブロック", kw: "code コード" },
    { type: "divider", icon: "—", title: "区切り線", desc: "水平線", kw: "divider line 区切り" },
  ];

  let slashCtx = null; // { content, block, el, query, index }

  function openSlashMenu(content, b, el) {
    slashCtx = { content, block: b, el, query: "", index: 0 };
    positionMenu(slashMenu, content);
    renderSlashMenu();
    slashMenu.hidden = false;
  }

  function renderSlashMenu() {
    const q = slashCtx.query.toLowerCase();
    const items = SLASH_ITEMS.filter(
      (it) => !q || it.title.toLowerCase().includes(q) || it.kw.includes(q)
    );
    slashCtx.filtered = items;
    if (slashCtx.index >= items.length) slashCtx.index = 0;
    if (!items.length) {
      slashMenu.innerHTML = `<div class="slash-menu__empty">該当なし</div>`;
      return;
    }
    slashMenu.innerHTML = items
      .map(
        (it, i) => `
      <div class="slash-item ${i === slashCtx.index ? "active" : ""}" data-type="${it.type}">
        <div class="slash-item__icon">${it.icon}</div>
        <div class="slash-item__text">
          <span class="slash-item__title">${it.title}</span>
          <span class="slash-item__desc">${it.desc}</span>
        </div>
      </div>`
      )
      .join("");
    [...slashMenu.children].forEach((node, i) => {
      node.addEventListener("mousedown", (e) => {
        e.preventDefault();
        applySlash(items[i].type);
      });
    });
  }

  function handleSlashKeys(e, content, b, el) {
    const items = slashCtx.filtered || [];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      slashCtx.index = (slashCtx.index + 1) % items.length;
      renderSlashMenu();
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      slashCtx.index = (slashCtx.index - 1 + items.length) % items.length;
      renderSlashMenu();
      return true;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (items[slashCtx.index]) applySlash(items[slashCtx.index].type);
      return true;
    }
    if (e.key === "Escape") {
      hideSlashMenu();
      return true;
    }
    // update query from text after "/"
    setTimeout(() => {
      if (slashMenu.hidden || !slashCtx) return;
      const txt = content.textContent;
      const slashPos = txt.lastIndexOf("/");
      if (slashPos === -1) { hideSlashMenu(); return; }
      slashCtx.query = txt.slice(slashPos + 1);
      renderSlashMenu();
    }, 0);
    return false;
  }

  function applySlash(type) {
    const { block: b, content } = slashCtx;
    // strip the slash query from text
    const txt = content.textContent;
    const slashPos = txt.lastIndexOf("/");
    b.text = slashPos >= 0 ? txt.slice(0, slashPos) : txt;
    b.type = type;
    hideSlashMenu();
    if (type === "divider") {
      b.text = "";
      renderBlocks();
      // ensure a trailing text block to keep typing
      const p = currentPage();
      const idx = p.blocks.findIndex((x) => x.id === b.id);
      if (!p.blocks[idx + 1]) {
        const nb = newBlock();
        p.blocks.push(nb);
        renderBlocks();
        focusBlock(nb.id);
      } else {
        focusBlock(p.blocks[idx + 1].id);
      }
    } else {
      renderBlocks();
      focusBlock(b.id, b.text.length);
    }
    touch();
    save();
  }

  function hideSlashMenu() {
    slashMenu.hidden = true;
    slashCtx = null;
  }

  // change type via handle click
  function openBlockTypeMenu(b, el) {
    const content = el.querySelector(".block__content");
    if (content) {
      content.focus();
      openSlashMenu(content, b, el);
    }
  }

  // ---- Drag & drop reorder ----
  let dragId = null;
  function wireDragEvents(el, b) {
    el.addEventListener("dragstart", (e) => {
      dragId = b.id;
      el.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    el.addEventListener("dragend", () => {
      el.classList.remove("dragging");
      el.draggable = false;
      [...blocksEl.children].forEach((c) => c.classList.remove("drop-target"));
      dragId = null;
    });
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      [...blocksEl.children].forEach((c) => c.classList.remove("drop-target"));
      el.classList.add("drop-target");
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      el.classList.remove("drop-target");
      if (!dragId || dragId === b.id) return;
      const p = currentPage();
      const from = p.blocks.findIndex((x) => x.id === dragId);
      let to = p.blocks.findIndex((x) => x.id === b.id);
      const [moved] = p.blocks.splice(from, 1);
      to = p.blocks.findIndex((x) => x.id === b.id);
      p.blocks.splice(to, 0, moved);
      touch();
      renderBlocks();
      save();
    });
  }

  // ---- Caret helpers ----
  function focusBlock(id, pos) {
    requestAnimationFrame(() => {
      const node = blocksEl.querySelector(`.block[data-id="${id}"] .block__content`);
      if (!node) return;
      node.focus();
      setCaret(node, pos == null ? (node.textContent.length) : pos);
    });
  }

  function focusTitle() {
    requestAnimationFrame(() => titleInput.focus());
  }

  function getCaret(node) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return 0;
    const range = sel.getRangeAt(0).cloneRange();
    range.selectNodeContents(node);
    range.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
    return range.toString().length;
  }

  function setCaret(node, pos) {
    const range = document.createRange();
    const sel = window.getSelection();
    let remaining = pos;
    let target = node.firstChild;
    if (!target) {
      range.setStart(node, 0);
    } else {
      const len = target.textContent.length;
      range.setStart(target, Math.min(remaining, len));
    }
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function isCaretOnFirstLine(node) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return true;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const top = node.getBoundingClientRect().top;
    return rect.top - top < 12 || getCaret(node) === 0;
  }
  function isCaretOnLastLine(node) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return true;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const bottom = node.getBoundingClientRect().bottom;
    return bottom - rect.bottom < 12 || getCaret(node) === node.textContent.length;
  }

  // ---- Title ----
  titleInput.addEventListener("input", () => {
    const p = currentPage();
    if (!p) return;
    p.title = titleInput.textContent;
    touch();
    renderSidebarTitleOnly();
    save();
  });
  titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const p = currentPage();
      if (p && p.blocks[0]) focusBlock(p.blocks[0].id, 0);
    }
    if (e.key === "ArrowDown") {
      const p = currentPage();
      if (p && p.blocks[0]) { e.preventDefault(); focusBlock(p.blocks[0].id, 0); }
    }
  });

  function renderSidebarTitleOnly() {
    const item = pageList.querySelector(`.page-item[data-id="${state.currentId}"] .page-item__title`);
    const p = currentPage();
    if (item && p) item.textContent = p.title || "無題";
  }

  // ---- Emoji picker ----
  const EMOJIS = "📄📝📌📒📓📔📕📗📘📙📚🗒️✅⭐🔥💡🎯🚀✨🎨🎵🍀🌸🐱🐶🦊🐼🍎🍕☕🌙🌈💎🔑🎁❤️🎉".split("");
  emojiBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const p = currentPage();
    if (!p) return;
    emojiPicker.innerHTML = EMOJIS.map((em) => `<button>${em}</button>`).join("");
    [...emojiPicker.children].forEach((btn, i) => {
      btn.addEventListener("click", () => {
        p.emoji = EMOJIS[i];
        emojiBtn.textContent = p.emoji;
        renderSidebar(searchInput.value);
        hideEmojiPicker();
        touch();
        save();
      });
    });
    positionMenu(emojiPicker, emojiBtn);
    emojiPicker.hidden = false;
  });
  function hideEmojiPicker() { emojiPicker.hidden = true; }

  // ---- Menu positioning ----
  function positionMenu(menu, anchor) {
    const r = anchor.getBoundingClientRect();
    menu.style.visibility = "hidden";
    menu.hidden = false;
    const mh = menu.offsetHeight;
    const mw = menu.offsetWidth;
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight) top = Math.max(8, r.top - mh - 6);
    let left = r.left;
    if (left + mw > window.innerWidth) left = window.innerWidth - mw - 8;
    menu.style.top = top + "px";
    menu.style.left = left + "px";
    menu.style.visibility = "visible";
  }

  // global click to close menus
  document.addEventListener("click", (e) => {
    if (!slashMenu.hidden && !slashMenu.contains(e.target)) hideSlashMenu();
    if (!emojiPicker.hidden && !emojiPicker.contains(e.target) && e.target !== emojiBtn)
      hideEmojiPicker();
  });

  // click on empty editor area -> focus last block / create one
  blocksEl.addEventListener("click", (e) => {
    if (e.target === blocksEl) {
      const p = currentPage();
      if (!p) return;
      let last = p.blocks[p.blocks.length - 1];
      if (!last || last.type === "divider") {
        last = newBlock();
        p.blocks.push(last);
        renderBlocks();
      }
      focusBlock(last.id);
    }
  });

  // ---- Toolbar buttons ----
  $("newPageBtn").addEventListener("click", createPage);
  $("emptyNewBtn").addEventListener("click", createPage);
  $("collapseBtn").addEventListener("click", () => toggleSidebar(true));
  $("expandBtn").addEventListener("click", () => toggleSidebar(false));

  function toggleSidebar(collapsed) {
    state.collapsed = collapsed;
    app.classList.toggle("collapsed", collapsed);
    save();
  }

  $("themeBtn").addEventListener("click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    applyTheme();
    save();
  });
  function applyTheme() {
    document.documentElement.setAttribute("data-theme", state.theme);
    $("themeBtn").textContent = state.theme === "dark" ? "☀️ テーマ" : "🌙 テーマ";
  }

  $("exportBtn").addEventListener("click", exportMarkdown);
  function exportMarkdown() {
    const p = currentPage();
    if (!p) { toast("書き出すページがありません"); return; }
    let md = `# ${p.emoji} ${p.title || "無題"}\n\n`;
    let n = 0;
    for (const b of p.blocks) {
      if (b.type === "numbered") n++; else n = 0;
      md += blockToMd(b, n) + "\n";
    }
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(p.title || "無題").replace(/[\\/:*?"<>|]/g, "_")}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Markdownで書き出しました ⬇️");
  }
  function blockToMd(b, n) {
    switch (b.type) {
      case "h1": return `# ${b.text}`;
      case "h2": return `## ${b.text}`;
      case "h3": return `### ${b.text}`;
      case "bullet": return `- ${b.text}`;
      case "numbered": return `${n}. ${b.text}`;
      case "todo": return `- [${b.checked ? "x" : " "}] ${b.text}`;
      case "quote": return `> ${b.text}`;
      case "callout": return `> 💡 ${b.text}`;
      case "code": return "```\n" + b.text + "\n```";
      case "divider": return `---`;
      default: return b.text;
    }
  }

  // ---- Search ----
  searchInput.addEventListener("input", () => renderSidebar(searchInput.value));

  // ---- Keyboard shortcuts ----
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "n" && !e.shiftKey) { e.preventDefault(); createPage(); }
    if (mod && e.key === "b") { e.preventDefault(); toggleSidebar(!state.collapsed); }
    if (mod && e.key === "f") { e.preventDefault(); searchInput.focus(); }
  });

  // ---- Toast ----
  let toastTimer = null;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    requestAnimationFrame(() => t.classList.add("show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => (t.hidden = true), 220);
    }, 1800);
  }

  // ---- utils ----
  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  // ---- Boot ----
  function boot() {
    applyTheme();
    app.classList.toggle("collapsed", !!state.collapsed);
    if (!state.pages.length) {
      // seed a friendly welcome page
      seedWelcome();
    }
    if (!state.currentId && state.pages[0]) state.currentId = state.pages[0].id;
    renderSidebar();
    renderEditor();
  }

  function seedWelcome() {
    const page = {
      id: uid(),
      emoji: "👋",
      title: "おションションへようこそ",
      cover: true,
      updated: Date.now(),
      blocks: [
        newBlock("callout", "これはNotionみたいに使えるメモアプリ「おションション」です。すべて自動でブラウザに保存されます。"),
        newBlock("h2", "🚀 はじめかた"),
        newBlock("text", "本文の行で「/」を入力するとブロックメニューが開きます。"),
        newBlock("todo", "見出し・リスト・ToDoを試してみる"),
        newBlock("todo", "左上の「＋ 新しいページ」でページを増やす"),
        newBlock("h2", "⌨️ ショートカット"),
        newBlock("bullet", "Ctrl/Cmd + N：新規ページ"),
        newBlock("bullet", "Ctrl/Cmd + B：サイドバー開閉"),
        newBlock("bullet", "Ctrl/Cmd + F：検索"),
        newBlock("h2", "✍️ Markdown記法"),
        newBlock("text", "「# 」「- 」「[] 」「> 」「--- 」などを行頭で打つと自動変換されます。"),
        newBlock("quote", "アイデアは、書きとめた瞬間から価値になる。"),
        newBlock("text", ""),
      ],
    };
    state.pages.push(page);
    state.currentId = page.id;
    save();
  }

  boot();
})();
