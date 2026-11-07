(function(){
  const labels=OilTrackingModel.statuses;
  const order=['due','near','review','pending','normal'];
  const icons={due:'exclamation-octagon',near:'clock',review:'exclamation-triangle',pending:'clipboard-data',normal:'check-circle'};
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num=value=>value==null?'—':Number(value).toLocaleString('th-TH');
  const date=value=>{try{return value?new Intl.DateTimeFormat('th-TH',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'UTC'}).format(OilTrackingModel.date(value)):'—';}catch(_){return '—';}};
  let serial=0;
  async function load(force=false){
    const root=document.getElementById('dash-oil');if(!root)return;
    const request=++serial;
    if(!root.dataset.mounted){
      root.dataset.mounted='true';
      root.innerHTML=`<div class="card-header ot-dash-header"><div class="ot-dash-heading"><div class="card-icon"><i class="bi bi-droplet" aria-hidden="true"></i></div><span>เปลี่ยนถ่ายน้ำมันเครื่อง</span></div><div class="ot-actions"><button class="ot-button ot-icon" id="do-refresh" title="รีเฟรชข้อมูลเปลี่ยนถ่าย" aria-label="รีเฟรชข้อมูลเปลี่ยนถ่าย"><i class="bi bi-arrow-clockwise"></i></button><button class="ot-button ot-icon" data-oil-status="" title="ดูทั้งหมด" aria-label="ดูเปลี่ยนถ่ายทั้งหมด"><i class="bi bi-arrow-up-right" aria-hidden="true"></i></button></div></div>
        <div id="do-metrics" class="ot-dash-metrics"></div><div id="do-attention"></div>
        <div class="ot-dash-footer"><div id="do-message" aria-live="polite"></div><span class="ot-muted">วันครบกำหนดอิงวันที่ใบงาน</span></div>`;
      root.onclick=event=>{
        const button=event.target.closest('[data-oil-status]');
        if(button)OilTrackingLiveUI.open({status:button.dataset.oilStatus,plate:button.dataset.plate||''});
      };
      root.querySelector('#do-refresh').onclick=()=>load(true);
    }
    const $=id=>root.querySelector('#do-'+id);
    $('refresh').disabled=true;$('message').textContent='กำลังอ่านข้อมูลเปลี่ยนถ่าย...';
    $('metrics').innerHTML=order.map(key=>`<button class="ot-dash-metric" data-oil-status="${key}" disabled><span class="ot-status ${key}"><i class="bi bi-${icons[key]}" aria-hidden="true"></i> ${esc(labels[key])}</span><strong>—</strong></button>`).join('');
    $('attention').innerHTML='';
    try{
      const data=await OilTrackingData.read({force});if(request!==serial)return;
      const records=data.records;
      $('metrics').innerHTML=order.map(key=>`<button class="ot-dash-metric" data-oil-status="${key}"><span class="ot-status ${key}"><i class="bi bi-${icons[key]}" aria-hidden="true"></i> ${esc(labels[key])}</span><strong>${num(records.filter(r=>r.status===key).length)}</strong></button>`).join('');
      const rank={due:0,near:1,review:2};
      const important=records.filter(r=>Object.hasOwn(rank,r.status)).sort((a,b)=>rank[a.status]-rank[b.status]||(a.remainingDays??Infinity)-(b.remainingDays??Infinity)||(a.remainingKm??Infinity)-(b.remainingKm??Infinity)||a.vehicle.plate.localeCompare(b.vehicle.plate,'th'));
      const shown=important.slice(0,3);
      $('attention').innerHTML=shown.length?`<div class="ot-dash-list" role="list">${shown.map(r=>`<article class="ot-dash-row" role="listitem"><div><strong>${esc(r.vehicle.plate)}</strong><small class="ot-muted">ถัดไป ${esc(r.nextProgram||'รอตรวจสอบ')} · ${r.dueKm==null?'ยังไม่ระบุไมล์':num(r.dueKm)+' กม.'}</small><small class="ot-muted">${r.dueDate?'ครบ '+date(r.dueDate):esc(r.reason)}</small></div><div class="ot-dash-row-end"><span class="ot-status ${r.status}" title="${esc(r.reason)}">${esc(labels[r.status])}</span><button class="ot-button ot-icon" data-oil-status="${r.status}" data-plate="${esc(r.vehicle.plate)}" aria-label="ดู ${esc(r.vehicle.plate)}" title="ดูรายละเอียดรถ"><i class="bi bi-arrow-right"></i></button></div></article>`).join('')}</div>${important.length>3?`<button class="ot-dash-more" data-oil-status="">ดูรายการที่ควรติดตามทั้งหมด ${num(important.length)} คัน <i class="bi bi-chevron-right"></i></button>`:''}`:'<p class="ot-muted ot-dash-empty">ไม่พบรายการที่ต้องติดตามเพิ่มเติม</p>';
      $('message').textContent=`รถทั้งหมด ${num(records.length)} รายการ • อ่านข้อมูล ${new Intl.DateTimeFormat('th-TH',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Bangkok'}).format(new Date(data.fetchedAt))}`;
    }catch(error){
      if(request!==serial)return;
      $('metrics').querySelectorAll('button').forEach(button=>button.disabled=true);
      $('attention').innerHTML='';$('message').innerHTML=`<div class="ot-error" role="alert">${esc(error.message)} • ยังสรุปจำนวนรถไม่ได้ กรุณาลองรีเฟรช</div>`;
    }finally{if(request===serial)$('refresh').disabled=false;}
  }
  window.OilDashboard={load};
})();
