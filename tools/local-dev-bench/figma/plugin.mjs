export async function inspect(figma, input) {
  if (figma.fileKey !== input.fileKey || figma.root.children.length !== 1) {
    throw new Error('Expected the single-page synthetic Figma file');
  }
  const page = figma.root.children[0];
  await figma.setCurrentPageAsync(page);
  const nodes = [];
  function collect(parent, parentKey, editable) {
    for (const node of parent.children) {
      const unlocked = editable && node.visible && !node.locked;
      nodes.push({ node, parentKey, unlocked });
      if ('children' in node) collect(node, node.name, unlocked);
    }
  }
  collect(page, null, true);
  const document_id = figma.fileKey;
  const page_id = page.id;

  if (input.image) {
    const images = nodes.filter(({ node }) => node.name === input.image);
    if (images.length !== 1) throw new Error('Expected a single named image layer');
    const { node } = images[0];
    const fills = node.type === 'RECTANGLE' && node.fills;
    if (!Array.isArray(fills) || fills.length !== 1 || fills[0].type !== 'IMAGE' ||
        fills[0].visible === false || fills[0].scaleMode !== 'FILL') throw new Error('Expected one visible image fill');
    const hash = fills[0].imageHash;
    const image = figma.getImageByHash(hash);
    if (!image) throw new Error('Image hash could not be resolved');
    const encoded = figma.base64Encode(await image.getBytesAsync());
    const { offset, limit } = input;
    return { document_id, page_id, native_id: node.id, key: node.name, hash, offset, length: encoded.length,
      base64: encoded.slice(offset, offset + limit) };
  }

  const hex = color => '#' + ['r', 'g', 'b'].map(channel =>
    Math.round(color[channel] * 255).toString(16).padStart(2, '0')).join('');
  if (input.styles) {
    const variables = await figma.variables.getLocalVariablesAsync();
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const styles = variables.map(variable => {
      const collection = collections.find(item => item.id === variable.variableCollectionId);
      const value = variable.valuesByMode[collection.defaultModeId];
      const color = variable.resolvedType === 'COLOR' && value && typeof value.r === 'number' && (value.a ?? 1) === 1;
      const length = variable.resolvedType === 'FLOAT' && typeof value === 'number';
      return { key: variable.name, native_id: variable.id, kind: color ? 'color' : length ? 'length' : variable.resolvedType,
        value: color ? hex(value) : length ? value : null };
    });
    return { document_id, page_id, node_count: nodes.length, styles };
  }

  const rows = nodes.slice(input.offset, input.offset + input.limit).map(({ node, parentKey, unlocked }) => {
    const row = { key: node.name, native_id: node.id, parent: parentKey, kind: node.type.toLowerCase(), editable: unlocked };
    const bounds = node.absoluteBoundingBox;
    if (bounds) row.bounds = [bounds.x, bounds.y, bounds.width, bounds.height];
    if (node.type === 'TEXT') {
      row.text = node.characters;
      row.font_family = node.fontName?.family ?? null;
      row.font_size = typeof node.fontSize === 'number' ? node.fontSize : null;
      row.editable = row.editable && !node.hasMissingFont;
    }
    if (node.type === 'FRAME') {
      if (node.layoutMode !== 'NONE') {
        row.layout = node.layoutMode.toLowerCase();
        row.gap = node.itemSpacing;
      }
    }
    if (node.type === 'FRAME' || node.type === 'TEXT' || node.type === 'RECTANGLE') {
      const fills = node.fills;
      const paint = Array.isArray(fills) && fills.length === 1 && fills[0].visible !== false ? fills[0] : null;
      if (paint?.type === 'SOLID' && (paint.opacity ?? 1) === 1) row.fill = hex(paint.color);
      if (node.type === 'RECTANGLE' && paint?.type === 'IMAGE' && paint.scaleMode === 'FILL') {
        row.kind = 'image';
        row.image_hash = paint.imageHash;
      }
      const bound = node.boundVariables ?? {};
      row.bindings = {};
      for (const [field, binding] of Object.entries(bound)) {
        if (field === 'fills' && paint?.boundVariables?.color?.id) {
          row.bindings.fill = paint.boundVariables.color.id;
        } else if (field === 'itemSpacing' && binding?.id) {
          row.bindings.gap = binding.id;
        } else {
          row.bindings[field] = binding?.id ?? true;
        }
      }
      if (paint?.boundVariables?.color?.id) row.bindings.fill = paint.boundVariables.color.id;
    } else {
      row.editable = false;
    }
    return row;
  });
  return { document_id, page_id, offset: input.offset, nodes: rows };
}

