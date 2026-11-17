import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import {
  connectEditor, createAccount, getMcpEndpoint, loopbackOrigin, newFile, waitForBackend,
} from '../penpot-ld02.mjs';
import {duplicateFromDashboard, reopenPage, watchSave} from './ld03.mjs';
import {decodeNativeResult, readAfterAttach} from './ld09.mjs';

const fileName = 'OMC Benchmark LD04 / street-market';
const marker = 'LD04 ';
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function planResponsive(fixture) {
  assert.equal(fixture.workload,'LD04');
  assert.equal(fixture.source_family_id,'street-market');
  assert.equal(fixture.private_width_registered,true,'Register a private intermediate width before preparing the run');
  assert.match(fixture.withheld_width_commitment,/^[a-f0-9]{64}$/);
  assert.equal(fixture.start.nodes.length,31);
  const index = new Map(fixture.start.nodes.map(node => [node.key,node]));
  assert.equal(index.size,31);
  assert.deepEqual(fixture.public_widths,[1440,768,390]);
  const widths = fixture.responsive_steps.map(step => step.width);
  const withheld = widths[2];
  assert.ok(Number.isInteger(withheld) && withheld > 390 && withheld < 1440 && withheld !== 768);
  assert.deepEqual(widths,[768,390,withheld,1440]);
  const nodes = [...index.values()].map(node => {
    const [x,y,w,h] = node.bounds;
    const parent = node.parent === null ? null : index.get(node.parent).bounds;
    return {...node, localBounds:[x-(parent?.[0] ?? 0),y-(parent?.[1] ?? 0),w,h]};
  });
  const cards = fixture.expected.nodes.filter(node => node.parent === 'collection' && node.kind === 'frame')
    .map(({key,min_width,max_width}) => ({key,minWidth:min_width,maxWidth:max_width,
      lines:nodes.filter(node => node.parent === key).map(node => node.key)}));
  assert.equal(cards.length,8);
  const collection = index.get('collection');
  const title = index.get('title');
  const first = index.get('card/0/line-0');
  const second = index.get('card/0/line-1');
  return {nodes,widths,cards,collectionGap:collection.gap, canvasPad:title.bounds[0],
    headingGap:collection.bounds[1]-title.bounds[1]-title.bounds[3],
    cardPad:first.bounds[0]-index.get('card/0').bounds[0], lineGap:second.bounds[1]-first.bounds[1]-first.bounds[3]};
}

function guard(fileId) {
  assert.match(fileId,idPattern);
  return `if (penpot.currentFile.id !== ${JSON.stringify(fileId)} || penpot.currentFile.pages.length !== 1) {
    throw new Error("Wrong isolated LD04 file");
  }
  const root = penpot.currentPage.root;
  const prefix = ${JSON.stringify(marker)};
  const keyOf = shape => {
    if (!shape.name.startsWith(prefix)) throw new Error("Unexpected unmarked LD04 shape");
    return shape.name.slice(prefix.length).replaceAll(" / ","/");
  };`;
}

export function seedResponsive(plan, fileId) {
  return `${guard(fileId)}
  if (root.children.length) throw new Error("Expected blank synthetic baseline");
  const font = penpot.fonts.all.find(candidate => candidate.name === "Inter");
  if (!font) throw new Error("Fixture Inter face is unavailable");
  const shapes = new Map();
  for (const node of ${JSON.stringify(plan.nodes)}) {
    const shape = node.kind === "text" ? penpot.createText(node.text) : penpot.createBoard();
    shape.name = prefix + node.key;
    if (node.kind === "text") {
      font.applyToText(shape);
      shape.fontSize = String(node.font_size);
      shape.lineHeight = "1";
      shape.growType = "fixed";
      shape.verticalAlign = "center";
    } else {
      shape.clipContent = false;
    }
    const parent = node.parent === null ? null : shapes.get(node.parent);
    const [x,y,w,h] = node.localBounds;
    if (parent) parent.appendChild(shape);
    shape.resize(w,h);
    shape.x = (parent?.x ?? 0) + x;
    shape.y = (parent?.y ?? 0) + y;
    shapes.set(node.key,shape);
  }
  return {count:shapes.size, fontId:font.id};`;
}

