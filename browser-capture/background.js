async function startPicker(tabId) {
  const { connection } = await chrome.storage.session.get('connection')
  if (!connection) {
    await chrome.runtime.openOptionsPage()
    return
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['pick.js'] })
    await chrome.action.setBadgeText({ tabId, text: '…' })
  } catch {
    await chrome.action.setBadgeText({ tabId, text: '!' })
    await chrome.action.setTitle({ tabId, title: 'Choose a regular webpage to capture' })
  }
}

chrome.action.onClicked.addListener(tab => { if (tab.id != null) void startPicker(tab.id) })

async function handle(message, sender) {
  const tabId = sender.tab?.id
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || tabId == null || !sender.documentId) return
  const { connection, selected } = await chrome.storage.session.get(['connection', 'selected'])
  if (!connection) return { stop: true }
  const identity = { tabId, documentId: sender.documentId, nonce: message.nonce }
  if (message.type === 'selected') {
    await chrome.storage.session.set({ selected: identity })
    await chrome.action.setBadgeText({ tabId, text: '1' })
    return { armed: true }
  }
  const active = selected?.documentId === identity.documentId && selected.tabId === tabId && selected.nonce === message.nonce
  if (!active) {
    if (message.type === 'cancel') await chrome.action.setBadgeText({ tabId, text: '' })
    return { stop: true }
  }
  if (message.type === 'cancel') {
    await chrome.storage.session.set({ selected: null })
    await chrome.action.setBadgeText({ tabId, text: '' })
    return { stop: true }
  }

  const claiming = message.type === 'claim'
  if (!claiming && (message.type !== 'result' || !/^[0-9a-f-]{36}$/u.test(message.id))) return
  const path = claiming ? 'claim' : 'result/' + message.id
  try {
    let body
    if (!claiming) {
      body = JSON.stringify(message.bundle)
      if (!body || new TextEncoder().encode(body).byteLength > 12 * 1024 * 1024) body = 'null'
    }
    const response = await fetch(connection.endpoint + '/browser-capture/' + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + connection.key, 'Content-Type': 'application/json' },
      body,
      credentials: 'omit',
      redirect: 'error',
      targetAddressSpace: 'loopback',
      signal: AbortSignal.timeout(3000),
    })
    if (claiming && response.status === 204) return {}
    if (!response.ok) throw new Error('Browser capture connection failed')
    if (claiming) return await response.json()
    const latest = (await chrome.storage.session.get('selected')).selected
    if (latest?.nonce === identity.nonce) {
      await chrome.storage.session.set({ selected: null })
      await chrome.action.setBadgeText({ tabId, text: '' })
    }
    return { stop: true }
  } catch {
    await chrome.action.setBadgeText({ tabId, text: '!' })
    await chrome.action.setTitle({ tabId, title: 'Reconnect to the current OMC service or select again' })
    return { stop: true }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender).then(sendResponse, () => sendResponse({ stop: true }))
  return true
})
