const input = document.querySelector('#pairing')
const status = document.querySelector('#status')

document.querySelector('form').addEventListener('submit', async event => {
  event.preventDefault()
  try {
    const { endpoint, key } = JSON.parse(input.value)
    const url = new URL(endpoint)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
        || endpoint !== url.origin || typeof key !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/u.test(key)) {
      throw new Error('The pairing data must name a local OMC service')
    }
    await chrome.storage.session.set({ connection: { endpoint, key }, selected: null })
    input.value = ''
    status.textContent = 'Connection saved. Use the OMC toolbar button on the page you want to capture.'
  } catch {
    status.textContent = 'Paste the complete pairing data from the current OMC service.'
  }
})
