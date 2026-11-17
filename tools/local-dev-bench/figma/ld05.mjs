import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

// IDs come from the genuine source capture in the approved synthetic Draft.
async function nativeCycle(figma, {fileKey, scope, changes}) {
  if (figma.fileKey !== fileKey) throw new Error('Wrong synthetic Draft');
  const page = await figma.getNodeByIdAsync(scope.page);
  const root = await figma.getNodeByIdAsync(scope.root);
  if (page?.type !== 'PAGE' || root?.type !== 'FRAME' || root.parent?.id !== page.id) {
    throw new Error('Wrong captured Figma page or frame');
  }
  await figma.setCurrentPageAsync(page);
  const load = async (id, type, parent) => {
    const node = await figma.getNodeByIdAsync(id);
    if (node?.type !== type || node.parent?.id !== parent.id || node.locked || !node.visible) {
      throw new Error('Unexpected or noneditable captured layer');
    }
    return node;
  };
  const list = await load(scope.list, 'FRAME', root);
  if (list.layoutMode === 'NONE' || list.children.length !== scope.cards.length) throw new Error('Unbound native card layout');
  const labels = {};
  for (const [name,id] of Object.entries(scope.labels ?? {})) {
    labels[name] = (await load(id,'TEXT',root)).characters;
  }
  const cards = [];
  for (const [index, spec] of scope.cards.entries()) {
    const frame = await load(spec.frame, 'FRAME', list);
    const title = await load(spec.heading, 'TEXT', frame);
    if (list.children[index]?.id !== frame.id || title.characters !== spec.title || title.hasMissingFont) {
      throw new Error('Wrong component identity or card order');
    }
    const detail = spec.detail ? await load(spec.detail, 'TEXT', frame) : null;
    const asset = spec.asset ? await load(spec.asset, 'RECTANGLE', frame) : null;
    cards.push({frame, title, detail, asset});
  }
  const rgb = value => {
    const [r, g, b] = [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16) / 255);
    return {r, g, b};
  };
  const hex = color => '#' + ['r','g','b'].map(key => Math.round(color[key] * 255).toString(16).padStart(2,'0')).join('');
  const paint = value => ({type:'SOLID', color:rgb(value)});
  const last = cards.at(-1);
  const read = async () => ({
    document_id:figma.fileKey, page_id:page.id, root_id:root.id, list_id:list.id,
    gap:list.itemSpacing, direction:list.layoutMode, wrap:list.layoutWrap, labels,
    cards:await Promise.all(cards.map(async ({frame,title,detail,asset}) => {
      const fills = title.fills;
      if (!Array.isArray(fills) || fills.length !== 1 || fills[0].type !== 'SOLID') throw new Error('Unexpected heading paint');
      const imageHash = asset?.fills.find(fill => fill.type === 'IMAGE')?.imageHash;
      const original = imageHash ? figma.getImageByHash(imageHash) : null;
      const stroke = frame.strokes?.[0];
      return {frameId:frame.id, headingId:title.id, title:title.characters, radius:frame.cornerRadius,
        headingSize:title.fontSize, accent:hex(fills[0].color), flexBasis:frame.minWidth,
        detail:detail?.characters, detailId:detail?.id, assetId:asset?.id, imageHash, variant:frame.name,
        imageBytes:original ? Array.from(await original.getBytesAsync()) : undefined,
        border:stroke?.type === 'SOLID' ? hex(stroke.color) : undefined};
    })),
  });
  if (!changes) return read();
  // Resolve and validate every target before touching the captured Figma frame.
  if (changes.cycle === 1) {
    if (list.itemSpacing !== 12 || cards.some(({frame,title}) => frame.cornerRadius !== 6 || title.fontSize !== 20)) {
      throw new Error('Starting layout styles changed');
    }
    for (const {title} of cards) await figma.loadFontAsync(title.fontName);
    list.itemSpacing = changes.gap;
    for (const {frame,title} of cards) {
      frame.cornerRadius = changes.radius;
      title.fontSize = changes.heading_size;
    }
  } else if (changes.cycle === 2) {
    if (list.layoutMode !== 'VERTICAL') throw new Error('Starting list direction changed');
    list.layoutMode = 'HORIZONTAL';
    list.primaryAxisSizingMode = 'FIXED';
    list.layoutWrap = 'WRAP';
    for (const {frame,title} of cards) {
      frame.minWidth = 224;
      title.fills = [paint(changes.accent)];
    }
  } else {
    if (!last?.asset || !last.detail || !Array.isArray(changes.imageBytes)) {
      throw new Error('Missing editable variant, detail or registered image bytes');
    }
    const fills = last.asset.fills;
    if (!Array.isArray(fills) || fills.length !== 1 || fills[0].type !== 'IMAGE') throw new Error('Unexpected variant image fill');
    for (const {fontName} of last.detail.getStyledTextSegments(['fontName'])) await figma.loadFontAsync(fontName);
    // Unreferenced images can disappear between official Plugin API invocations.
    const replacement = figma.createImage(new Uint8Array(changes.imageBytes));
    if (replacement.hash !== changes.imageHash) throw new Error('Registered replacement image hash changed');
    last.frame.strokes = [paint(changes.variant_border)];
    last.frame.name = changes.variant;
    last.detail.characters = changes.copy;
    last.asset.fills = [{...fills[0], imageHash:replacement.hash}];
  }
  return read();
}

