const M=require('../../public/oil-tracking-model');
const S=require('./oil-tracking-service');
function createMemoryRepository(initial, {failAudit=()=>false}={}) {
  let state=M.clone(S.validateSnapshot(initial)), requests=new Map(), queue=Promise.resolve();
  return {
    mode:'local-api-mock',persisted:false,
    async read(){return M.clone(state);},
    async lookupRequest(actorId,requestId){const item=requests.get(JSON.stringify([actorId,requestId]));return item?M.clone(item):null;},
    async commit(input){
      const run=queue.then(()=>{
        const key=JSON.stringify([input.actorId,input.requestId]),prior=requests.get(key);
        if(prior){if(prior.hash!==input.hash)S.fail(409,'requestId นี้ถูกใช้กับข้อมูลอื่นแล้ว');return {result:M.clone(prior.result),replayed:true};}
        if(input.expectedRevision!==state.revision)S.fail(409,'ข้อมูลถูกแก้ไขพร้อมกัน กรุณารีเฟรชก่อนบันทึก');
        const next=S.apply(state,input.command);
        if(failAudit(input.command.audit))throw new Error('Simulated audit write failure');
        const result=M.clone(input.command.result);
        // Publish state, audit and idempotency receipt together after all validation succeeds.
        state=next;requests.set(key,{hash:input.hash,result});
        return {result,replayed:false};
      });
      queue=run.catch(()=>{});
      return run;
    }
  };
}
module.exports={createMemoryRepository};
