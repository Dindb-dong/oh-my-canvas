// Collect an inert, editable snapshot of one explicitly selected live DOM subtree.
export default function captureWebSelection(root) {
  if (!(root instanceof Element) || !root.isConnected || root.ownerDocument !== document) {
    throw new TypeError('Select a connected element in the current page')
  }
  if (root.closest('[data-omc-private], [contenteditable]:not([contenteditable="false"])')) {
    throw new Error('The selected element is marked private or editable')
  }
  if (root instanceof SVGElement && !(root instanceof SVGSVGElement)) {
    root = root.ownerSVGElement ?? root
  }

  const layers = []
  const warnings = new Set()
  const clipsOverflow = value => ['hidden', 'clip', 'auto', 'scroll'].includes(value)
  const intersect = (rect, clip) => ({
    left: Math.max(rect.left, clip.left), right: Math.min(rect.right, clip.right),
    top: Math.max(rect.top, clip.top), bottom: Math.min(rect.bottom, clip.bottom),
  })
  function scrollport(element, rect, clip, [x, y]) {
    return intersect(clip, {
      left: x ? rect.left + element.clientLeft : clip.left,
      right: x ? rect.left + element.clientLeft + element.clientWidth : clip.right,
      top: y ? rect.top + element.clientTop : clip.top,
      bottom: y ? rect.top + element.clientTop + element.clientHeight : clip.bottom,
    })
  }

  let browserClip = {
    left: 0, right: document.documentElement.clientWidth,
    top: 0, bottom: document.documentElement.clientHeight,
  }
  for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor)
    const axes = [style.overflowX, style.overflowY].map(clipsOverflow)
    if (style.opacity === '0') throw new Error('The selection is visually hidden')
    if (axes.some(Boolean) && ancestor !== document.scrollingElement) {
      browserClip = scrollport(ancestor, ancestor.getBoundingClientRect(), browserClip, axes)
    }
  }
  const selection = root.getBoundingClientRect()
  const viewport = intersect(selection, browserClip)
  const origin = { x: viewport.left, y: viewport.top }
  const width = viewport.right - viewport.left
  const height = viewport.bottom - viewport.top
  if (!(width > 0 && height > 0 && width <= 16384 && height <= 16384)) {
    throw new RangeError('Selection must fit a visible capture viewport')
  }
  let assetCharacters = 0
  const range = document.createRange()
  const controls = new Set(['input', 'textarea', 'select', 'option'])
  const blocked = new Set(['script', 'style', 'template', 'iframe', 'object', 'embed', 'canvas', 'video', 'audio'])
  const vectorTags = new Set(['g', 'rect', 'circle', 'ellipse', 'line', 'path', 'polygon', 'polyline'])
  const pixels = value => Number.parseFloat(value) || 0
  const visible = (rect, clip) => rect.right > clip.left && rect.left < clip.right
    && rect.bottom > clip.top && rect.top < clip.bottom
  const contained = (rect, clip) => rect.left >= clip.left && rect.right <= clip.right
    && rect.top >= clip.top && rect.bottom <= clip.bottom

  function add(kind, name, rect, parent, position, extra = {}) {
    if (layers.length >= 4000) throw new RangeError('The capture exceeds 4000 editable layers')
    layers.push({
      kind, name, parent,
      bounds: [rect.x - position.x, rect.y - position.y, rect.width, rect.height],
      ...extra,
    })
    return layers.length - 1
  }

  function vector(element) {
    const namespace = 'http://www.w3.org/2000/svg'
    const copy = document.createElementNS(namespace, 'svg')
    let count = 0
    function append(node, target, depth) {
      if (++count > 4000 || depth > 48) throw new RangeError('Capture SVG is too complex')
      if (node.hasAttribute('data-omc-private')) {
        warnings.add('private-subtree-omitted')
        return
      }
      const tag = node.localName
      if (node.namespaceURI !== namespace || !vectorTags.has(tag)) {
        warnings.add('svg-feature-omitted')
        return
      }
      const styles = getComputedStyle(node)
      if (styles.display === 'none' || styles.visibility !== 'visible') return
      const child = document.createElementNS(namespace, tag)
      for (const key of ['d', 'points', 'x', 'y', 'width', 'height', 'rx', 'ry', 'r', 'cx', 'cy',
        'x1', 'y1', 'x2', 'y2']) {
        if (node.hasAttribute(key)) child.setAttribute(key, node.getAttribute(key))
      }
      for (const key of ['fill', 'stroke', 'stroke-width', 'fill-rule', 'opacity']) {
        const value = styles.getPropertyValue(key)
        if (!value.includes('url(') && value) child.setAttribute(key, value)
        else if (value) warnings.add('svg-feature-omitted')
      }
      if (styles.transform !== 'none') child.setAttribute('transform', styles.transform)
      if (styles.filter !== 'none' || styles.clipPath !== 'none' || styles.maskImage !== 'none'
        || styles.strokeDasharray !== 'none' || styles.fillOpacity !== '1' || styles.strokeOpacity !== '1') {
        warnings.add('svg-feature-omitted')
      }
      target.append(child)
      if (tag === 'g') for (const nested of node.children) append(nested, child, depth + 1)
    }
    for (const key of ['viewBox', 'preserveAspectRatio']) {
      if (element.hasAttribute(key)) copy.setAttribute(key, element.getAttribute(key))
    }
    for (const child of element.children) append(child, copy, 0)
    return new XMLSerializer().serializeToString(copy)
  }

  function visit(element, parent, position, depth, clip) {
    if (depth > 48) throw new RangeError('The capture exceeds 48 layout levels')
    const name = element.localName
    if (element.hasAttribute('data-omc-private') || element.isContentEditable) {
      warnings.add('private-subtree-omitted')
      return
    }
    if (blocked.has(name)) {
      if (!['script', 'style', 'template'].includes(name)) warnings.add('embedded-content-omitted')
      return
    }
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility !== 'visible' || style.opacity === '0') return
    if (style.display === 'contents') {
      visitChildren(element, parent, position, depth, style, clip)
      return
    }
    const rect = element.getBoundingClientRect()
    if (!visible(rect, clip)) return
    if (element.namespaceURI === 'http://www.w3.org/2000/svg') {
      const svg = vector(element)
      assetCharacters += svg.length
      if (assetCharacters > 8_000_000) throw new RangeError('Capture asset limit exceeded')
      add('vector', 'svg', rect, parent, position, { svg })
      return
    }
    const fill = style.backgroundColor
    const border = pixels(style.borderTopWidth)
    const radius = pixels(style.borderTopLeftRadius)
    if (style.backgroundImage !== 'none' || style.boxShadow !== 'none' || style.filter !== 'none'
      || style.transform !== 'none' || style.zIndex !== 'auto'
      || [style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].some(value => pixels(value) !== border)
      || [style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].some(value => pixels(value) !== radius)
      || (border > 0 && style.borderTopStyle !== 'solid')) {
      warnings.add('css-effects-approximated')
    }
    if (['::before', '::after'].some(pseudo => !['none', 'normal'].includes(getComputedStyle(element, pseudo).content))) {
      warnings.add('generated-content-omitted')
    }
    const clips = [style.overflowX, style.overflowY].map(clipsOverflow)
    if (clips[0] !== clips[1]) warnings.add('one-axis-clipping-approximated')
    if (element.shadowRoot) warnings.add('shadow-content-omitted')

    const base = { fill, opacity: Number(style.opacity) }
    if (name === 'img') {
      const source = element.currentSrc
      if (element.complete && element.naturalWidth > 0 && /^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(source)) {
        assetCharacters += source.length
        if (assetCharacters > 8_000_000) throw new RangeError('Capture asset limit exceeded')
        if (style.objectFit !== 'fill') warnings.add('image-fit-approximated')
        add('image', name, rect, parent, position, { ...base, source })
        return
      }
      warnings.add('image-source-omitted')
    }
    const here = add('frame', name, rect, parent, position, {
      ...base, clip: clips[0] || clips[1], radius, border,
      stroke: style.borderTopColor,
    })
    if (controls.has(name)) {
      warnings.add('form-values-omitted')
      return
    }
    if (name !== 'img') visitChildren(element, here, rect, depth, style, clips.some(Boolean) ? scrollport(element, rect, clip, clips) : clip)
  }

  function visitChildren(element, parent, rect, depth, style, clip) {
    for (const node of element.childNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        visit(node, parent, rect, depth + 1, clip)
      } else if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
        range.selectNodeContents(node)
        const box = range.getBoundingClientRect()
        if (!(box.width > 0 && box.height > 0) || !visible(box, clip)) continue
        if (!contained(box, clip)) {
          warnings.add('clipped-text-omitted')
          continue
        }
        if (range.getClientRects().length > 1) warnings.add('wrapped-text-approximated')
        if (style.textTransform !== 'none' || style.writingMode !== 'horizontal-tb') warnings.add('text-style-approximated')
        const text = ['pre', 'pre-wrap', 'break-spaces'].includes(style.whiteSpace)
          ? node.textContent : node.textContent.replace(/\s+/gu, ' ')
        add('text', 'Text', box, parent, rect, {
          text, color: style.color, fontSize: pixels(style.fontSize), fontFamily: style.fontFamily,
          fontWeight: Number(style.fontWeight), fontStyle: style.fontStyle === 'italic' ? 'italic' : 'normal',
          lineHeight: pixels(style.lineHeight) || box.height, letterSpacing: pixels(style.letterSpacing),
        })
      }
    }
  }

  visit(root, null, origin, 0, viewport)
  if (!layers.length) throw new Error('The selection contains no visible editable layers')
  return { version: 1, width, height, layers, warnings: [...warnings] }
}
