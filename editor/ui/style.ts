export const workspaceStyle = `
.lv-editor {
  --accent:#3977ec;
  --line:#e5e8ef;
  --muted:#7c8494;
  --ink:#252b37;
  --surface:#fff;
  position:relative;
  display:grid;
  grid-template-columns:240px minmax(0,1fr) 280px;
  grid-template-rows:48px minmax(0,1fr) 52px;
  width:100%;
  height:100%;
  min-height:250px;
  background:#f2f4f9;
  color:var(--ink);
  font:12px 'IBM Plex Sans',-apple-system,sans-serif;
  overflow:hidden;
}
.lv-editor * {
  box-sizing:border-box;
}
.lv-editor button,.omc-dialog button {
  font:inherit;
  cursor:pointer;
  border:0;
  background:transparent;
  color:inherit;
  border-radius:5px;
  min-height:28px;
  padding:5px 8px;
}
.lv-editor button:hover,.omc-dialog button:hover {
  background:#eef2fa;
}
.lv-editor button:focus-visible,.lv-editor input:focus-visible,.lv-editor select:focus-visible {
  outline:2px solid var(--accent);
  outline-offset:1px;
}
.lv-editor button.active,.lv-editor button[aria-pressed=true] {
  background:#e7efff;
  color:#2861d0;
}
.lv-editor button:disabled {
  opacity:.35;
  cursor:default;
}
.workspace-header {
  grid-column:1/-1;
  display:flex;
  align-items:center;
  padding:0 12px;
  gap:10px;
  background:#fff;
  border-bottom:1px solid var(--line);
  z-index:6;
}
.file-name {
  display:flex;
  gap:10px;
  align-items:center;
  min-width:0;
  flex:1;
}
.file-name b {
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
  font-weight:600;
}
.file-name small {
  color:var(--muted);
  flex:none;
  white-space:nowrap;
}
#left {
  grid-column:1;
  grid-row:2/4;
  overflow:auto;
  background:#fff;
  border-right:1px solid var(--line);
  z-index:5;
}
#right {
  grid-column:3;
  grid-row:2/4;
  overflow:auto;
  background:#fff;
  border-left:1px solid var(--line);
  z-index:5;
}
.ltabs {
  display:flex;
  border-bottom:1px solid var(--line);
  padding:8px;
  gap:5px;
  position:sticky;
  top:0;
  background:#fff;
  z-index:1;
}
.ltabs button {
  flex:1;
}
.pages {
  padding:12px 8px;
  border-bottom:1px solid var(--line);
}
.panel-heading {
  display:flex;
  align-items:center;
  justify-content:space-between;
  font-weight:600;
  padding:4px 8px;
}
.page-row,.row {
  display:flex;
  align-items:center;
  gap:5px;
  min-height:31px;
  padding:3px 8px;
  user-select:none;
}
.page-row.active,.row.selected {
  background:#e8efff;
}
.row:hover,.page-row:hover {
  background:#f0f4fc;
}
.row.selected,.row.selected:hover {
  background:#eff6ff;
  color:#1e40af;
}
.layers .row {
  position:relative;
}
.layers .row[hidden] {
  display:none;
}
.row[data-drop=before]::before,.row[data-drop=after]::after {
  content:"";
  position:absolute;
  left:0;
  right:0;
  height:2px;
  background:var(--accent);
  z-index:1;
  pointer-events:none;
}
.row[data-drop=before]::before { top:0; }
.row[data-drop=after]::after { bottom:0; }
.row[data-drop=inside] {
  outline:2px solid var(--accent);
  outline-offset:-2px;
  background:#eff6ff;
}
.row .name,.page-row .name {
  flex:1;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.row .name[contenteditable=true] {
  outline:1px solid var(--accent);
  background:white;
  user-select:text;
}
.row[aria-disabled=true] {
  color:#979daa;
}
.row button {
  padding:2px;
  min-width:21px;
  min-height:22px;
}
.row .type-icon {
  color:#9098aa;
  width:15px;
  text-align:center;
}
.layers {
  padding:7px 0;
}
.assets {
  padding:8px;
}
.assets-search {
  width:100%;
  padding:8px;
  border:1px solid var(--line);
  border-radius:5px;
  margin-bottom:12px;
}
.asset-heading {
  font-weight:600;
  color:var(--muted);
  padding:12px 5px 5px;
}
.asset-grid {
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:7px;
}
.atile {
  display:flex;
  flex-direction:column;
  align-items:start;
  gap:8px;
  min-width:0;
  text-align:left;
  border:1px solid var(--line)!important;
  padding:10px!important;
}
.atile-preview {
  height:54px;
  width:100%;
  display:grid;
  place-items:center;
  background:#f4f3fc;
  color:#8a74bf;
  font-size:23px;
}
.atile-label {
  white-space:normal;
  min-width:0;
  max-width:100%;
  display:-webkit-box;
  -webkit-box-orient:vertical;
  -webkit-line-clamp:2;
  overflow:hidden;
  overflow-wrap:anywhere;
  width:100%;
  line-height:1.35;
}
.atile small {
  max-width:100%;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.atile-preview {
  overflow:hidden;
}
.atile-preview img {
  display:block;
  width:100%;
  height:100%;
  object-fit:contain;
}
.design>section {
  padding:14px 12px;
  border-bottom:1px solid var(--line);
}
.design h3 {
  font-size:12px;
  margin:0 0 12px;
  font-weight:600;
  display:flex;
  align-items:center;
  justify-content:space-between;
}
.fields {
  display:flex;
  gap:7px;
  align-items:center;
  margin:7px 0;
}
.field {
  margin:0;
  font-weight:400;
  display:flex;
  align-items:center;
  gap:6px;
  min-width:0;
  flex:1;
  background:#f5f6f9;
  border-radius:4px;
  padding:5px 7px;
}
.field-label {
  font-size:11px;
  color:#747d8f;
  white-space:nowrap;
}
.field input,.field select {
  padding:0;
  margin:0;
  border-radius:0;
  background:transparent;
  border:0;
  min-width:0;
  width:100%;
  font:inherit;
  outline:none;
  color:inherit;
}
.field input[type=color] {
  height:22px;
  padding:0;
  min-width:28px;
}
.field input[type=number] {
  -moz-appearance:textfield;
}
.check {
  display:flex;
  align-items:center;
  gap:6px;
  margin:8px 0;
}
.check input {
  accent-color:var(--accent);
}
.inspector-actions {
  display:flex;
  flex-wrap:wrap;
  gap:4px;
}
.paint-row,.effect-row,.export-row {
  border:1px solid var(--line);
  border-radius:5px;
  padding:5px;
  margin:7px 0;
}
.paint-row header,.effect-row header {
  display:flex;
  justify-content:space-between;
}
.muted {
  color:var(--muted);
}
.empty-state {
  padding:24px 14px;
  line-height:1.7;
  color:var(--muted);
}
#stage {
  position:relative;
  grid-column:2;
  grid-row:2;
  background:#f2f4f9;
  overflow:hidden;
  touch-action:none;
  outline:0;
}
#overlay {
  position:absolute;
  inset:0;
  z-index:20;
  pointer-events:none;
  overflow:hidden;
}
#tools {
  grid-column:2;
  grid-row:3;
  display:flex;
  justify-content:center;
  align-items:center;
  gap:3px;
  background:#fff;
  border-top:1px solid var(--line);
  z-index:6;
}
.tool-group {
  display:flex;
  align-items:center;
  border-right:1px solid var(--line);
  padding-right:5px;
  margin-right:2px;
}
#tools button[data-tool] {
  width:33px;
  height:33px;
  font-size:17px;
  position:relative;
}
#tools button[data-tool] small {
  position:absolute;
  bottom:1px;
  right:3px;
  font-size:8px;
  color:var(--muted);
}
.zoom-control {
  display:flex;
  align-items:center;
  gap:3px;
}
.zoom-control select {
  border:0;
  background:transparent;
  font:inherit;
  width:66px;
}
.selection-outline {
  position:absolute;
  border:0;
  outline:1px solid #3977ec;
  pointer-events:none;
  transform-origin:center;
}
.selection-label {
  position:absolute;
  left:0;
  top:-19px;
  background:#3977ec;
  color:#fff;
  font-size:10px;
  padding:1px 4px;
  white-space:nowrap;
}
.transform-handle {
  position:absolute;
  width:8px;
  height:8px;
  border:1px solid #3977ec;
  background:white;
  pointer-events:auto;
  transform:translate(-50%,-50%);
}
.rotate-handle {
  border-radius:50%;
  cursor:crosshair;
}
.marquee {
  position:absolute;
  background:#3977ec16;
  border:1px solid #3977ec;
}
.guide-line {
  position:absolute;
  background:#f28cba;
  pointer-events:auto;
}
.snap-line {
  position:absolute;
  background:#ee64b0;
  pointer-events:none;
}
.agent-outline {
  position:absolute;
  border:2px solid #9e6ac9;
  pointer-events:none;
}
.path-node {
  position:absolute;
  width:9px;
  height:9px;
  background:white;
  border:1px solid #3977ec;
  transform:translate(-50%,-50%);
  pointer-events:auto;
  cursor:move;
}
.path-node.selected {
  background:#3977ec;
}
.path-control {
  border-radius:50%;
  width:7px;
  height:7px;
}
.path-line {
  position:absolute;
  height:1px;
  background:#7da1e5;
  transform-origin:left;
}
.gradient-handle {
  position:absolute;
  width:12px;
  height:12px;
  border:2px solid white;
  outline:1px solid #3977ec;
  border-radius:50%;
  background:#3977ec;
  transform:translate(-50%,-50%);
  pointer-events:auto;
}
.ruler {
  position:absolute;
  z-index:2;
  background:#ffffffdd;
  color:#949aa8;
  font:9px monospace;
  pointer-events:auto;
}
.ruler.horizontal {
  height:18px;
  left:18px;
  right:0;
  top:0;
}
.ruler.vertical {
  width:18px;
  top:18px;
  bottom:0;
  left:0;
}
.ruler-tick {
  position:absolute;
  white-space:nowrap;
}
.context-menu {
  position:fixed;
  z-index:10010;
  min-width:220px;
  max-height:70vh;
  overflow:auto;
  padding:5px;
  background:white;
  border:1px solid #e1e4ec;
  box-shadow:0 8px 30px #1d2d4a25;
  border-radius:7px;
  font:12px 'IBM Plex Sans',sans-serif;
}
.context-menu button {
  display:flex;
  width:100%;
  justify-content:space-between;
  border:0;
  background:transparent;
  text-align:left;
  padding:7px;
  border-radius:4px;
  color:#252b37;
}
.context-menu button:hover {
  background:#edf2fc;
}
.context-menu hr {
  border:0;
  border-top:1px solid #edf0f5;
}
.context-menu kbd {
  color:#9299a8;
  margin-left:auto;
  padding-left:20px;
  font:10px monospace;
}
.find-bar {
  position:absolute;
  right:16px;
  top:12px;
  z-index:40;
  display:flex;
  gap:6px;
  padding:6px;
  background:white;
  border:1px solid var(--line);
  border-radius:6px;
  box-shadow:0 4px 15px #24344a18;
}
.find-bar input {
  width:180px;
  border:0;
  outline:0;
  font:inherit;
}
.find-bar button {
  padding:3px;
}
.omc-dialog {
  border:1px solid #dfe4ed;
  border-radius:10px;
  padding:0;
  box-shadow:0 24px 100px #13213d35;
  width:min(520px,90vw);
  max-height:85vh;
  color:#252b37;
  font:13px 'IBM Plex Sans',-apple-system,sans-serif;
}
.omc-dialog::backdrop {
  background:#1b254b35;
}
.omc-dialog>header {
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:14px 18px;
  border-bottom:1px solid #e7eaf0;
}
.omc-dialog h2 {
  font-size:15px;
  margin:0;
}
.dialog-body {
  padding:16px;
  overflow:auto;
  max-height:70vh;
}
.dialog-body .field {
  margin:8px 0;
}
.omc-dialog .primary {
  background:#3977ec;
  color:white;
  padding:8px 14px;
}
.json-editor {
  width:100%;
  min-height:300px;
  font:12px monospace;
  border:1px solid #e1e5ed;
  padding:10px;
}
.field-error {
  color:#bd3656;
  font-size:12px;
}
.command-results {
  max-height:50vh;
  overflow:auto;
}
.command-results button {
  display:flex;
  width:100%;
  justify-content:space-between;
  text-align:left;
  padding:9px;
}
.font-results {
  display:grid;
  gap:4px;
  max-height:50vh;
  overflow:auto;
}
.font-results button {
  text-align:left;
  font-size:18px;
  padding:8px;
}
.omc-toast {
  position:fixed;
  bottom:24px;
  left:50%;
  transform:translateX(-50%);
  z-index:20000;
  background:#26334d;
  color:white;
  box-shadow:0 5px 20px #15203b25;
  border-radius:7px;
  padding:11px 18px;
  font:13px sans-serif;
  max-width:min(600px,90vw);
}
.text-edit-host {
  position:absolute;
  z-index:35;
  transform-origin:top left;
  pointer-events:auto;
}
.text-edit-surface {
  min-height:1em;
  outline:1px solid #3977ec;
  white-space:pre-wrap;
  overflow-wrap:anywhere;
  word-break:normal;
  caret-color:#3977ec;
  margin:0;
  padding:0;
  border:0;
  background:transparent;
}
.text-edit-host textarea {
  position:absolute;
  opacity:0;
  width:1px;
  height:1px;
  pointer-events:none;
}
.mobile-controls {
  display:none;
}
.lv-editor.collapsed {
  grid-template-columns:0 minmax(0,1fr) 280px;
}
.lv-editor.collapsed #left {
  visibility:hidden;
}
.lv-editor.ui-hidden {
  grid-template-columns:0 1fr 0;
  grid-template-rows:0 1fr 0;
}
.lv-editor.ui-hidden #left,.lv-editor.ui-hidden #right,.lv-editor.ui-hidden #tools,.lv-editor.ui-hidden>.workspace-header {
  visibility:hidden;
}
@media(max-width:900px) {
  .lv-editor {
    grid-template-columns:200px minmax(0,1fr) 240px;
  }
  .lv-editor.collapsed {
    grid-template-columns:0 minmax(0,1fr) 240px;
  }
  .field {
    padding:4px;
  }
  .file-name small {
    display:none;
  }
}
@media(max-width:700px) {
  .lv-editor,.lv-editor.collapsed {
    grid-template-columns:0 minmax(0,1fr) 0;
    grid-template-rows:44px minmax(0,1fr) 95px;
  }
  #left,#right {
    display:none;
  }
  .lv-editor #tools {
    flex-wrap:wrap;
    padding:5px 35px;
    align-content:center;
    gap:0;
  }
  .lv-editor #tools button[data-tool] {
    width:31px;
  }
  .workspace-header {
    padding:0 6px;
    gap:3px;
  }
  .workspace-header .desktop-only {
    display:none;
  }
  .mobile-controls {
    display:flex;
    position:absolute;
    bottom:6px;
    left:0;
    right:0;
    justify-content:space-between;
    padding:0 8px;
    pointer-events:none;
    z-index:8;
  }
  .mobile-controls button {
    pointer-events:auto;
  }
  .lv-editor.mobile-left #left,.lv-editor.mobile-right #right {
    display:block;
    position:absolute;
    top:44px;
    bottom:95px;
    width:min(320px,85%);
    box-shadow:0 4px 30px #1e305028;
    z-index:50;
    visibility:visible;
  }
  .lv-editor.mobile-right #right {
    right:0;
  }
  .find-bar {
    left:7px;
    right:7px;
  }
  .find-bar input {
    min-width:0;
    flex:1;
  }
  .omc-dialog {
    width:95vw;
  }
  .fields {
    gap:4px;
  }
}
@media(prefers-reduced-motion:reduce) {
  .lv-editor * {
    scroll-behavior:auto;
  }
}
#tools .tool-group[data-group="2"] [data-tool]:not(.remembered),#tools .tool-group[data-group="3"] [data-tool]:not(.remembered) {
  display:none;
}
.find-bar {
  display:block;
  width:350px;
  max-width:calc(100% - 24px);
}
.find-bar .fields {
  margin:2px 0;
}
.find-bar .check {
  margin:3px 0;
}
.find-bar input {
  width:100%;
  min-width:0;
  flex:1;
  padding:5px;
}
.layer-filter {
  padding:8px;
}
.layer-filter input {
  margin:0;
}
.field-label {
  user-select:none;
}
.field:has(input[type=number]) .field-label {
  cursor:ew-resize;
}
@media(max-width:700px) {
  .lv-editor,.lv-editor.collapsed {
    grid-template-rows:44px minmax(0,1fr) 110px;
  }
  .lv-editor #tools {
    padding:5px 30px 37px;
  }
  .mobile-controls {
    gap:1px;
    flex-wrap:wrap;
    justify-content:center;
    bottom:4px;
    padding:0 3px;
  }
  .mobile-controls button {
    font-size:10px;
    padding:3px 5px;
    min-height:24px;
  }
  .lv-editor.mobile-left #left,.lv-editor.mobile-right #right {
    top:auto;
    left:0;
    right:0;
    bottom:110px;
    height:min(65vh,600px);
    width:100%;
    border-top:1px solid #dfe5ef;
    border-radius:10px 10px 0 0;
  }
  .find-bar {
    width:auto;
    max-width:none;
  }
  .workspace-header .zoom-control button {
    display:none;
  }
}

/* The glyph is decorative; button title/aria-label and state remain authoritative. */
.ui-icon { display:inline-block; width:18px; height:18px; flex:none; vertical-align:middle; pointer-events:none; }
.icon-button { display:inline-flex; align-items:center; justify-content:center; gap:5px; min-width:28px; min-height:28px; padding:5px!important; }
.has-icon { display:inline-flex; align-items:center; justify-content:center; gap:6px; }
#tools .ui-icon { width:20px; height:20px; }
#tools button { display:inline-flex; align-items:center; justify-content:center; }
#tools small { line-height:1; }
.type-icon { display:inline-flex; align-items:center; justify-content:center; flex:none; width:18px; }
.type-icon .ui-icon { width:15px; height:15px; color:#8490a5; }
.disclosure-placeholder { visibility:hidden; pointer-events:none; }
.context-menu button { display:flex; align-items:center; justify-content:flex-start; gap:9px; }
.context-menu .menu-label { min-width:0; text-align:left; }
.inspector-actions .icon-button { flex:1; }
`;