export function adaptResponsive(plan, fileId) {
  const {cards,canvasPad,headingGap,cardPad,lineGap,collectionGap} = plan;
  return `${guard(fileId)}
  const input = ${JSON.stringify({cards,canvasPad,headingGap,cardPad,lineGap,collectionGap})};
  const expect = (parent, keys) => {
    const byKey = new Map(parent.children.map(child => [keyOf(child),child]));
    if (byKey.size !== parent.children.length || byKey.size !== keys.length || keys.some(key => !byKey.has(key))) {
      throw new Error("Unexpected editable starting hierarchy");
    }
    return keys.map(key => byKey.get(key));
  };
  const [canvas] = expect(root,["canvas"]);
  const [title, collection] = expect(canvas,["title","collection"]);
  const cards = expect(collection,input.cards.map(card => card.key));
  const content = cards.map((card, index) => expect(card,input.cards[index].lines));
  if (title.type !== "text" || content.flat().some(line => line.type !== "text") ||
      [canvas,collection,...cards].some(shape => shape.type !== "board" || shape.flex || shape.grid)) {
    throw new Error("Expected a fixed desktop collection before its adaptation");
  }
  const flexBoard = (shape, children, dir, width, pad, gap) => {
    const layout = shape.addFlexLayout();
    layout.dir = dir;
    layout.alignItems = "start";
    layout.alignContent = "start";
    layout.justifyContent = "start";
    layout.horizontalPadding = pad;
    layout.verticalPadding = pad;
    layout.rowGap = gap;
    layout.columnGap = gap;
    for (const child of children) layout.appendChild(child);
    layout.horizontalSizing = width;
    layout.verticalSizing = "auto";
    return layout;
  };
  flexBoard(canvas,[title,collection],"column","fix",input.canvasPad,input.headingGap);
  title.layoutChild.horizontalSizing = "fill";
  const wrap = flexBoard(collection,cards,"row","fill",0,input.collectionGap);
  wrap.wrap = "wrap";
  for (const [index,card] of cards.entries()) {
    const {minWidth,maxWidth} = input.cards[index];
    flexBoard(card,content[index],"column","fill",input.cardPad,input.lineGap);
    card.layoutChild.minWidth = minWidth;
    card.layoutChild.maxWidth = maxWidth;
    for (const line of content[index]) line.layoutChild.horizontalSizing = "fill";
  }
  return canvas.id;`;
}

export function readResponsive(fileId) {
  return `${guard(fileId)}
  const nodes = [];
  const bounds = shape => [shape.x,shape.y,shape.width,shape.height];
  const tolerance = 2;
  const encloses = (outer, inner) => inner[0] >= outer[0]-tolerance && inner[1] >= outer[1]-tolerance &&
    inner[0]+inner[2] <= outer[0]+outer[2]+tolerance && inner[1]+inner[3] <= outer[1]+outer[3]+tolerance;
  const visit = (shape, parent, ancestors, editable) => {
    const key = keyOf(shape);
    const row = {key,parent,native_id:shape.id,kind:shape.type === "board" ? "frame" : shape.type,
      editable:editable && !shape.blocked && !shape.hidden,bounds:bounds(shape)};
    const children = shape.children ?? [];
    if (shape.type === "text") {
      const rendered = shape.textBounds ? bounds(shape.textBounds) : null;
      Object.assign(row,{text:shape.characters,font_family:shape.fontFamily,font_size:Number(shape.fontSize),
        font_id:shape.fontId,rendered_bounds:rendered,fully_visible:row.editable && rendered !== null &&
          rendered.every(Number.isFinite) && rendered[2] > 0 && rendered[3] > 0 &&
          [row.bounds,...ancestors].every(container => encloses(container,rendered))});
    } else if (shape.type === "board") {
      const f = shape.flex;
      row.layout = f ? (f.dir === "row" && f.wrap === "wrap" ? "horizontal-wrap" : f.dir) : "fixed";
      row.height_rule = f?.verticalSizing === "auto" ? "content" : "fixed";
      row.clip_content = shape.clipContent;
      row.native_horizontal = f?.horizontalSizing ?? null;
      row.native_vertical = f?.verticalSizing ?? null;
      if (key === "collection") {
        const [first,second] = [...children].sort((a,b) => a.y-b.y || a.x-b.x);
        row.gap = f?.columnGap ?? (second && second.x-first.x-first.width);
        row.row_gap = f?.rowGap ?? null;
        row.align = f ? f.justifyContent : (Math.abs(first.x-shape.x) <= tolerance ? "start" : "unknown");
        row.overflow_x = children.some(child => child.x < shape.x-tolerance ||
          child.x+child.width > shape.x+shape.width+tolerance) ? "present" : "none";
      }
      if (parent === "collection" && f) {
        row.min_width = shape.layoutChild?.minWidth ?? null;
        row.max_width = shape.layoutChild?.maxWidth ?? null;
        // The public native layout has fill/min/max, with no independent basis.
        row.basis_width = null;
      }
    }
    nodes.push(row);
    for (const child of children) visit(child,key,[row.bounds,...ancestors],row.editable);
  };
  for (const shape of root.children) visit(shape,null,[],true);
  const local = penpot.library.local;
  const styles = [...local.colors,...local.typographies].map(style => ({key:style.name,native_id:style.id}));
  return {document_id:penpot.currentFile.id,nodes,styles};`;
}

