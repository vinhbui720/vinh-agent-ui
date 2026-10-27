// Pushes every tab to the native host on change; the host serves it to Coucou. Commands: {select: tabId}.
let port;
const send = async () => {
  if (!port) return;
  const tabs = await chrome.tabs.query({});
  port.postMessage({ tabs: tabs.map((t) => ({ tab_id: String(t.id), title: t.title || "", url: t.url || "", active: t.active && t.highlighted })) });
};
function connect() {
  port = chrome.runtime.connectNative("coucou_tabs");
  port.onMessage.addListener(async (m) => {
    if (m.select == null) return;
    const t = await chrome.tabs.get(Number(m.select));
    await chrome.tabs.update(t.id, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
  });
  port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 5000); });
  void send();
}
for (const e of ["onCreated", "onRemoved", "onUpdated", "onActivated", "onMoved", "onAttached", "onDetached"]) chrome.tabs[e].addListener(send);
chrome.windows.onFocusChanged.addListener(send);
connect();
