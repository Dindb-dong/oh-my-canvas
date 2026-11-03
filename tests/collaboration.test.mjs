import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {WebSocket} from 'ws';
import {Collaboration,parseInvite} from '../core/collaboration.mjs';import {Replica} from '../core/replica.mjs';import {changesBetween} from '../core/document.mjs';import {documentFixture,waitFor} from './helpers.mjs';
test('TLS collaboration authenticates, caps at four, merges, shares presence and reconnects offline edits',async t=>{
  const id=randomUUID(),hostReplica=new Replica({document:documentFixture()}),host=new Collaboration({replica:hostReplica,id,title:'Test',name:'Host'});const sessions=[host],replicas=[hostReplica];
  t.after(async()=>{await Promise.all(sessions.map(s=>s.close()));replicas.forEach(r=>r.destroy());});
  await host.host({bind:'127.0.0.1'});const invite=host.invite('127.0.0.1'),parsed=parseInvite(invite);
  assert.equal(parsed.room,id);assert.throws(()=>parseInvite('https://example.com'));
  const guests=[];
  for(let i=0;i<3;i++){const replica=new Replica(),guest=new Collaboration({replica,id,title:'Test',name:'Guest '+i});replicas.push(replica);sessions.push(guest);guests.push(guest);await guest.join(invite);}
  await waitFor(()=>host.clients.size===3&&guests.every(g=>g.status().peers.length===4));
  const extraReplica=new Replica(),extra=new Collaboration({replica:extraReplica,id,title:'Extra'});sessions.push(extra);replicas.push(extraReplica);await assert.rejects(extra.join(invite));await extra.close();
  const before=guests[1].replica.document,after=structuredClone(before);after.pagesById.page.objects.label.text='Team edit';guests[1].replica.patch(changesBetween(before,after));await waitFor(()=>replicas.slice(0,4).every(r=>r.document.pagesById.page.objects.label.text==='Team edit'));
  let cursor;guests[2].on('cursor',c=>{cursor=c;});guests[0].cursor({x:10,y:20,page:'page',selection:['label']});await waitFor(()=>cursor?.cursor?.x===10);
  const guest=guests[0];guest.socket.terminate();await waitFor(()=>!guest.connected);const offline=structuredClone(guest.replica.document);offline.pagesById.page.objects.label.name='Offline change';guest.replica.patch(changesBetween(guest.replica.document,offline));await waitFor(()=>guest.connected,7000);await waitFor(()=>hostReplica.document.pagesById.page.objects.label.name==='Offline change');
  assert.deepEqual(guest.replica.document,hostReplica.document);
});
test('wrong secret and browser Origin are refused before websocket upgrade',async t=>{
  const r=new Replica({document:documentFixture()}),c=new Collaboration({replica:r,id:randomUUID(),title:'Private'});t.after(async()=>{await c.close();r.destroy();});await c.host({bind:'127.0.0.1'});const d=parseInvite(c.invite('127.0.0.1'));
  for(const headers of [{Authorization:'Bearer bad'},{Authorization:`Bearer ${d.token}`,Origin:'https://evil.example'}]){
    await new Promise((resolve,reject)=>{const w=new WebSocket(d.url,{ca:d.cert,rejectUnauthorized:true,checkServerIdentity:()=>undefined,headers});w.on('open',()=>{w.terminate();reject(Error('Unauthorized client connected'));});w.on('error',()=>resolve());});
  }
});
test('old collaboration schemas are refused before document exchange',async t=>{
 const replica=new Replica({document:documentFixture()}),host=new Collaboration({replica,id:randomUUID(),title:'Schema'});t.after(async()=>{await host.close();replica.destroy();});await host.host({bind:'127.0.0.1'});const d=parseInvite(host.invite('127.0.0.1'));
 assert.equal(d.v,2);assert.throws(()=>parseInvite('omc://join/'+Buffer.from(JSON.stringify({...d,v:1})).toString('base64url')),/Update Oh My Canvas/);
 const state=Buffer.from(replica.state);let welcomed=false;
 await new Promise((resolve,reject)=>{const w=new WebSocket(d.url,{ca:d.cert,rejectUnauthorized:true,checkServerIdentity:()=>undefined,headers:{Authorization:`Bearer ${d.token}`}});w.on('open',()=>w.send(JSON.stringify({type:'hello',room:d.room,id:randomUUID(),name:'Old client'})));w.on('message',raw=>{if(JSON.parse(raw).type==='welcome')welcomed=true;});w.on('close',resolve);w.on('error',reject);});assert.equal(welcomed,false);assert.deepEqual(Buffer.from(replica.state),state);
});