export function verifyWidthSelection(fileId, canvasId) {
  assert.match(canvasId,idPattern);
  return `${guard(fileId)}
  const [canvas] = root.children;
  if (root.children.length !== 1 || canvas.id !== ${JSON.stringify(canvasId)} || keyOf(canvas) !== "canvas" ||
      canvas.flex?.horizontalSizing !== "fix" || canvas.proportionLock || penpot.selection.length !== 1 ||
      penpot.selection[0].id !== canvas.id) throw new Error("Wrong native width target or inspector selection");
  return canvas.id;`;
}

async function widthInspector(page, execute, fileId, canvasId, evidence) {
  const panel = page.locator('section[aria-label="shape-measures-section"]');
  const field = panel.locator('input[aria-label="Width"], [title="Width"] input').filter({visible:true});
  try {
    // Select the same native layer through the editor sidebar so the inspector updates with it.
    const layer = page.locator(`span#layer-name-${canvasId}`);
    assert.equal(await layer.textContent({timeout:5000}),marker+'canvas');
    await layer.click({timeout:5000});
    await field.waitFor({state:'visible',timeout:5000});
    assert.equal(await execute(verifyWidthSelection(fileId,canvasId)),canvasId);
    assert.ok(await field.isEnabled(),'The native Width input is disabled');
    return field;
  } catch (error) {
    evidence.width_inspector_diagnostics = await page.locator('section[aria-label="shape-measures-section"]')
      .locator('input').evaluateAll(inputs => inputs.map(input => ({label:input.getAttribute('aria-label'),
        parentTitle:input.parentElement?.getAttribute('title'),disabled:input.disabled,visible:input.getClientRects().length > 0})));
    throw error;
  }
}

async function capture(execute, id, width) {
  const deadline = performance.now()+5000;
  let previous;
  for (;;) {
    const state = await readAfterAttach(() => execute(readResponsive(id)));
    assert.equal(state.document_id,id);
    const actualWidth = state.nodes.find(node => node.key === 'canvas')?.bounds[2];
    const stable = isDeepStrictEqual(state,previous) && state.nodes.every(node =>
      node.kind !== 'text' || node.rendered_bounds?.[2] > 0);
    if (Math.abs(actualWidth-width) < 0.01 && (stable || performance.now() >= deadline)) return state;
    if (performance.now() >= deadline) throw new Error(`Native width ${actualWidth} did not reach ${width}`);
    previous = state;
    await delay(250);
  }
}

