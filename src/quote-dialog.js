// 段落保存对话框

const els = {
  quote: document.getElementById("quote"),
  thoughts: document.getElementById("thoughts"),
  cancel: document.getElementById("cancel"),
  save: document.getElementById("save"),
};

// 从 chrome.storage.session 读取选中的文本
async function init() {
  const data = await chrome.storage.session.get("quote_data");
  if (data.quote_data) {
    els.quote.value = data.quote_data.selectionText || "";
    els.thoughts.focus();
  } else {
    // 如果没有数据，关闭窗口
    window.close();
  }
}

els.cancel.addEventListener("click", () => {
  chrome.storage.session.remove("quote_data");
  window.close();
});

els.save.addEventListener("click", async () => {
  const thoughts = els.thoughts.value.trim();
  const selectionText = els.quote.value;

  if (!selectionText) {
    alert("选中的文本不能为空");
    return;
  }

  try {
    els.save.disabled = true;
    els.save.textContent = "保存中…";

    const data = await chrome.storage.session.get("quote_data");
    if (!data.quote_data) {
      throw new Error("数据已丢失，请重新尝试");
    }

    const response = await chrome.runtime.sendMessage({
      type: "SAVE_QUOTE",
      selectionText,
      thoughts,
      url: data.quote_data.url,
      title: data.quote_data.title,
    });

    if (!response || !response.ok) {
      throw new Error(response ? response.error : "无响应");
    }

    chrome.storage.session.remove("quote_data");
    window.close();
  } catch (e) {
    alert("保存失败：" + e.message);
    els.save.disabled = false;
    els.save.textContent = "保存";
  }
});

init();
