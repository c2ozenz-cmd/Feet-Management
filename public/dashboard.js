(function(){
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num=value=>Number(value||0).toLocaleString('th-TH');
  const date=value=>{try{return new Intl.DateTimeFormat('th-TH',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'UTC'}).format(OilTrackingModel.date(String(value).slice(0,10)));}catch(_){return '—';}};
  const $=id=>document.getElementById(id);
  let serial=0,pendingNav=null;
  const read=method=>new Promise((resolve,reject)=>google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[method]());
  function button(page,search,status='',label='ดูรายละเอียด'){return `<button class="dash-icon-button" data-dash-page="${page}" data-search="${esc(search)}" data-status="${esc(status)}" aria-label="${esc(label)}" title="${esc(label)}"><i class="bi bi-arrow-right"></i></button>`;}
  const empty=text=>`<div class="dash-empty">${esc(text)}</div>`;
  const error=text=>`<div class="dash-error" role="alert">${esc(text)} • กดรีเฟรชเพื่อลองใหม่</div>`;
  function open({page,search='',status=''}){
    pendingNav={page,search,status,created:Date.now()};navigateTo(page);
  }
  function consume(page){
    if(!pendingNav||pendingNav.page!==page)return false;
    const request=pendingNav;pendingNav=null;
    if(currentPageName!==page||Date.now()-request.created>10000)return false;
    const prefix={repairs:'repair',po:'po',stock:'stock',buses:'bus'}[page];
    const search=$(prefix+'Search');if(search)search.value=request.search;
    if(page!=='buses')setSelectValue(prefix+'StatusFilter',request.status);
    const month=$(prefix+'MonthFilter');if(month)month.value='';
    return true;
  }
  async function load(force=false){
    const root=$('dashboard-workspace');if(!root)return;
    const request=++serial;
    if(!root.dataset.events){
      root.dataset.events='true';
      root.onclick=event=>{
        const oil=event.target.closest('[data-dash-oil]');if(oil){OilTrackingLiveUI.open({status:oil.dataset.dashOil});return;}
        const item=event.target.closest('[data-dash-page]');if(item)open({page:item.dataset.dashPage,search:item.dataset.search||'',status:item.dataset.status||''});
      };
    }
    $('dashDatetime').textContent=new Intl.DateTimeFormat('th-TH',{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'Asia/Bangkok'}).format(new Date());
    $('dashRefresh').disabled=true;$('dashUpdated').textContent='กำลังอ่านข้อมูล...';
    for(const id of ['dashRepairMetric','dashPOMetric','dashStockMetric','dashOilMetric'])$(id).disabled=true;
    for(const id of ['dashPendingTotal','dashPOPending','dashStockOut','dashOilDue'])$(id).textContent='—';
    const tasks=[];
    function task(method,render,failed){tasks.push(read(method).then(data=>{if(request===serial)render(data||[]);}).catch(()=>{if(request===serial)failed();}));}
    task('getRepairs',repairs=>{
      allRepairs=repairs;
      const pending=repairs.filter(r=>r.status!=='เสร็จแล้ว');
      $('dashPendingTotal').textContent=num(pending.length);$('dashPendingCount').textContent=num(pending.length);$('dashRepairMetric').disabled=false;
      for(const [id,status]of [['dashWaiting','รอดำเนินการ'],['dashInProgress','กำลังซ่อม'],['dashWaitingParts','รออะไหล่']])$(id).textContent=num(repairs.filter(r=>r.status===status).length);
      $('dashRepairError').innerHTML='';
      const rows=[...pending].sort((a,b)=>String(a.date||'9999').localeCompare(String(b.date||'9999'))||String(a.repairNo).localeCompare(String(b.repairNo))).slice(0,6);
      $('dashRecentRepairs').innerHTML=rows.length?rows.map(r=>{
        let age=null;try{age=Math.max(0,OilTrackingModel.days(OilTrackingModel.today(),r.date));}catch(_){}
        return `<tr><td><button class="dash-text-link" data-dash-page="repairs" data-search="${esc(r.repairNo)}">${esc(r.repairNo)}</button><small>${date(r.date)}</small></td><td><strong>${esc(r.plate||'ไม่ระบุทะเบียน')}</strong><span class="dash-job-description">${esc(r.repairList||'ไม่ระบุรายการ')}</span></td><td><span class="dash-badge ${r.status==='รออะไหล่'?'amber':r.status==='กำลังซ่อม'?'blue':'neutral'}">${esc(r.status)}</span>${age!==null?`<small class="${age>14?'dash-text-danger':''}">ค้าง ${num(age)} วัน</small>`:''}</td><td>${button('repairs',r.repairNo,'','ดู '+r.repairNo)}</td></tr>`;
      }).join(''):'<tr><td colspan="4" class="dash-empty">ไม่มีงานซ่อมค้าง</td></tr>';
    },()=>{$('dashRepairError').innerHTML=error('อ่านงานซ่อมไม่สำเร็จ');$('dashRecentRepairs').innerHTML='';$('dashPendingCount').textContent='—';for(const id of ['dashWaiting','dashInProgress','dashWaitingParts'])$(id).textContent='—';});
    task('getPOs',pos=>{
      allPOs=pos;
      const pending=pos.filter(p=>p.status==='รออนุมัติ').sort((a,b)=>String(a.issueDate||'9999').localeCompare(String(b.issueDate||'9999')));
      $('dashPOPending').textContent=num(pending.length);$('dashPOMetric').disabled=false;
      $('dashPOTotal').textContent=num(pending.length)+' ใบกำลังรอการพิจารณา';
      $('dashPOList').innerHTML=pending.length?pending.slice(0,3).map(p=>`<div class="dash-list-row"><div><button class="dash-text-link" data-dash-page="po" data-search="${esc(p.poNo)}" data-status="รออนุมัติ">${esc(p.poNo)}</button><small>${esc(p.shopName||'ไม่ระบุร้าน')} • ${date(p.issueDate)}</small></div><span class="dash-badge">${esc(p.plate||'ไม่ระบุทะเบียน')}</span>${button('po',p.poNo,'รออนุมัติ','ดู '+p.poNo)}</div>`).join(''):empty('ไม่มี PO รออนุมัติ');
    },()=>{$('dashPOTotal').textContent='ยังสรุปยอดไม่ได้';$('dashPOList').innerHTML=error('อ่านใบสั่งซื้อไม่สำเร็จ');});
    task('getStock',stock=>{
      allStock=stock;
      const out=stock.filter(s=>Number(s.qty)<=0),low=stock.filter(s=>Number(s.qty)>0&&Number(s.minQty)>0&&Number(s.qty)<=Number(s.minQty));
      $('dashStockOut').textContent=num(out.length);$('dashStockMetric').disabled=false;$('dashStockLowCount').innerHTML='ใกล้หมด '+num(low.length)+' รายการ <i class="bi bi-arrow-up-right"></i>';
      const rows=[...out,...low].slice(0,4);
      $('dashLowStock').innerHTML=rows.length?rows.map(s=>`<div class="dash-list-row"><div><strong>${esc(s.partName)}</strong><small>จุดสั่งซื้อ ${num(s.minQty)} ${esc(s.unit||'')}</small></div><span class="dash-badge ${Number(s.qty)<=0?'red':'amber'}">เหลือ ${num(s.qty)} ${esc(s.unit||'')}</span>${button('stock',s.partName,'','ดู '+s.partName)}</div>`).join(''):empty('อะไหล่ยังเพียงพอ');
    },()=>{$('dashStockLowCount').textContent='ใกล้หมด — รายการ';$('dashLowStock').innerHTML=error('อ่านคลังอะไหล่ไม่สำเร็จ');});
    task('getFullBuses',buses=>{
      allBuses=buses;
      const alerts=[];
      for(const b of buses)for(const [label,value]of [['ทะเบียน',b.regExpiry],['ประกัน',b.insuranceExpiry]]){
        if(!value)continue;
        try{const days=OilTrackingModel.days(String(value).slice(0,10),OilTrackingModel.today());if(days<=60)alerts.push({plate:b.plate,label,days,date:value});}catch(_){alerts.push({plate:b.plate,label,days:null,date:value});}
      }
      alerts.sort((a,b)=>(a.days??-Infinity)-(b.days??-Infinity));
      $('dashExpiryAlert').innerHTML=alerts.length?alerts.slice(0,4).map(a=>`<div class="dash-list-row"><div><strong>${esc(a.plate)}</strong><small>${esc(a.label)} • ${date(a.date)}</small></div><span class="dash-badge ${a.days===null||a.days<0?'red':'amber'}">${a.days===null?'ตรวจสอบวันที่':a.days<0?'เกิน '+num(-a.days)+' วัน':'อีก '+num(a.days)+' วัน'}</span>${button('buses',a.plate,'','ดูทะเบียน '+a.plate)}</div>`).join(''):empty('ไม่มีทะเบียนหรือประกันใกล้หมดอายุ');
    },()=>{$('dashExpiryAlert').innerHTML=error('อ่านทะเบียนรถไม่สำเร็จ');});
    tasks.push(OilDashboard.load(force));
    tasks.push(OilTrackingData.read({force}).then(data=>{if(request!==serial)return;$('dashOilDue').textContent=num(data.records.filter(r=>r.status==='due').length);$('dashOilNear').innerHTML='ใกล้ครบ '+num(data.records.filter(r=>r.status==='near').length)+' คัน <i class="bi bi-arrow-up-right"></i>';$('dashOilMetric').disabled=false;}).catch(()=>{if(request===serial)$('dashOilNear').textContent='ใกล้ครบ — คัน';}));
    loadWeeklySummary(0);
    await Promise.all(tasks);
    if(request===serial){$('dashRefresh').disabled=false;$('dashUpdated').textContent='อ่านล่าสุด '+new Intl.DateTimeFormat('th-TH',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Bangkok'}).format(new Date());}
  }
  function renderWeekly(data){
    $('weeklyLabel').textContent=String(data.weekLabel||'')+(data.weekOffset===0?' • สัปดาห์นี้':'');
    for(const [id,key]of [['wkOpened','openedCount'],['wkDone','doneCount'],['wkPending','pendingCount'],['wkCarry','carryOverCount']])$(id).textContent=num(data[key]);
    $('weeklyExtra').style.removeProperty('display');
    $('wkTopPlates').innerHTML=(data.topPlates||[]).slice(0,3).map(p=>`<button class="dash-week-link" data-dash-page="repairs" data-search="${esc(p.plate)}"><span>${esc(p.plate)}</span><b>${num(p.count)} งาน</b></button>`).join('')||'<small>ไม่มีงานเปิดในช่วงนี้</small>';
    $('wkByStatus').innerHTML=Object.entries(data.byStatus||{}).map(([status,count])=>`<button class="dash-week-link" data-dash-page="repairs" data-status="${esc(status)}"><span>${esc(status)}</span><b>${num(count)}</b></button>`).join('')||'<small>ไม่มีงานค้าง</small>';
  }
  window.DashboardUI={load,open,consume,renderWeekly};
})();
