const {OilError}=require('./oil-tracking-service');
// A supplied RPC client only. Nothing in the app instantiates this adapter yet.
function createRpcRepository(client,{mode}={}) {
  if(!['staging','production','mock-rpc'].includes(mode))throw new Error('Explicit repository mode required');
  async function rpc(name,args={}){
    const {data,error}=await client.rpc(name,args);
    if(error)throw new Error('Oil tracking repository unavailable');
    if(data?.code==='REVISION_CONFLICT')throw new OilError(409,'ข้อมูลถูกแก้ไขแล้ว กรุณารีเฟรชก่อนบันทึก');
    if(data?.code==='REQUEST_CONFLICT')throw new OilError(409,'requestId นี้ถูกใช้กับข้อมูลอื่นแล้ว');
    if(data?.code==='FORBIDDEN')throw new OilError(403,'ไม่มีสิทธิ์บันทึก');
    if(data?.code)throw new Error('Oil tracking transaction rejected');
    return data;
  }
  return {
    mode,persisted:mode!=='mock-rpc',
    read:()=>rpc('fleet_oil_snapshot'),
    lookupRequest:(actorId,requestId)=>rpc('fleet_oil_request',{p_actor_id:actorId,p_request_id:requestId}),
    commit:input=>rpc('fleet_oil_commit',{p_expected_revision:input.expectedRevision,p_request_id:input.requestId,p_actor_id:input.actorId,p_hash:input.hash,p_command:input.command})
  };
}
module.exports={createRpcRepository};
