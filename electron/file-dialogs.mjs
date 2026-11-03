import fs from 'node:fs/promises';
import path from 'node:path';

// Parent-attached macOS sheets disable and dim the canvas, including across a
// renderer reload. Keep pickers owned by the main process and application-modal.
export function createFileDialogs(dialog) {
  let pending = false;
  async function choose(method, options) {
    if (pending) throw Error('Finish or cancel the open file dialog first');
    pending = true;
    try { return await dialog[method](options); }
    finally { pending = false; }
  }
  return {
    open: options => choose('showOpenDialog', options),
    save: options => choose('showSaveDialog', options),
    async pick({kind, multiple = false} = {}) {
      const formats = {image:['png','jpg','jpeg','gif','webp','avif','bmp','svg','ico'], library:['json'], assets:['png','jpg','jpeg','gif','webp','avif','bmp','svg','ico','woff','woff2','ttf','otf','json']};
      if (!Object.hasOwn(formats, kind) || typeof multiple !== 'boolean') throw Error('Unsupported file picker');
      const result = await choose('showOpenDialog', {title:kind === 'library' ? 'Import library' : 'Choose assets', filters:[{name:kind === 'library' ? 'Component library' : 'Design assets', extensions:formats[kind]}], properties:multiple ? ['openFile','multiSelections'] : ['openFile']});
      if (result.canceled) return [];
      if (result.filePaths.length > (multiple ? 50 : 1)) throw Error('Select at most 50 assets');
      let total = 0;
      const files = [];
      for (const file of result.filePaths) {
        if (!formats[kind].includes(path.extname(file).slice(1).toLowerCase())) throw Error('Unsupported asset format');
        const stat = await fs.stat(file);
        total += stat.size;
        if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || total > 128 * 1024 * 1024) throw Error('Assets exceed the size limit (32 MiB per file, 128 MiB total)');
        const bytes = await fs.readFile(file);
        if (bytes.length !== stat.size) throw Error('Asset changed while reading. Please select it again.');
        files.push({name:path.basename(file), bytes});
      }
      return files;
    }
  };
}
