/* Current Feet vehicles + HR-POS odometers. Read-only, no localStorage baseline. */
(function(){
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num=value=>value==null?'—':Number(value).toLocaleString('th-TH');
  const date=value=>{try{return value?new Intl.DateTimeFormat('th-TH',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'UTC'}).format(OilTrackingModel.date(value)):'—';}catch(_){return 'วันที่ไม่ถูกต้อง';}};
  let activeView=null;
  function mount(root,actor){
    root.classList.add('ot');
    const key=actor?.id+':'+actor?.role;
    if(root.dataset.liveActor===key)return;
    root.dataset.liveActor=key;
    let records=[],page=1,size=10,search='',status='',loading=false,loaded=false;
    root.innerHTML=`<div class="ot-bar fleet-oil-toolbar"><div id="otl-message" aria-live="polite"></div><button class="ot-button" id="otl-refresh"><i class="bi bi-arrow-clockwise" aria-hidden="true"></i> รีเฟรช</button></div>
      <div class="ot-summary fleet-summary" id="otl-summary"></div>
      <div class="ot-filter"><label>ค้นหาทะเบียน / กลุ่มรอบ<input id="otl-search" type="search" placeholder="ทะเบียน หรือกลุ่มรอบ"></label><label>สถานะ<select id="otl-status" data-no-tomselect><option value="">ทุกสถานะ</option>${Object.entries(OilTrackingModel.statuses).map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}<option value="missing">ยังไม่มีไมล์จาก HR-POS</option></select></label></div>
      <div class="ot-table-wrap"><table class="ot-fleet-table"><thead><tr>${['ทะเบียน / กลุ่มรอบ','ไมล์ปัจจุบัน','เปลี่ยนถ่ายล่าสุด','รอบถัดไป','วันที่ครบกำหนด*','ระยะคงเหลือ','สถานะ',''].map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody id="otl-rows"></tbody></table></div><p class="ot-muted fleet-table-note">* วันครบกำหนดคำนวณเดือนปฏิทินจากวันที่ใบงาน</p>
      <div class="ot-pagination"><span id="otl-count"></span><div class="ot-actions"><label for="otl-size">ต่อหน้า</label><select id="otl-size" data-no-tomselect><option>10</option><option>25</option><option>50</option></select><button class="ot-button ot-icon" id="otl-prev" aria-label="หน้าก่อนหน้า"><i class="bi bi-chevron-left"></i></button><span id="otl-page"></span><button class="ot-button ot-icon" id="otl-next" aria-label="หน้าถัดไป"><i class="bi bi-chevron-right"></i></button></div></div>
      <dialog id="otl-dialog" aria-labelledby="otl-title"><div class="ot-dialog-head"><h3 id="otl-title"></h3><button class="ot-button ot-icon" id="otl-close" aria-label="ปิด"><i class="bi bi-x-lg"></i></button></div><div class="ot-dialog-body" id="otl-detail"></div></dialog>`;
    const external={message:root.querySelector('#otl-message'),refresh:root.querySelector('#otl-refresh')};
    const timestampSlot=document.getElementById('fleet-oil-updated'),actionSlot=document.getElementById('fleet-oil-actions');
    if(timestampSlot&&actionSlot){timestampSlot.replaceChildren(external.message);actionSlot.replaceChildren(external.refresh);root.querySelector('.fleet-oil-toolbar').remove();}
    const $=name=>external[name]||root.querySelector('#otl-'+name);
    function render(){
      const rows=records.filter(r=>(!status||(status==='missing'?!r.reading:r.status===status))&&`${r.vehicle.plate} ${r.rule?.name||''}`.toLowerCase().includes(search.toLowerCase()));
      const pages=Math.max(1,Math.ceil(rows.length/size));page=Math.min(page,pages);
      const counts=[records.length,records.filter(r=>r.reading).length,records.filter(r=>!r.reading).length,records.filter(r=>r.status==='review').length];
      $('summary').innerHTML=[['bus-front','ทะเบียนทั้งหมด',''],['speedometer2','มีข้อมูลไมล์','info'],['dash-circle','ยังไม่มีข้อมูลไมล์','warning'],['exclamation-circle','ต้องตรวจสอบ','warning']].map(([icon,label,tone],i)=>`<div class="fleet-summary-item"><span class="fleet-summary-icon ${tone}"><i class="bi bi-${icon}"></i></span><div><strong>${loaded?num(counts[i]):'—'}</strong><span>${label}</span></div></div>`).join('');
      $('rows').innerHTML=rows.slice((page-1)*size,page*size).map(r=>`<tr><td data-label="ทะเบียน / กลุ่มรอบ"><strong class="ot-plate">${esc(r.vehicle.plate)}</strong><span class="fleet-cell-sub">${esc(r.rule?.name||'รอตั้งกลุ่ม')}<br>${r.rule?`${num(r.rule.km)} กม. / ${r.rule.months} เดือน`:'ยังไม่ระบุประเภทรถ'}</span></td>
        <td data-label="ไมล์ปัจจุบัน"><strong class="fleet-number">${num(r.reading?.odometer)}</strong><span class="fleet-cell-sub">HR-POS • ${date(r.reading?.date)}</span></td>
        <td data-label="เปลี่ยนถ่ายล่าสุด">${r.oil?`<strong>${esc(r.oil.program||'ไม่ระบุ')} • ${num(r.oil.odometer)} กม.</strong><span class="fleet-cell-sub">วันที่ใบงาน ${date(r.oil.date)}</span><button class="fleet-repair-link" data-repair="${esc(r.oil.repairNo)}" title="เปิดใบงาน ${esc(r.oil.repairNo)}">${esc(r.oil.repairNo)} <i class="bi bi-arrow-up-right"></i></button>`:'<span class="ot-muted">ยังไม่มีรายการที่เสร็จแล้ว</span>'}</td>
        <td data-label="โปรแกรมถัดไป"><span class="fleet-program">${esc(r.nextProgram||(r.oil?'รอตรวจสอบ':'—'))}</span><span class="fleet-cell-sub">ที่ <strong>${num(r.dueKm)}</strong> กม.</span></td><td data-label="วันที่ครบกำหนด">${date(r.dueDate)}</td><td data-label="ระยะคงเหลือ"><strong>${r.remainingKm==null?'—':`${num(r.remainingKm)} กม.`}</strong><span class="fleet-cell-sub">${r.remainingDays==null?'':`${num(r.remainingDays)} วัน`}</span></td>
        <td data-label="สถานะ"><span class="ot-status ${r.status}">${esc(OilTrackingModel.statuses[r.status])}</span><small class="ot-reason ot-muted">${esc(r.reason)}</small></td>
        <td data-label=""><button class="ot-button fleet-source-button" data-detail="${esc(r.vehicle.id)}" title="ที่มาข้อมูล ${esc(r.vehicle.plate)}" aria-label="ที่มาข้อมูล ${esc(r.vehicle.plate)}"><i class="bi bi-info-circle"></i><span class="fleet-detail-label">ที่มาข้อมูล</span></button></td></tr>`).join('')||`<tr><td colspan="8">${loaded?'ไม่พบรายการตามเงื่อนไข':'กำลังอ่านข้อมูล...'}</td></tr>`;
      $('count').textContent=`${rows.length} คัน จาก ${records.length} คัน`;$('page').textContent=`${page} / ${pages}`;$('prev').disabled=page<=1;$('next').disabled=page>=pages;
    }
    async function reload(force=true){
      if(loading)return;loading=true;$('refresh').disabled=true;$('message').textContent='กำลังอ่านทะเบียน Feet และไมล์จาก HR-POS...';
      try{
        const data=await OilTrackingData.read({force});
        if(root.dataset.liveActor!==key)return;
        records=data.records;loaded=true;render();$('message').innerHTML=`<p class="ot-muted">อ่านข้อมูลเมื่อ ${esc(new Intl.DateTimeFormat('th-TH',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Bangkok'}).format(new Date(data.fetchedAt)))} • เลือกไมล์ตามวันที่กลับจากงาน ไม่ใช่ค่าสูงที่สุด</p>`;
      }catch(error){if(root.dataset.liveActor!==key)return;records=[];loaded=false;render();$('rows').innerHTML='<tr><td colspan="8">โหลดข้อมูลไม่สำเร็จ กรุณากดรีเฟรช</td></tr>';$('message').innerHTML=`<div class="ot-error" role="alert">${esc(error.message)}${error.message.includes('เฉพาะ')?'':' • หากเพิ่งอัปเดตโค้ด ให้ปิดแล้วเปิด run-local.bat ใหม่'}</div>`;}
      finally{loading=false;if(root.dataset.liveActor===key)$('refresh').disabled=false;}
    }
    $('refresh').onclick=()=>reload(true);$('search').oninput=e=>{search=e.target.value;page=1;render();};$('status').onchange=e=>{status=e.target.value;page=1;render();};$('size').onchange=e=>{size=Number(e.target.value);page=1;render();};$('prev').onclick=()=>{page--;render();};$('next').onclick=()=>{page++;render();};$('close').onclick=()=>$('dialog').close();
    $('rows').onclick=e=>{const repair=e.target.closest('[data-repair]');if(repair){DashboardUI.open({page:'repairs',search:repair.dataset.repair});return;}const button=e.target.closest('[data-detail]');if(!button)return;const r=records.find(r=>r.vehicle.id===button.dataset.detail);if(!r)return;
      $('title').textContent='ที่มาข้อมูล • '+r.vehicle.plate;
      $('detail').innerHTML=`<h3>ประวัติเปลี่ยนถ่ายจากใบงานที่เสร็จแล้ว</h3><p class="ot-demo">ใช้เลขไมล์และโปรแกรมที่จดในใบงาน วันที่แสดงเป็นวันที่ใบงาน ไม่ใช่วันปิดงานจริง</p>${(r.repairHistory||[]).map(x=>`<article class="ot-log"><strong>${esc(x.repairNo)} • ${esc(x.program||'ไม่ระบุ')} • ${num(x.odometer)} กม.</strong><small>วันที่ใบงาน ${date(x.date)} • ${esc(x.status)}</small></article>`).join('')||'<p>ยังไม่มีรายการที่เสร็จแล้ว</p>'}
      ${(r.pendingOilRepairs||[]).length?`<h3>ยังไม่นำมาคำนวณ</h3>${r.pendingOilRepairs.map(x=>`<p>${esc(x.repairNo)} • ${esc(x.program||'ไม่ระบุ')} • ${esc(x.status)}</p>`).join('')}`:''}
      <h3>ไมล์ปัจจุบันจาก HR-POS</h3><p>ทะเบียน HR-POS: <strong>${esc(r.matchedPlate||'ยังจับคู่ไม่ได้')}</strong></p><p>ประเภทรถ HR-POS: ${esc(r.hrVehicleType||'ไม่ระบุ')}</p><p>${esc(r.reason)}</p>${r.sourceHistory.map(x=>`<article class="ot-log"><strong>วันที่กลับ ${date(x.date)} • ${num(x.odometer)} กม.</strong><small>ก่อนไป ${num(x.before)} กม. • ใบเคลียร์ ${esc(x.clearanceCode)} • งาน ${esc(x.jobNo)}</small></article>`).join('')||'<p>ไม่มีข้อมูลต้นทางที่จับคู่ได้</p>'}`;
      $('dialog').showModal();
    };
    activeView={reload,apply(filter){status=filter.status||'';search=filter.plate||'';page=1;$('status').value=status;$('search').value=search;render();}};
    render();reload(false);
  }
  function open(filter={}){
    navigateTo('buses');
    OilTrackingUI.showTab('oil',window.currentUser);
    activeView?.apply(filter);
    activeView?.reload(false);
  }
  window.OilTrackingLiveUI={mount,open};
})();
