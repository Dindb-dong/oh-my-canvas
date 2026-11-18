import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { chromium } from 'playwright'

const extension = fileURLToPath(new URL('../../browser-capture/', import.meta.url))
const service = process.env.OMC_SERVICE_BINARY ?? fileURLToPath(new URL('../target/debug/omc-service', import.meta.url))
const cli = process.env.OMC_CLI_BINARY ?? fileURLToPath(new URL('../target/debug/omc-cli', import.meta.url))
const sdk = process.env.OMC_TEST_SDK_ROOT
const { Client } = await import(sdk ? pathToFileURL(join(sdk, 'dist/esm/client/index.js')).href : '@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = await import(sdk ? pathToFileURL(join(sdk, 'dist/esm/client/stdio.js')).href : '@modelcontextprotocol/sdk/client/stdio.js')

async function call(client, name, args = {}) {
  const reply = await client.callTool({ name, arguments: args })
  const value = reply.structuredContent ?? JSON.parse(reply.content.find(item => item.type === 'text').text)
  if (reply.isError) throw Object.assign(new Error(value.message), value)
  return value
}

async function startService(profile) {
  const child = spawn(service, ['--profile', profile, '--port', '0'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const exit = once(child, 'exit')
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1200) })
  try {
    for (let attempt = 0; attempt < 160 && child.exitCode === null; attempt += 1) {
      try {
        const descriptor = JSON.parse(await readFile(join(profile, 'native-v1/service.json'), 'utf8'))
        if (descriptor.pid === child.pid) return { child, exit, descriptor }
      } catch {}
      await delay(25)
    }
    throw new Error('OMC service did not start: ' + stderr)
  } catch (error) {
    child.kill()
    await exit.catch(() => {})
    throw error
  }
}

async function stopService(process) {
  if (!process) return
  process.child.kill('SIGINT')
  await process.exit
}