async function nativeRefresh(figma, {fileKey, pageName, scope, source, anchors}) {
  if (figma.fileKey !== fileKey) throw new Error('Wrong synthetic Draft');
  if (anchors.some(anchor=>!figma.root.children.some(page=>page.id===anchor.id && page.name===anchor.name))) {
    throw new Error('The approved synthetic Draft no longer has its registered pages');
  }
  const named = figma.root.children.filter(page => page.name === pageName);
  if (scope ? named.length !== 1 || named[0].id !== scope.page : named.length !== 0) {
    throw new Error('Expected a distinct recovery page or the exact prepared page');
  }
  const font = {family:'Inter',style:'Regular'};
  await figma.loadFontAsync(font);
  const page = scope ? named[0] : figma.createPage();
  if (!scope) page.name = pageName;
  await figma.setCurrentPageAsync(page);
  const validate = async (id,type,parent) => {
    const node = await figma.getNodeByIdAsync(id);
    if (node?.type !== type || node.parent?.id !== parent.id || !node.visible || node.locked) {
      throw new Error('Prepared editable source layer changed');
    }
    return node;
  };
  const attach = (parent,node,name) => { parent.appendChild(node); node.name=name; return node; };
  const auto = (frame,mode,gap) => {
    frame.layoutMode=mode; frame.primaryAxisSizingMode='AUTO'; frame.counterAxisSizingMode='FIXED';
    frame.itemSpacing=gap; frame.clipsContent=false;
  };
  const root = scope ? await validate(scope.root,'FRAME',page) : attach(page,figma.createFrame(),'LD05 source');
  if (!scope) { root.resize(1088,240); auto(root,'VERTICAL',12); }
  const list = scope ? await validate(scope.list,'FRAME',root) : attach(root,figma.createFrame(),'cards');
  if (!scope) list.resize(1024,200);
  const oldCards = [];
  for (const card of scope?.cards ?? []) {
    const frame = await validate(card.frame,'FRAME',list);
    const heading = await validate(card.heading,'TEXT',frame);
    const detail = await validate(card.detail,'TEXT',frame);
    const asset = await validate(card.asset,'RECTANGLE',frame);
    if (heading.characters !== card.title) throw new Error('Prepared card title changed');
    oldCards.push({frame,heading,detail,asset});
  }
  if (list.children.length !== oldCards.length || source.cards.length < oldCards.length ||
      oldCards.some((old,index)=>old.heading.characters !== source.cards[index].title)) {
    throw new Error('Source refresh would replace registered cards');
  }
  const labels = {};
  for (const [key,id] of Object.entries(scope?.labels ?? {})) {
    if (!(key in source.labels)) throw new Error('Source refresh unexpectedly drops an existing label');
    labels[key] = await validate(id,'TEXT',root);
  }
  if (root.children.length !== 1 + Object.keys(labels).length) throw new Error('Unregistered children in source root');

  const color = hex => {
    const [r,g,b] = [1,3,5].map(index=>parseInt(hex.slice(index,index+2),16)/255);
    return {type:'SOLID', color:{r,g,b}};
  };
  const text = (node,value,size,fill) => {
    node.fontName=font; node.fontSize=size; node.characters=value; node.fills=[color(fill)];
  };
  for (const [key,value] of Object.entries(source.labels)) {
    const label = labels[key] ?? attach(root,figma.createText(),key);
    if (!labels[key]) root.insertChild(root.children.indexOf(list),label);
    text(label,value,18,'#182132'); labels[key]=label;
  }
  auto(list,source.wrap?'HORIZONTAL':'VERTICAL',source.gap);
  if (source.wrap) {
    list.primaryAxisSizingMode='FIXED';
    list.layoutWrap='WRAP';
  }
  const images = Object.fromEntries(Object.entries(source.images).map(([name,bytes])=>
    [name,figma.createImage(new Uint8Array(bytes)).hash]));
  const cards = source.cards.map((card,index) => {
    const prior = oldCards[index];
    const frame = prior?.frame ?? attach(list,figma.createFrame(),card.variant);
    frame.name=card.variant;
    frame.resize(source.wrap?224:480,120);
    auto(frame,'VERTICAL',4);
    if (source.wrap) frame.minWidth=224;
    frame.cornerRadius=source.radius;
    frame.fills=[color('#ffffff')];
    frame.strokes=card.variant==='standard'?[]:[color(source.variantBorder)];
    const asset = prior?.asset ?? attach(frame,figma.createRectangle(),'image');
    asset.resize(64,36);
    asset.fills=[{type:'IMAGE',scaleMode:'FIT',imageHash:images[card.image]}];
    const heading = prior?.heading ?? attach(frame,figma.createText(),'heading');
    const detail = prior?.detail ?? attach(frame,figma.createText(),'detail');
    text(heading,card.title,source.headingSize,source.accent);
    text(detail,card.detail,14,'#182132');
    return {title:card.title,frame:frame.id,heading:heading.id,detail:detail.id,asset:asset.id};
  });
  return {fileKey,page:page.id,root:root.id,list:list.id,cards,labels:Object.fromEntries(
    Object.entries(labels).map(([key,node])=>[key,node.id])),imageHashes:images};
}

