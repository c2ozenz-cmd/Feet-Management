/* Session-scoped, in-memory read cache shared by dashboard and vehicle tracking. */
(function(){
  let cached=null,pending=null;
  function token(){return window.appSessionToken||sessionStorage.getItem('appSessionToken')||'';}
  async function read({force=false}={}){
    const key=token(),day=OilTrackingModel.today();
    if(pending?.key===key)return pending.promise;
    if(!force&&cached?.key===key&&cached.day===day&&Date.now()-cached.time<60000)return cached.data;
    const request={key};
    request.promise=(async()=>{
      try{
        const response=await fetch('/.netlify/functions/oil-current-mileage',{headers:{Authorization:'Bearer '+key},cache:'no-store'});
        const data=await response.json();
        if(!response.ok||!data.success||!['local-read-only','read-only'].includes(data.mode)||!Array.isArray(data.records))throw new Error(data.message||'อ่านข้อมูลเปลี่ยนถ่ายไม่สำเร็จ');
        if(token()!==key)throw new Error('บัญชีผู้ใช้เปลี่ยน กรุณาอ่านข้อมูลใหม่');
        cached={key,day,time:Date.now(),data};return data;
      }catch(error){if(cached?.key===key)cached=null;throw error;}
      finally{if(pending===request)pending=null;}
    })();
    pending=request;return request.promise;
  }
  window.OilTrackingData={read};
})();
