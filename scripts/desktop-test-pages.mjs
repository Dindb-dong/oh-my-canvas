import assert from 'node:assert/strict';

const observed=new WeakSet();

export async function documentPage(app, documentId) {
  const shell=await app.firstWindow(),deadline=Date.now()+120000;
  while(Date.now()<deadline){
    const state=await shell.evaluate(()=>window.omc.invoke('workspace'));
    const id=documentId??state.activeTabId,tab=state.tabs.find(tab=>tab.id===id);
    const page=tab&&app.context().pages().find(page=>{
      const url=new URL(page.url());
      return url.pathname==='/document.html'&&url.searchParams.get('documentId')===id&&Number(url.searchParams.get('generation'))===tab.generation;
    });
    if(page){if(!observed.has(page)){observed.add(page);page.on('pageerror',error=>shell.emit('pageerror',error));page.on('console',message=>shell.emit('console',message));}await page.waitForFunction(()=>!!window.lvMcp&&!document.querySelector('#editor')?.inert,null,{timeout:120000});return page;}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw Error(`Document runtime did not become ready: ${documentId??'active tab'}`);
}

export async function libraryPage(app,{closeTabs=false}={}) {
  const shell=await app.firstWindow();
  if(closeTabs){const state=await shell.evaluate(()=>window.omc.invoke('workspace'));for(const tab of state.tabs)await shell.evaluate(id=>window.omc.invoke('close-document',{id}),tab.id);}
  await shell.evaluate(()=>window.omc.invoke('show-library'));
  await shell.locator('#import').waitFor();return shell;
}

export async function requireDocumentTarget(client) {
  const id=process.env.OMC_DOCUMENT_ID;
  assert.ok(id,'Set OMC_DOCUMENT_ID to the exact canvas ID before running an installed-app authoring helper.');
  const opened=await client.callTool({name:'open_document',arguments:{id,focus:false}});
  assert.ok(!opened.isError,JSON.stringify(opened));return id;
}