export function planLD05Refresh({fileKey,sessionId,pageName,scope,source,anchors}) {
  assert.match(fileKey ?? '', /^[A-Za-z0-9_-]{1,128}$/);
  assert.match(pageName, /^LD05 (route-board|supply-ledger) [a-f0-9]{12}$/);
  assert.ok(anchors.length===10 && anchors.every(row=>typeof row.id==='string' && typeof row.name==='string'));
  assert.ok(source.cards.length>=2 && source.cards.length<=4);
  assert.ok(Object.values(source.images).every(bytes=>bytes.length>8 && bytes.length<=4096));
  return {fileKey,sessionId,description:'Refresh the exact synthetic source projection in the approved Draft',
    skillNames:'resource:figma-use,resource:figma-generate-design',
    code:`return await (${nativeRefresh.toString()})(figma, ${JSON.stringify({fileKey,pageName,scope,source,anchors})});`};
}

export function planLD05NativeCycle({fileKey, sessionId, scope, cycle, changes}) {
  assert.match(fileKey ?? '', /^[A-Za-z0-9_-]{1,128}$/);
  assert.match(sessionId ?? '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
  assert.ok([1, 2, 3].includes(cycle));
  assert.ok(scope.cards.length >= 2 && scope.cards.every(row => typeof row.title === 'string' && row.title));
  const ids = [scope.page, scope.root, scope.list, ...scope.cards.flatMap(row => [row.frame, row.heading, row.detail, row.asset].filter(Boolean))];
  assert.ok(ids.every(id => typeof id === 'string' && /^\d+:\d+$/.test(id)));
  assert.equal(new Set(ids).size, ids.length);
  const color = value => assert.match(value ?? '', /^#[a-f0-9]{6}$/i);
  const pixels = value => assert.ok(Number.isInteger(value) && value > 0 && value < 100);
  if (cycle === 1) [changes.gap, changes.radius, changes.heading_size].forEach(pixels);
  if (cycle === 2) color(changes.accent);
  if (cycle === 3) {
    color(changes.variant_border);
    assert.match(changes.imageHash ?? '', /^[a-f0-9]{16,128}$/i);
    assert.ok(Array.isArray(changes.imageBytes) && changes.imageBytes.length > 8 && changes.imageBytes.length <= 4096 &&
      changes.imageBytes.every(byte=>Number.isInteger(byte) && byte >= 0 && byte <= 255));
    assert.ok(typeof changes.copy === 'string' && changes.copy.length > 0 && changes.copy.length <= 128);
    assert.match(changes.variant ?? '', /^[a-z][a-z-]{0,31}$/);
    assert.ok(scope.cards.at(-1)?.detail && scope.cards.at(-1)?.asset);
  }
  const request = (description, edit) => ({fileKey, sessionId, description,
    skillNames:edit ? 'resource:figma-use,resource:figma-generate-design' : 'resource:figma-use',
    code:`return await (${nativeCycle.toString()})(figma, ${JSON.stringify({fileKey, scope, changes:edit})});`});
  return {read:request('Read pinned editable LD05 source capture'),
    edit:request(`Apply the scoped editable LD05 cycle ${cycle} change`, {...changes, cycle})};
}

export async function mergeLD05NativeHandoff({fixture, scope, cycle, reobserved, css, data, assetSha256}) {
  const wanted = fixture.cycles[cycle - 1].result;
  assert.equal(reobserved.document_id, scope.fileKey);
  assert.equal(reobserved.page_id, scope.page);
  assert.equal(reobserved.root_id, scope.root);
  assert.equal(reobserved.list_id, scope.list);
  const rows = reobserved.cards;
  assert.deepEqual(rows.map(row => row.title), wanted.cards);
  assert.deepEqual(rows.map(row => [row.frameId, row.headingId]), scope.cards.map(row => [row.frame, row.heading]));
  const {mergeStyles, mergeExtraCard} = await import('../omc-native/ld05.mjs');
  let values;
  switch (cycle) {
    case 1:
      assert.equal(reobserved.gap, wanted.gap);
      assert.ok(rows.every(row => row.radius === wanted.radius && row.headingSize === wanted.heading_size));
      values = {gap:reobserved.gap+'px', radius:rows[0].radius+'px', heading_size:rows[0].headingSize+'px'};
      break;
    case 2:
      assert.equal(reobserved.direction, 'HORIZONTAL');
      assert.equal(reobserved.wrap, 'WRAP');
      assert.ok(rows.every(row => row.flexBasis === 224 && row.accent === wanted.accent.toLowerCase()));
      values = {direction:'row', wrap:'wrap', flex:'1 1 '+(rows[0].flexBasis/16)+'rem', accent:rows[0].accent};
      break;
    case 3: {
      const row = rows.at(-1);
      assert.equal(row.assetId, scope.cards.at(-1).asset);
      assert.equal(row.detailId, scope.cards.at(-1).detail);
      assert.equal(row.variant, wanted.variant);
      assert.equal(row.detail, wanted.copy);
      assert.equal(row.border, wanted.variant_border.toLowerCase());
      assert.ok(Array.isArray(row.imageBytes) && row.imageBytes.every(value => Number.isInteger(value) && value >= 0 && value <= 255));
      const originalBytes = Buffer.from(row.imageBytes);
      assert.equal(createHash('sha256').update(originalBytes).digest('hex'), assetSha256, 'Uploaded original differs');
      values = {variant_border:row.border};
      data = mergeExtraCard(data,row.variant,wanted.asset,row.detail);
      break;
    }
    default:
      throw new Error('Unknown LD05 cycle');
  }
  return {css:mergeStyles(css,cycle,values), data};
}
