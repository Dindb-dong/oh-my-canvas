(() => {
  globalThis.omcCaptureCancel?.()
  const nonce = crypto.getRandomValues(new Uint32Array(4)).join('-')
  const controller = new AbortController()
  const options = { capture: true, signal: controller.signal }
  const outline = document.createElement('div')
  outline.setAttribute('aria-hidden', 'true')
  Object.assign(outline.style, {
    position: 'fixed', inset: '0 auto auto 0', pointerEvents: 'none',
    outline: '2px solid #3866ff', zIndex: '2147483647',
  })
  document.documentElement.append(outline)

  let selected
  let retry
  let deadline
  const send = (type, args = {}) => chrome.runtime.sendMessage({ type, nonce, ...args }).catch(() => ({ stop: true }))
  const stop = () => {
    controller.abort()
    outline.remove()
    clearTimeout(retry)
    clearTimeout(deadline)
    if (globalThis.omcCaptureCancel === cancel) delete globalThis.omcCaptureCancel
  }
  const cancel = () => {
    stop()
    void send('cancel')
  }
  globalThis.omcCaptureCancel = cancel
  addEventListener('pagehide', stop, options)
  addEventListener('keydown', event => {
    if (event.key === 'Escape') cancel()
  }, options)
  addEventListener('pointermove', event => {
    if (selected || !(event.target instanceof Element)) return
    const target = event.target
    const root = target instanceof SVGElement && !(target instanceof SVGSVGElement)
      ? target.ownerSVGElement ?? target
      : target
    const { x, y, width, height } = root.getBoundingClientRect()
    Object.assign(outline.style, { left: x + 'px', top: y + 'px', width: width + 'px', height: height + 'px' })
  }, options)

  async function poll() {
    const response = await send('claim')
    if (controller.signal.aborted || response?.stop) return stop()
    if (!response?.id) {
      retry = setTimeout(poll, 350)
      return
    }
    let bundle = null
    try {
      const { default: capture } = await import(chrome.runtime.getURL('capture-web.mjs'))
      if (controller.signal.aborted) return
      bundle = capture(selected)
    } catch {
      // A removed or restricted selection is reported without page error text.
    }
    await send('result', { id: response.id, bundle })
    stop()
  }

  addEventListener('click', async event => {
    if (selected || !event.isTrusted || !(event.target instanceof Element)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    selected = event.target
    outline.remove()
    const reply = await send('selected')
    if (reply?.armed && !controller.signal.aborted) {
      deadline = setTimeout(cancel, 120_000)
      await poll()
    } else {
      stop()
    }
  }, options)
})()