test('one default MCP call captures a real browser selection into a durable editable canvas', {
  skip: !existsSync(chromium.executablePath()) && 'Install the Playwright Chromium browser to exercise the actual extension',
  timeout: 45_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omc-browser-picker-'))
  const profile = join(directory, 'omc')
  let serviceProcess
  const site = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(`<!doctype html><meta charset="utf-8"><title>OMC local fixture</title>
      <style>
        #card { width: 310px; padding: 20px; background: #e4eaff; color: #13294b; font: 20px/28px sans-serif }
        svg { display: block }
      </style>
      <main id="card">
        <p id="label">Before browser selection</p>
        <svg width="32" height="32" viewBox="0 0 32 32"><path fill="#189363" d="M2 2 H30 V30 Z"/></svg>
        <input type="password" value="OMC_PRIVATE_FORM">
        <p data-omc-private>OMC_PRIVATE_NODE</p>
      </main>
      <button type="button" onclick="document.querySelector('#label').textContent='After browser selection'">Change state</button>
      <p>OMC_OUTSIDE_SELECTION</p>`)
  })
  site.listen(0, '127.0.0.1')
  let browser
  let writer
  let reader
  try {
    await once(site, 'listening')
    serviceProcess = await startService(profile)
    const { descriptor } = serviceProcess
    const connect = async () => {
      const client = new Client({ name: 'browser-picker-check', version: '1.0.0' })
      await client.connect(new StdioClientTransport({ command: cli, args: ['--profile', profile, '--connect-only'] }))
      return client
    }
    writer = await connect()
    const { tools } = await writer.listTools()
    assert.ok(tools.some(tool => tool.name === 'capture_web'))
    assert.ok(!tools.some(tool => tool.name === 'run_command'))
    const pairing = (await promisify(execFile)(cli, ['--profile', profile, '--connect-only', '--browser-capture-connection'])).stdout.trim()
    const { endpoint, key } = JSON.parse(pairing)
    assert.ok(key !== descriptor.token)
    const claimUrl = endpoint + '/browser-capture/claim'
    assert.equal((await fetch(claimUrl, { method: 'POST' })).status, 401)
    assert.equal((await fetch(claimUrl, { method: 'POST', headers: { Authorization: 'Bearer ' + key, Origin: 'https://untrusted.example' } })).status, 403)
    assert.equal((await fetch(endpoint + '/health', { headers: { Authorization: 'Bearer ' + key } })).status, 401)

    browser = await chromium.launchPersistentContext(join(directory, 'chromium'), {
      channel: 'chromium', headless: true, viewport: { width: 900, height: 650 },
      args: ['--enable-unsafe-extension-debugging', '--disable-background-networking',
        '--disable-extensions-except=' + extension, '--load-extension=' + extension],
    })
    const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker')
    const extensionId = new URL(worker.url()).hostname
    const settings = await browser.newPage()
    await settings.goto('chrome-extension://' + extensionId + '/options.html')
    await settings.getByLabel('OMC pairing data').fill(pairing)
    await settings.getByRole('button', { name: 'Save connection' }).click()
    await settings.getByRole('status').filter({ hasText: 'Connection saved.' }).waitFor()

    const page = await browser.newPage()
    await page.goto('http://localhost:' + site.address().port)
    const browserSession = await browser.browser().newBrowserCDPSession()
    const { targetInfos } = await browserSession.send('Target.getTargets', { filter: [{ type: 'tab' }] })
    const target = targetInfos.find(info => info.url === page.url())
    assert.ok(target, 'Chromium returned the fixture tab target')
    await browserSession.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId })
    await page.locator('[aria-hidden="true"]').waitFor({ state: 'attached' })
    await page.locator('#card').click({ position: { x: 5, y: 5 } })
    await page.locator('[aria-hidden="true"]').waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Change state' }).click()
    assert.equal(await page.locator('#label').textContent(), 'After browser selection')

    const captured = await call(writer, 'capture_web', { title: 'Live selection' })
    const documentId = captured.documentId
    assert.equal(captured.document.title, 'Live selection')
    const diagnostics = captured.diagnostics.map(item => item.code)
    assert.ok(diagnostics.includes('form_values_omitted'))
    assert.ok(diagnostics.includes('private_subtree_omitted'))
    const args = { documentId, detail: 'detailed', depth: 12 }
    const before = await call(writer, 'get_tree', args)
    const text = before.nodes.find(node => node.properties?.text === 'After browser selection')
    const vector = before.nodes.find(node => node.kind === 'path')
    assert.ok(text, 'live text exists as an editable layer')
    assert.ok(vector, 'SVG exists as an editable path')
    assert.doesNotMatch(JSON.stringify(before), /Before browser selection|OMC_PRIVATE_|OMC_OUTSIDE_SELECTION/)
    const viewport = before.nodes.find(node => node.name === 'Captured viewport')
    assert.ok(viewport)
    const render = client => call(client, 'export_document', { id: documentId, ids: [viewport.rawId], format: 'png' })
    const original = await render(writer)
    await call(writer, 'edit_text', { documentId, id: text.rawId, action: 'replace', text: 'Edited from OMC' })
    const path = await call(writer, 'get_path', { documentId, id: vector.rawId })
    await call(writer, 'edit_path', { documentId, id: vector.rawId, revision: path.revision,
      action: 'move_nodes', indices: [0], dx: 8, dy: 0 })
    const edited = await render(writer)
    assert.notEqual(original.sha256, edited.sha256)
    await call(writer, 'save_document', { id: documentId })
    await call(writer, 'workspace', { documentId, action: 'close' })
    await assert.rejects(call(writer, 'capture_web'), { code: 'browser_selection_unavailable' })
    await writer.close()
    writer = null
    await stopService(serviceProcess)
    serviceProcess = await startService(profile)

    reader = await connect()
    await call(reader, 'open_document', { id: documentId })
    const reopened = await call(reader, 'get_tree', args)
    assert.equal(reopened.nodes.find(node => node.rawId === text.rawId).properties.text, 'Edited from OMC')
    assert.notDeepEqual(reopened.nodes.find(node => node.rawId === vector.rawId).properties.path, vector.properties.path)
    assert.equal((await render(reader)).sha256, edited.sha256)
  } finally {
    await reader?.close()
    await writer?.close()
    await browser?.close()
    site.close()
    site.closeAllConnections()
    await stopService(serviceProcess)
    await rm(directory, { recursive: true, force: true })
  }
})