export async function seed(figma, input) {
  const [page] = figma.root.children;
  if (figma.fileKey !== input.fileKey || figma.root.children.length !== 1 || page.children.length) {
    throw new Error('Expected an empty single-page synthetic Figma file');
  }
  await figma.setCurrentPageAsync(page);
  if ((await figma.variables.getLocalVariablesAsync()).length) throw new Error('Expected no local variables');
  const font = { family: 'Inter', style: 'Regular' };
  await figma.loadFontAsync(font);
  const rgb = value => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16) / 255);
    return { r, g, b };
  };
  const images = new Map(input.images.map(([key, bytes]) => [key, figma.createImage(figma.base64Decode(bytes)).hash]));
  const variables = new Map();
  if (input.styles.length) {
    const collection = figma.variables.createVariableCollection('Synthetic LD03 values');
    for (const style of input.styles) {
      const color = style.kind === 'color';
      const variable = figma.variables.createVariable(style.key, collection, color ? 'COLOR' : 'FLOAT');
      variable.setValueForMode(collection.defaultModeId, color ? rgb(style.value) : style.value);
      variables.set(style.key, variable);
    }
  }
  const created = new Map();
  const createdNodeIds = [];
  for (const spec of input.nodes) {
    const parent = spec.parent ? created.get(spec.parent) : page;
    if (!parent) throw new Error('Fixture nodes must be in parent-first order');
    let node;
    if (spec.kind === 'frame') {
      node = figma.createFrame();
      node.fills = [];
      node.clipsContent = false;
      if (spec.layout) {
        node.layoutMode = spec.layout.toUpperCase();
        node.primaryAxisSizingMode = 'FIXED';
        node.counterAxisSizingMode = 'FIXED';
        node.itemSpacing = spec.gap;
        if (spec.layout === 'horizontal') node.counterAxisAlignItems = 'CENTER';
      }
      if (spec.fill) {
        let paint = { type: 'SOLID', color: rgb(spec.fill) };
        if (spec.bindings?.fill) paint = figma.variables.setBoundVariableForPaint(paint, 'color', variables.get(spec.bindings.fill));
        node.fills = [paint];
      }
      if (spec.bindings?.gap) node.setBoundVariable('itemSpacing', variables.get(spec.bindings.gap));
    } else if (spec.kind === 'text') {
      node = figma.createText();
      node.fontName = font;
      node.fontSize = spec.font_size ?? 16;
      node.textAutoResize = 'NONE';
      node.characters = spec.text;
      if (spec.lightText) node.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
    } else if (spec.kind === 'image') {
      node = figma.createRectangle();
      node.fills = [{ type: 'IMAGE', imageHash: images.get(spec.asset_rgba_sha256), scaleMode: 'FILL' }];
    } else {
      throw new Error('Unexpected fixture node type: ' + spec.kind);
    }
    node.name = spec.key;
    parent.appendChild(node);
    const [x, y, width, height] = spec.localBounds;
    node.resize(width, height);
    if (!spec.flows) {
      node.x = x;
      node.y = y;
    }
    created.set(spec.key, node);
    createdNodeIds.push(node.id);
  }
  return { createdNodeIds, createdVariableIds: [...variables.values()].map(variable => variable.id) };
}

export async function mutate(figma, input) {
  if (figma.fileKey !== input.fileKey || figma.root.children.length !== 1) throw new Error('Unexpected synthetic Figma file');
  const page = figma.root.children[0];
  await figma.setCurrentPageAsync(page);
  const variables = input.actions.some(action => action.op === 'set_style') ? await figma.variables.getLocalVariablesAsync() : [];
  const changes = [];
  for (const action of input.actions) {
    if (action.op === 'set_style') {
      const matches = variables.filter(variable => variable.name === action.key);
      const [variable] = matches;
      if (matches.length !== 1 || (typeof action.value === 'string' ? 'COLOR' : 'FLOAT') !== variable.resolvedType) {
        throw new Error('Expected one shared variable of the prescribed type');
      }
      const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
      changes.push(() => {
        const value = action.value;
        if (typeof value === 'string') {
          const [r, g, b] = [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16) / 255);
          variable.setValueForMode(collection.defaultModeId, { r, g, b });
        } else {
          variable.setValueForMode(collection.defaultModeId, value);
        }
        const observed = variable.valuesByMode[collection.defaultModeId];
        const actual = typeof value === 'string' ? '#' + ['r', 'g', 'b'].map(channel =>
          Math.round(observed[channel] * 255).toString(16).padStart(2, '0')).join('') : observed;
        return { op: action.op, key: variable.name, value: actual, id: variable.id };
      });
    } else {
      const matches = page.findAll(node => node.name === action.key);
      const [node] = matches;
      if (matches.length !== 1 || node.locked) throw new Error('Expected one editable node at the specified key');
      if (action.property === 'text' && node.type === 'TEXT') {
        for (const { fontName } of node.getStyledTextSegments(['fontName'])) await figma.loadFontAsync(fontName);
        changes.push(() => {
          node.characters = action.value;
          return { op: action.op, key: node.name, property: 'text', value: node.characters, id: node.id };
        });
      } else if (action.property === 'gap' && node.type === 'FRAME' && node.layoutMode !== 'NONE') {
        changes.push(() => {
          node.itemSpacing = action.value;
          return { op: action.op, key: node.name, property: 'gap', value: node.itemSpacing, id: node.id };
        });
      } else {
        throw new Error('Unexpected mutation property: ' + action.property);
      }
    }
  }
  const results = changes.map(change => change());
  return { document_id: figma.fileKey, actions: results.map(({ id, ...action }) => action),
    mutatedNativeIds: results.map(({ id }) => id) };
}
