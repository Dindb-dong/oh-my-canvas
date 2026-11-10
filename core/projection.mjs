import {applyPending,projectChanges,same} from './document.mjs';

/** Renderer-side revision contract. Accepted writes are already in the server
 * projection; durable ACKs retire them only after fsync. Missing revisions
 * request a full snapshot instead of guessing against an implicit asset cache. */
export class DocumentProjection {
  constructor(snapshot){
    this.id=snapshot.id;this.generation=snapshot.generation;this.pending=[];
    this.document=snapshot.document;this.revision=snapshot.revision??0;
    this.ack=snapshot.ack??0;this.accepted=snapshot.acceptedSeq??this.ack;
  }
  enqueue(item){
    if(!Number.isSafeInteger(item.seq)||item.seq<=this.ack||this.pending.some(p=>p.seq===item.seq))throw Error('Invalid pending edit sequence');
    this.pending.push(item);
  }
  reject(seq){this.pending=this.pending.filter(p=>p.seq!==seq);}
  get projected(){return applyPending(this.document,this.pending.filter(p=>p.seq>this.accepted).map(p=>p.changes));}
  accept(message){
    if(message.id!==this.id||message.generation!==this.generation)return {ignored:true};
    const revision=message.revision??0;
    if(!Number.isSafeInteger(revision)||revision<0)throw Error('Invalid document revision');
    const ack=message.ack??this.ack,accepted=message.acceptedSeq??ack;
    if(!Number.isSafeInteger(ack)||ack<0||!Number.isSafeInteger(accepted)||accepted<ack)throw Error('Invalid document acknowledgment');
    const own=this.pending.find(p=>p.seq===message.originSequence);
    let redundant=false,document=this.document,nextRevision=this.revision;
    if(message.document){
      if(revision<this.revision)return {ignored:true};
      document=message.document;nextRevision=revision;
    }else if(message.type==='document-delta'){
      if(revision>this.revision){
        if(message.fromRevision!==this.revision)return {resync:true};
        document=projectChanges(this.document,message.changes);nextRevision=revision;
        redundant=!!own&&same(own.changes,message.changes);
      }else redundant=true;
    }else if(revision>this.revision)return {resync:true};
    else redundant=true;
    const nextAck=Math.max(this.ack,ack),nextAccepted=Math.max(this.accepted,accepted);
    const pending=this.pending.filter(p=>p.seq>nextAck);
    // Construct the entire rebased projection before publishing any counters or
    // document. A malformed delta/ACK must leave retry and resync state intact.
    const projected=applyPending(document,pending.filter(p=>p.seq>nextAccepted).map(p=>p.changes));
    this.document=document;this.revision=nextRevision;this.ack=nextAck;this.accepted=nextAccepted;this.pending=pending;
    return {document:projected,redundant,revision:this.revision,ack:this.ack};
  }
}
