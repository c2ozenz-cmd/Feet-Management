const crypto=require('crypto');
const {seed}=require('../../public/oil-tracking-demo-store');
const M=require('../../public/oil-tracking-model');
function createMockData(asOf=M.today()) {
  const state=seed(asOf),ids=new Map(state.vehicles.map(v=>[v.id,crypto.randomUUID()]));
  state.vehicles=state.vehicles.map(v=>({...v,id:ids.get(v.id)}));
  for(const kind of ['services','readings'])state[kind]=state[kind].map(e=>({...e,id:crypto.randomUUID(),vehicleId:ids.get(e.vehicleId),sequence:0}));
  return {state,ids};
}
module.exports={createMockData};
