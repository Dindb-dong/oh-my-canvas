import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const chrome = process.env.OMC_CAPTURE_CHROME_BINARY
const sdk = process.env.OMC_TEST_SDK_ROOT
const testPixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
const captureModule = new URL('../../scripts/capture-web.mjs', import.meta.url)
let fixtureCaptures

function captures() {
  fixtureCaptures ??= captureFixtures()
  return fixtureCaptures
}

async function captureFixtures() {
  const directory = await mkdtemp(join(tmpdir(), 'omc-web-capture-chrome-'))
  const module = await readFile(captureModule)
  const server = createServer((request, response) => {
    if (request.url === '/capture-web.mjs') {
      response.setHeader('Content-Type', 'text/javascript')
      response.end(module)
      return
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:")
    response.end(`<!doctype html><meta charset="utf-8">
      <style>
        * { box-sizing: border-box }
        body { margin: 16px; font: 16px/24px sans-serif; color: #153456 }
        main { width: 100%; padding: 12px; border: 2px solid #141414; border-radius: 8px; background: #f0f3ff }
        #card { padding: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; background: #ffffff }
        #scroll { height: 42px; overflow: auto }
        #past { height: 70px }
        #outside-clip { height: 9px; overflow: hidden }
        span::after { content: "generated content" }
        img, svg { display: block; width: 24px; height: 24px }
        @media (max-width: 700px) { #card { grid-template-columns: 1fr } }
      </style>
      <main id="selected">
        <div id="card">
          <div><span id="state"></span><strong> Editable rich text</strong></div>
          <svg viewBox="0 0 24 24"><path d="M 2 2 H 22 V 22 Z" style="fill:rgb(16,120,90)"/></svg>
          <img src="data:image/png;base64,${testPixel}" alt="Pixel">
          <img src="https://example.invalid/?auth=CAPTURE_URL_SECRET" alt="Denied image">
          <input type="password" value="CAPTURE_FORM_SECRET">
          <div data-omc-private>CAPTURE_PRIVATE_SECRET</div>
          <div id="scroll"><div id="past"><p>Scroll first</p><p>CAPTURE_OFFSCREEN_SECRET</p></div></div>
        </div>
      </main>
      <div>CAPTURE_NONSELECTED_SECRET</div>
      <div id="outside-clip"><div id="clipped-selection">CAPTURE_PARTIAL_SECRET</div></div>
      <pre id="capture-output"></pre>
      <script type="module">
        import capture from '/capture-web.mjs'
        await document.fonts.ready
        await Promise.all([...document.images].map(image => image.decode().catch(() => {})))
        document.querySelector('#state').textContent = innerWidth > 700 ? 'Wide ready' : 'Narrow editing'
        const selection = capture(document.querySelector('#selected'))
        const clipped = capture(document.querySelector('#clipped-selection'))
        const bytes = new TextEncoder().encode(JSON.stringify({ selection, clipped }))
        document.querySelector('#capture-output').textContent = btoa(String.fromCharCode(...bytes))
      </script>`)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const results = []
    for (const width of [500, 900]) {
      const { stdout } = await promisify(execFile)(chrome, [
        '--headless=new', '--dump-dom', '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--disable-component-update', '--disable-sync',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        `--window-size=${width},650`, `--user-data-dir=${join(directory, String(width))}`,
        `http://127.0.0.1:${server.address().port}/`,
      ], { timeout: 20000, maxBuffer: 1024 * 1024 })
      const encoded = stdout.match(/<pre id="capture-output">([A-Za-z0-9+/=]+)<\/pre>/)?.[1]
      assert.ok(encoded, 'Chrome returned a capture bundle')
      const { selection, clipped } = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
      assert.equal(clipped.height, 9)
      assert.ok(clipped.warnings.includes('clipped-text-omitted'))
      assert.doesNotMatch(JSON.stringify(clipped), /CAPTURE_PARTIAL_SECRET/)
      results.push(selection)
    }
    return results
  } finally {
    server.close()
    await rm(directory, { recursive: true, force: true })
  }
}

test('isolated Chrome capture measures responsive layout and omits private content', {
  skip: !chrome && 'Set OMC_CAPTURE_CHROME_BINARY to an installed Chrome executable',
}, async () => {
  const [narrow, wide] = await captures()
  assert.equal(narrow.width, 468)
  assert.equal(wide.width, 868)
  const text = (scene, value) => scene.layers.find(layer => layer.text === value)
  assert.ok(text(narrow, 'Narrow editing'))
  assert.ok(text(wide, 'Wide ready'))
  const vector = scene => scene.layers.find(layer => layer.kind === 'vector')
  assert.ok(vector(narrow).bounds[1] > vector(wide).bounds[1])
  for (const bundle of [narrow, wide]) {
    assert.ok(bundle.layers.some(layer => layer.source?.endsWith(testPixel)))
    assert.ok(bundle.layers.some(layer => layer.clip && layer.bounds[3] === 42))
    for (const warning of ['form-values-omitted', 'private-subtree-omitted', 'image-source-omitted', 'generated-content-omitted']) {
      assert.ok(bundle.warnings.includes(warning), warning)
    }
    assert.doesNotMatch(JSON.stringify(bundle), /CAPTURE_\w+_SECRET|example\.invalid/)
  }
})

test('default native MCP imports browser geometry, edits layers and reopens them', {
  skip: !chrome && 'Set OMC_CAPTURE_CHROME_BINARY to an installed Chrome executable',
}, async () => {
  const clientModule = sdk ? pathToFileURL(join(sdk, 'dist/esm/client/index.js')).href : '@modelcontextprotocol/sdk/client/index.js'
  const transportModule = sdk ? pathToFileURL(join(sdk, 'dist/esm/client/stdio.js')).href : '@modelcontextprotocol/sdk/client/stdio.js'
  const { Client } = await import(clientModule)
  const { StdioClientTransport } = await import(transportModule)
  const directory = await mkdtemp(join(tmpdir(), 'omc-web-capture-native-'))
  const service = process.env.OMC_SERVICE_BINARY ?? fileURLToPath(new URL('../target/debug/omc-service', import.meta.url))
  const cli = process.env.OMC_CLI_BINARY ?? fileURLToPath(new URL('../target/debug/omc-cli', import.meta.url))
  const child = spawn(service, ['--profile', directory, '--port', '0'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const exit = once(child, 'exit')
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000) })
  const connect = async () => {
    const client = new Client({ name: 'web-capture-check', version: '1.0.0' })
    await client.connect(new StdioClientTransport({ command: cli, args: ['--profile', directory, '--connect-only'] }))
    return client
  }
  const call = async (client, name, args) => {
    const response = await client.callTool({ name, arguments: args })
    const value = response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text)
    if (response.isError) throw new Error(value.message ?? JSON.stringify(value))
    return value
  }
  let writer
  let reader
  try {
    let ready = false
    for (let tries = 0; tries < 200 && child.exitCode === null; tries += 1) {
      try {
        const descriptor = JSON.parse(await readFile(join(directory, 'native-v1', 'service.json'), 'utf8'))
        ready = (await fetch(descriptor.endpoint + '/health', {
          headers: { Authorization: `Bearer ${descriptor.token}` },
          signal: AbortSignal.timeout(1000),
        })).ok
        if (ready) break
      } catch {}
      await delay(25)
    }
    assert.ok(ready, stderr)
    writer = await connect()
    const [narrow, wide] = await captures()
    const payload = JSON.stringify(narrow)
    const catalog = await writer.listTools()
    const importSchema = catalog.tools.find(tool => tool.name === 'import_document').inputSchema
    assert.ok(importSchema.properties.format.enum.includes('web-capture'))
    await assert.rejects(call(writer, 'import_document', { format: 'web-capture', payload }), /unsupported source feature/)
    const document = await call(writer, 'import_document', { format: 'web-capture', payload, strict: false })
    assert.ok(document.diagnostics.some(diagnostic => diagnostic.code === 'image_source_omitted'))
    const wideDoc = await call(writer, 'import_document', { format: 'web-capture', payload: JSON.stringify(wide), strict: false })
    const id = document.documentId
    const read = (client, documentId) => call(client, 'get_tree', { documentId, detail: 'detailed', depth: 12 })
    const tree = await read(writer, id)
    const wideTree = await read(writer, wideDoc.documentId)
    const viewport = tree.nodes.find(layer => layer.name === 'Captured viewport')
    assert.equal(viewport.width, narrow.width)
    assert.equal(wideTree.nodes.find(layer => layer.name === 'Captured viewport').width, wide.width)
    assert.ok(tree.nodes.some(layer => layer.properties?.clipContent && layer.height === 42))
    const text = tree.nodes.find(layer => layer.properties?.text === 'Narrow editing')
    const vector = tree.nodes.find(layer => layer.kind === 'path')
    assert.ok(text && vector, 'editable text and vector nodes are present')
    const canvasPng = () => call(writer, 'export_document', { id, format: 'png', ids: [viewport.id] })
    const before = await canvasPng()
    const png = Buffer.from(before.base64, 'base64')
    assert.equal(png.readUInt32BE(16), narrow.width)
    assert.equal(png.readUInt32BE(20), Math.ceil(narrow.height))
    await call(writer, 'edit_text', { documentId: id, action: 'replace', id: text.id, text: 'Edited' })
    const path = await call(writer, 'get_path', { documentId: id, id: vector.id })
    await call(writer, 'edit_path', { documentId: id, id: vector.id, revision: path.revision,
      action: 'move_nodes', indices: [0], dx: 4, dy: 0 })
    assert.notEqual((await canvasPng()).sha256, before.sha256)
    await call(writer, 'save_document', { id })
    await writer.close()
    writer = null
    reader = await connect()
    await call(reader, 'open_document', { id })
    const edited = await read(reader, id)
    assert.ok(edited.nodes.some(layer => layer.properties?.text === 'Edited'))
    assert.notDeepEqual(edited.nodes.find(layer => layer.kind === 'path').properties.path, vector.properties.path)
  } finally {
    await reader?.close()
    await writer?.close()
    child.kill()
    await exit
    await rm(directory, { recursive: true, force: true })
  }
})
