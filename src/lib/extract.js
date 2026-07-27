// 页面正文提取并转换为 markdown（轻量自有实现，零依赖）
//
// 通过 chrome.scripting.executeScript({ func: extractPageContent }) 注入到页面执行。
// 因此本函数必须自包含：不能引用外部作用域的变量。
// 返回 { url, title, content }，content 为 markdown 格式，已去噪并截断到 MAX_CHARS。
globalThis.extractPageContent = function extractPageContent() {
  const MAX_CHARS = 4000;
  const REMOVE_SELECTOR = [
    "script", "style", "noscript", "template",
    "nav", "footer", "header", "aside",
    "iframe", "form", "svg", "canvas",
    "button", "link", "meta"
  ].join(",");

  // clone 整个 document，避免移除节点影响原页面
  const clone = document.cloneNode(true);
  clone.querySelectorAll(REMOVE_SELECTOR).forEach((el) => el.remove());

  // 优先取正文容器，兜底 body
  const main =
    clone.querySelector("article, main, [role='main'], .content, .post, #content, .article") ||
    clone.body;

  // 转换 DOM 为 markdown
  function nodeToMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent.replace(/[ \t\f\v ]+/g, " ");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    const tag = node.tagName.toLowerCase();
    let result = "";

    // 处理标题
    if (tag.match(/^h[1-6]$/)) {
      const level = parseInt(tag[1]);
      const text = node.textContent.trim();
      return "#".repeat(level) + " " + text + "\n\n";
    }

    // 处理列表项
    if (tag === "li") {
      const text = node.textContent.trim();
      return "- " + text + "\n";
    }

    // 处理段落、div 等块级元素
    if (["p", "div", "section", "article"].includes(tag)) {
      let text = "";
      for (const child of node.childNodes) {
        text += nodeToMarkdown(child);
      }
      if (text.trim()) {
        return text.trim() + "\n\n";
      }
      return text;
    }

    // 处理列表
    if (["ul", "ol"].includes(tag)) {
      let text = "";
      for (const child of node.childNodes) {
        text += nodeToMarkdown(child);
      }
      return text + "\n";
    }

    // 处理加粗、斜体
    if (tag === "strong" || tag === "b") {
      const text = node.textContent.trim();
      return text ? "**" + text + "**" : "";
    }

    if (tag === "em" || tag === "i") {
      const text = node.textContent.trim();
      return text ? "*" + text + "*" : "";
    }

    // 处理链接
    if (tag === "a") {
      const text = node.textContent.trim();
      const href = node.getAttribute("href");
      return text ? "[" + text + "](" + href + ")" : "";
    }

    // 处理代码块
    if (tag === "code") {
      const text = node.textContent.trim();
      return text ? "`" + text + "`" : "";
    }

    if (tag === "pre") {
      const text = node.textContent.trim();
      return "```\n" + text + "\n```\n\n";
    }

    // 默认情况，继续处理子节点
    let text = "";
    for (const child of node.childNodes) {
      text += nodeToMarkdown(child);
    }
    return text;
  }

  let markdown = nodeToMarkdown(main).trim();
  // 规整多余空行
  markdown = markdown
    .replace(/\n{4,}/g, "\n\n")
    .trim();

  if (markdown.length > MAX_CHARS) {
    markdown = markdown.slice(0, MAX_CHARS);
  }

  return {
    url: location.href,
    title: (document.title || "").trim() || location.href,
    content: markdown,
  };
};
