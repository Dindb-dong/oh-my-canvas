import { svgIcon } from '../editor/ui/icons/tabler/runtime.js';
const names = {
  clock: 'clock', search: 'search', star: 'star', grid: 'layout-grid', list: 'list',
  file: 'file', more: 'dots', plus: 'plus', panel: 'layout-sidebar',
  components: 'components', external: 'external-link', download: 'download', upload: 'upload',
  close: 'x', minimize: 'arrows-minimize', maximize: 'arrows-maximize'
};
export const icon = name => svgIcon(names[name] ?? name);