async function replay(origin, fixture, plan, output) {
  await waitForBackend(origin);
  const {benchRequire,Client,StreamableHTTPClientTransport} = await import('../replays/mcp.mjs');
  const {chromium} = benchRequire('playwright');
  const client = new Client({name:'omc-ld04-responsive',version:'1'});
  const email = `omc-bench-${randomBytes(10).toString('hex')}@example.test`;
  const password = randomBytes(20).toString('hex')+'Aa1!';
  let browser, endpoint;
  let phase = 'disposable account setup';
  const evidence = {probe_actions:[],width_observations:[],withheld_width_commitment:fixture.withheld_width_commitment};
  try {
    browser = await chromium.launch({channel:'chrome',headless:true});
    const context = await browser.newContext({locale:'en-US',viewport:{width:1440,height:960}});
    context.setDefaultTimeout(15000);
    const dashboard = await context.newPage();
    await createAccount(dashboard,origin,email,password);
    endpoint = await getMcpEndpoint(dashboard,origin);
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    let editor = await newFile(dashboard,context,origin);
    await editor.getByRole('toolbar',{name:'Drawing tools'}).waitFor();
    const workspace = new URL(editor.url());
    assert.equal(workspace.origin,origin);
    const id = workspace.searchParams.get('file-id');
    assert.match(id,idPattern);
    await editor.locator('header [class*="file-name-label"]').dblclick();
    const title = editor.locator('header input[class*="file-name-input"]');
    await title.fill(fileName);
    await title.press('Enter');
    await editor.getByText(fileName,{exact:true}).waitFor();
    if (editor !== dashboard) await dashboard.close();
    await connectEditor(editor);
    const execute = async code => {
      const wrapped = `try { ${code} } catch (error) { return { ld04Error:String(error.message) }; }`;
      const response = await client.callTool({name:'execute_code',arguments:{code:wrapped}},undefined,{timeout:25000});
      const result = decodeNativeResult(response);
      if (result?.ld04Error) throw new Error(result.ld04Error);
      return result;
    };
    await readAfterAttach(() => execute(`${guard(id)} return penpot.currentFile.id;`));

    phase = 'seed and observe native desktop baseline';
    const seeded = await execute(seedResponsive(plan,id));
    assert.equal(seeded.count,fixture.logical_objects);
    evidence.before = await capture(execute,id,1440);
    phase = 'adapt native flex layout in place';
    const editStart = performance.now();
    const saved = watchSave(editor,origin);
    const canvasId = await execute(adaptResponsive(plan,id));
    evidence.candidate = await capture(execute,id,1440);
    const editMs = performance.now()-editStart;
    const saveStatus = await saved;
    if (saveStatus instanceof Error) throw saveStatus;

    phase = 'normal original reopen';
    editor = await reopenPage(editor,context,workspace);
    evidence.reopened = await capture(execute,id,1440);
    const reopenMs = performance.now()-editStart;
    phase = 'dashboard duplicate of actual edited original';
    const {opened:copy,id:copyId} = await duplicateFromDashboard(editor,context,origin,fileName);
    assert.notEqual(copyId,id);
    evidence.probe = await capture(execute,copyId,1440);
    phase = 'open width-only inspector for the verified duplicate canvas';
    const copyCanvas = evidence.probe.nodes.find(node => node.key === 'canvas');
    const widthField = await widthInspector(copy,execute,copyId,copyCanvas.native_id,evidence);
    for (const width of plan.widths) {
      phase = `change only the width of the native duplicate (step ${evidence.probe_actions.length+1})`;
      await widthField.fill(String(width));
      await widthField.press('Enter');
      const state = await capture(execute,copyId,width);
      const observedWidth = Math.round(state.nodes.find(node => node.key === 'canvas').bounds[2]);
      evidence.probe_actions.push({op:'set_node',key:'canvas',property:'width',value:observedWidth});
      evidence.width_observations.push({width:observedWidth,...state});
    }

    phase = 'reread protected original after all copy probes';
    editor = await reopenPage(copy,context,workspace);
    evidence.after_probe_original = await capture(execute,id,1440);
    evidence.native_edit = {canvasId,fontId:seeded.fontId,widthProbeSurface:'native inspector Width',saveResponseObserved:saveStatus};
    await writeFile(output,JSON.stringify(evidence)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({workload:'LD04',sourceFamily:fixture.source_family_id,editMs,reopenMs,saveResponseObserved:saveStatus}));
  } catch (error) {
    const secrets = [email,password,endpoint?.searchParams.get('userToken')].filter(Boolean);
    const message = secrets.reduce((value,secret) => value.replaceAll(secret,'[redacted]'),String(error));
    if (evidence.before) {
      await writeFile(join(dirname(output),'ld04-partial-observations.json'),JSON.stringify({phase,...evidence})+'\n',
        {flag:'wx',mode:0o600});
    }
    throw new Error(`Penpot LD04 ${phase}: ${message}`);
  } finally {
    await Promise.allSettled([client.close(),browser?.close()]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [origin,path,...extra] = process.argv.slice(2);
  assert.ok(path && !extra.length && process.env.OMC_BENCH_CANDIDATE,
    'Use ld04.mjs LOOPBACK_ORIGIN CANONICAL_REGISTERED_STREET_MARKET_JSON with OMC_BENCH_CANDIDATE');
  const fixture = JSON.parse(await readFile(path,'utf8'));
  await replay(loopbackOrigin(origin),fixture,planResponsive(fixture),process.env.OMC_BENCH_CANDIDATE);
}
