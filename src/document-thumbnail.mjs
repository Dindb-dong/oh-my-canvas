/** Best-effort library previews; never run an export as part of autosave. */
export function createThumbnailScheduler({current,save,delay=1200}){
  let timer,running,completed,queued=false;
  const same=(a,b)=>a&&b&&a.view===b.view&&a.id===b.id&&a.pageId===b.pageId&&a.objects===b.objects&&a.assets===b.assets;
  async function capture(){
    if(running){queued=true;return;}
    const state=current();
    if(!state||same(state,completed)||!state.view.thumbnailSnapshot)return;
    const controller=new AbortController();running={state,controller};
    try{
      const shot=await state.view.thumbnailSnapshot({signal:controller.signal}),latest=current();
      if(shot?.data&&!controller.signal.aborted&&same(state,latest)&&state.viewport===latest.viewport){
        await save(shot);completed=state;
      }
    }catch{/* Preserve the existing preview if the scene or a resource is unavailable. */}
    finally{running=undefined;if(queued){queued=false;schedule();}}
  }
  function schedule(){
    clearTimeout(timer);timer=undefined;
    const state=current();
    if(running){
      if(same(state,running.state)&&state.viewport===running.state.viewport)return;
      running.controller.abort();
    }
    if(!state||same(state,completed))return;
    timer=setTimeout(()=>{timer=undefined;void capture();},delay);
  }
  return {schedule,reset(){clearTimeout(timer);timer=undefined;running?.controller.abort();completed=undefined;queued=false;}};
}
