/* Local-only demonstration. This module has no API, Supabase or LINE dependency. */
(function() {
  'use strict';
  const M = window.OilTrackingModel, Store = window.OilTrackingDemoStore;
  const local = () => ['localhost','127.0.0.1','[::1]'].includes(location.hostname);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = value => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('th-TH');
  const displayDate = value => { if(!value)return '—';try{return new Intl.DateTimeFormat('th-TH', { day:'2-digit',month:'2-digit',year:'numeric', timeZone:'UTC' }).format(M.date(value));}catch(_){return 'วันที่ไม่ถูกต้อง';} };
  const icon = name => `<i class="bi bi-${name}" aria-hidden="true"></i>`;
  function mount(root, actor, standalone = false) {
    if (!root) return;
    root.classList.add('ot');
    if (!local()) { root.textContent = 'ระยะที่ 1 เปิดได้เฉพาะ Local เท่านั้น ยังไม่เชื่อมข้อมูลจริง'; return; }
    const mountedActor = `${actor?.id || ''}:${actor?.role || ''}`;
    if (root.dataset.mounted === mountedActor) return;
    root.dataset.mounted = mountedActor;
    let store, state, page = 1, pageSize = 10, query = '', status = '';
    root.innerHTML = `<div class="ot-demo"><strong>โหมดสาธิต Local • ไม่ใช่ข้อมูลจริง</strong><br>บันทึกเฉพาะเบราว์เซอร์นี้ ไม่ส่งฐานข้อมูล HR-POS หรือ LINE</div>
      <div class="ot-bar"><h2>${icon('droplet')} ติดตามเปลี่ยนถ่าย</h2><div class="ot-actions">
      ${standalone ? '<label>บทบาทจำลอง<select id="ot-role"><option value="admin">Admin จำลอง</option><option value="user">User จำลอง (ดูอย่างเดียว)</option><option value="manager">Manager จำลอง (ดูอย่างเดียว)</option></select></label>' : ''}
      <button class="ot-button" data-action="reload" title="รีเฟรชข้อมูลสาธิต">${icon('arrow-clockwise')} รีเฟรช</button>
      <button class="ot-button" data-action="settings">${icon('sliders')} ตั้งรอบ</button>
      <button class="ot-button ot-icon" data-action="export" title="ดาวน์โหลดข้อมูลจำลองและประวัติ" aria-label="ดาวน์โหลดข้อมูลจำลองและประวัติ">${icon('download')}</button>
      </div></div><p class="ot-muted" id="ot-actor"></p>
      <div id="ot-message" aria-live="polite"></div><div class="ot-summary" id="ot-summary"></div>
      <div class="ot-filter"><label>ค้นหาทะเบียน / กลุ่มรอบ<input id="ot-search" type="search" placeholder="ทะเบียน หรือกลุ่มรอบบำรุงรักษา"></label>
      <label>สถานะ<select id="ot-status"><option value="">ทุกสถานะ</option>${Object.entries(M.statuses).map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select></label></div>
      <div class="ot-table-wrap"><table class="ot-fleet-table"><thead><tr>${['ทะเบียน','กลุ่มรอบ','ไมล์ปัจจุบัน','ถ่ายล่าสุด','ไมล์ครบกำหนด','วันที่ครบกำหนด','คงเหลือ','สถานะ','จัดการ'].map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody id="ot-rows"></tbody></table></div>
      <div class="ot-pagination"><span id="ot-count"></span><div class="ot-actions"><label for="ot-size">ต่อหน้า</label><select id="ot-size"><option>10</option><option>25</option><option>50</option></select>
      <button class="ot-button ot-icon" data-action="prev" aria-label="หน้าก่อนหน้า">${icon('chevron-left')}</button><span id="ot-page"></span><button class="ot-button ot-icon" data-action="next" aria-label="หน้าถัดไป">${icon('chevron-right')}</button></div></div>
      <dialog id="ot-dialog" aria-labelledby="ot-dialog-title"><div class="ot-dialog-head"><h3 id="ot-dialog-title"></h3><button class="ot-button ot-icon" data-action="close" aria-label="ปิด">${icon('x-lg')}</button></div><div class="ot-dialog-body" id="ot-dialog-content"></div></dialog>`;
    root.querySelectorAll('select').forEach(select=>select.setAttribute('data-no-tomselect',''));
    const $ = id => root.querySelector('#ot-' + id);
    function message(text, error = false) { $('message').innerHTML = `<div class="${error ? 'ot-error' : 'ot-notice'}" role="${error ? 'alert' : 'status'}">${esc(text)}</div>`; }
    function reload() {
      try {
        store = Store.open(localStorage, actor); state = store.snapshot(); render();
        $('actor').textContent = `ผู้ใช้งาน${standalone ? 'จำลอง' : ''}: ${actor.name || actor.id} • ${actor.role} • ${store.canWrite ? 'แก้ไขข้อมูลสาธิตได้' : 'ดูข้อมูลเท่านั้น'} • ข้อมูลตัวอย่างเริ่มวันที่ ${displayDate(state.seededOn)}`;
      } catch (error) { message(error.message, true); }
    }
    const vehicleEvents = (kind, vehicleId) => state[kind].filter(e => e.vehicleId === vehicleId);
    const results = () => state.vehicles.map(vehicle => ({ ...M.evaluate(vehicle, vehicleEvents('services',vehicle.id),vehicleEvents('readings',vehicle.id),state.settings),vehicle }));
    function render() {
      const all = results();
      $('summary').innerHTML = Object.entries(M.statuses).map(([key,label])=>`<div><b>${all.filter(r=>r.status===key).length}</b><span class="ot-status ${key}">${label}</span></div>`).join('');
      const rows = all.filter(r => (!status || r.status === status) && `${r.vehicle.plate} ${r.rule?.name || 'รอตั้งกลุ่ม'}`.toLowerCase().includes(query.toLowerCase()));
      const pages = Math.max(1,Math.ceil(rows.length/pageSize)); page = Math.max(1,Math.min(page,pages));
      $('rows').innerHTML = rows.slice((page-1)*pageSize,page*pageSize).map(r => `<tr>
        <td data-label="ทะเบียน"><span class="ot-plate">${esc(r.vehicle.plate)}</span></td>
        <td data-label="กลุ่มรอบ">${esc(r.rule?.name || 'รอตั้งกลุ่ม')}<br><span class="ot-muted">${r.rule ? `${number(r.rule.km)} กม. / ${r.rule.months} เดือน` : 'ไม่เดาประเภทรถ'}</span></td>
        <td data-label="ไมล์ปัจจุบัน">${number(r.reading?.odometer)}<br><span class="ot-muted">อ่าน ${displayDate(r.reading?.date)}</span></td>
        <td data-label="ถ่ายล่าสุด">${displayDate(r.oil?.date)}<br>${number(r.oil?.odometer)} กม.${r.oil ? ` • ${esc(r.oil.program)}` : ''}</td>
        <td data-label="ไมล์ครบกำหนด">${number(r.dueKm)}</td><td data-label="วันที่ครบกำหนด" class="ot-nowrap">${displayDate(r.dueDate)}</td>
        <td data-label="คงเหลือ">${r.remainingKm == null ? '—' : `${number(r.remainingKm)} กม.<br>${number(r.remainingDays)} วัน`}</td>
        <td data-label="สถานะ"><span class="ot-status ${r.status}">${esc(M.statuses[r.status])}</span><small class="ot-reason ot-muted">${esc(r.reason)}</small></td>
        <td data-label="จัดการ"><button class="ot-button ot-small-button" data-action="history" data-id="${esc(r.vehicle.id)}">${icon('clock-history')} ประวัติ</button></td></tr>`).join('') || '<tr><td colspan="9">ไม่พบรายการตามเงื่อนไข</td></tr>';
      $('count').textContent = `${rows.length} คัน จากทั้งหมด ${all.length} คัน`;
      $('page').textContent = `${page} / ${pages}`;
      root.querySelector('[data-action="prev"]').disabled = page <= 1;
      root.querySelector('[data-action="next"]').disabled = page >= pages;
    }
    function dialog(title, html) {
      $('dialog-title').textContent = title; $('dialog-content').innerHTML = html;
      $('dialog-content').querySelectorAll('select').forEach(select=>select.setAttribute('data-no-tomselect',''));
      if (!$('dialog').open) $('dialog').showModal();
    }
    const btn = (action,id,label,ic,extra='') => `<button class="ot-button" data-action="${action}" data-id="${esc(id)}" ${extra}>${icon(ic)} ${label}</button>`;
    function history(vehicleId) {
      const v = state.vehicles.find(v=>v.id===vehicleId);
      const log = (kind,title) => {
        const events = vehicleEvents(kind,vehicleId), active = new Set(M.effective(events).map(e=>e.id));
        return `<h3>${title}</h3>${[...events].sort((a,b)=>b.date.localeCompare(a.date)||b.sequence-a.sequence).map(e=>`<article class="ot-log"><strong>${displayDate(e.date)} • ${number(e.odometer)} กม.${kind==='services' ? ` • ${esc(e.program)}` : ''}</strong>
        <small>${active.has(e.id) ? 'ฉบับใช้งาน' : 'ฉบับก่อนแก้ไข (เก็บไว้ตรวจสอบ)'} • ${esc(e.actor?.name || e.actor?.id)} • ${esc(e.recordedAt)}${e.repairRef ? ' • อ้างอิง '+esc(e.repairRef) : ''}</small>
        ${e.note ? `<p>${esc(e.note)}</p>` : ''}${e.reason ? `<p>เหตุผลแก้ไข: ${esc(e.reason)}</p>` : ''}
        ${store.canWrite && active.has(e.id) ? btn(kind==='services'?'edit-service':'edit-reading',e.id,'แก้ไขโดยเก็บฉบับเดิม','pencil') : ''}</article>`).join('') || '<p class="ot-muted">ยังไม่มีรายการ</p>'}`;
      };
      dialog('ประวัติ '+v.plate,`<div class="ot-actions">${store.canWrite ? btn('service',vehicleId,'บันทึกเปลี่ยนถ่าย','plus-lg')+btn('reading',vehicleId,'บันทึกไมล์','speedometer2')+btn('classify',vehicleId,'ตั้งกลุ่มรถ','bus-front') : '<p>ดูข้อมูลเท่านั้น • เฉพาะ Admin ที่เพิ่มหรือแก้ไขข้อมูลสาธิตได้</p>'}${btn('audit',vehicleId,'ประวัติทำรายการ','journal-text')}</div><p class="ot-demo">วันเปลี่ยนถ่ายต้องเป็นวันที่เปลี่ยนจริง ไม่ดึงวันที่แจ้งซ่อมมาแทน</p>${log('services','ประวัติเปลี่ยนถ่าย')}${log('readings','ประวัติอ่านไมล์')}`);
    }
    function form(kind, vehicleId, previous) {
      if (!store.canWrite) throw new Error('เฉพาะ Admin เท่านั้นที่บันทึกข้อมูลได้');
      const v = state.vehicles.find(v=>v.id===vehicleId), service = kind==='services';
      dialog(`${previous ? 'แก้ไข' : 'บันทึก'}${service?'เปลี่ยนถ่าย':'ไมล์'} • ${v.plate}`,`<form id="ot-event-form"><div class="ot-form-grid">
        <label>${service?'วันที่เปลี่ยนจริง':'วันที่อ่านไมล์'}<input name="date" type="date" required max="${M.today()}" value="${esc(previous?.date || M.today())}"></label>
        <label>${service?'เลขไมล์ที่เปลี่ยนจริง':'เลขไมล์ปัจจุบัน'} (กม.)<input name="odometer" type="number" required min="0" max="100000000" step="1" value="${previous?.odometer ?? ''}"></label>
        ${service ? `<label>โปรแกรม<select name="program" required><option value="">เลือกโปรแกรม</option>${['S','M','S2','L'].map(p=>`<option ${previous?.program===p?'selected':''}>${p}</option>`).join('')}</select></label><label>อ้างอิงใบซ่อม (ถ้ามี)<input name="repairRef" maxlength="100" value="${esc(previous?.repairRef)}" placeholder="กรอกอ้างอิงด้วยตนเอง"></label>` : ''}
        <label class="ot-wide">หมายเหตุ<textarea name="note" maxlength="1000">${esc(previous?.note)}</textarea></label>
        ${previous ? '<label class="ot-wide">เหตุผลการแก้ไข<input name="reason" required maxlength="1000"></label>' : ''}
        </div><div id="ot-form-error" role="alert"></div><div class="ot-form-footer"><button type="button" class="ot-button" data-action="close">ยกเลิก</button><button class="ot-button ot-primary" type="submit">${icon('save')} บันทึกข้อมูลสาธิต</button></div></form>`);
      $('event-form').onsubmit = event => {
        event.preventDefault();
        try {
          const input = { ...Object.fromEntries(new FormData(event.target)),vehicleId,supersedes:previous?.id };
          store[service?'service':'reading'](input); state = store.snapshot(); render(); history(vehicleId); message('บันทึกในข้อมูลสาธิตของเบราว์เซอร์นี้แล้วเท่านั้น ไม่ได้บันทึกในระบบจริง');
        } catch (error) { $('form-error').innerHTML = `<p class="ot-error">${esc(error.message)}</p>`; }
      };
    }
    function configure() {
      dialog('รอบบำรุงรักษาและเกณฑ์เตือน',`<form id="ot-settings-form">${Object.entries(state.settings.groups).map(([key,g])=>`<div class="ot-policy-row"><strong>${esc(g.name)}</strong><label>ระยะทาง (กม.)<input name="${key}-km" type="number" min="1" max="100000000" required value="${g.km}"></label><label>เดือนปฏิทิน<input name="${key}-months" type="number" min="1" max="120" required value="${g.months}"></label></div>`).join('')}
        <div class="ot-form-grid"><label>เตือนเมื่อเหลือไม่เกิน (กม.)<input name="warnKm" type="number" min="0" required value="${state.settings.warnKm}"></label><label>หรือเหลือไม่เกิน (วัน)<input name="warnDays" type="number" min="0" required value="${state.settings.warnDays}"></label><label>ไมล์เก่ากว่า (วัน) ต้องตรวจสอบ<input name="staleDays" type="number" min="1" required value="${state.settings.staleDays}"></label></div>
        <p class="ot-muted">กฎ 30-5115 / 30-5145 และ 30-5456 / 30-5455 มาก่อนประเภทรถเสมอ รอบใหม่มีผลต่อการคำนวณ ไม่แก้ประวัติเปลี่ยนถ่าย</p>
        <div id="ot-form-error" role="alert"></div>${store.canWrite ? '<div class="ot-form-footer"><button class="ot-button ot-primary" type="submit">บันทึกเกณฑ์สาธิต</button></div>' : ''}</form>`);
      if (!store.canWrite) $('settings-form').querySelectorAll('input').forEach(input=>input.disabled=true);
      $('settings-form').onsubmit = event => {
        event.preventDefault();
        try {
          const input = Object.fromEntries(new FormData(event.target)), config = M.clone(state.settings);
          for (const key of Object.keys(M.groups)) config.groups[key] = { km:input[key+'-km'],months:input[key+'-months'] };
          for (const key of ['warnKm','warnDays','staleDays']) config[key]=input[key];
          store.configure(config); state=store.snapshot(); render(); $('dialog').close(); message('บันทึกเกณฑ์ในข้อมูลสาธิตเท่านั้น');
        } catch(error) { $('form-error').innerHTML=`<p class="ot-error">${esc(error.message)}</p>`; }
      };
    }
    function classify(id) {
      if (!store.canWrite) throw new Error('เฉพาะ Admin เท่านั้นที่บันทึกข้อมูลได้');
      const v=state.vehicles.find(v=>v.id===id);
      dialog('ตั้งประเภทรถ '+v.plate,`<form id="ot-classify-form"><label>ประเภทรถ<select name="type">${[['','รอตั้งค่า'],['bus','รถบัสทั่วไป'],['minibus','มินิบัส'],['van','รถตู้ปรับอากาศ']].map(([key,label])=>`<option value="${key}" ${v.type===key?'selected':''}>${label}</option>`).join('')}</select></label><label>เหตุผล<input name="reason" required maxlength="1000"></label><div id="ot-form-error" role="alert"></div><div class="ot-form-footer"><button class="ot-button ot-primary">บันทึกกลุ่มสาธิต</button></div></form>`);
      $('classify-form').onsubmit=e=>{e.preventDefault();try{const f=new FormData(e.target);store.classify(id,f.get('type'),f.get('reason'));state=store.snapshot();render();history(id);message('บันทึกกลุ่มในข้อมูลสาธิตเท่านั้น');}catch(error){$('form-error').innerHTML=`<p class="ot-error">${esc(error.message)}</p>`;}};
    }
    root.onclick=event=>{
      const button=event.target.closest('[data-action]'); if(!button||!root.contains(button))return;
      const {action,id}=button.dataset;
      try {
        if(action==='close')$('dialog').close();
        if(action==='reload'){reload();message('อ่านข้อมูลสาธิตใหม่แล้ว ไม่ได้เรียกฐานข้อมูลจริง');}
        if(action==='prev'){page--;render();} if(action==='next'){page++;render();}
        if(action==='history')history(id);
        if(action==='service'||action==='reading')form(action==='service'?'services':'readings',id);
        if(action==='edit-service'||action==='edit-reading'){const kind=action==='edit-service'?'services':'readings',entry=state[kind].find(e=>e.id===id);form(kind,entry.vehicleId,entry);}
        if(action==='classify')classify(id);
        if(action==='settings')configure();
        if(action==='audit')dialog('ประวัติผู้ทำรายการ',state.audit.filter(e=>e.entityId===id||e.entityId==='oil-tracking').reverse().map(e=>`<article class="ot-log"><strong>${esc(e.action)}</strong><small>${esc(e.actor.name||e.actor.id)} • ${esc(e.timestamp)}</small><details><summary>ข้อมูลก่อน / หลัง</summary><pre>${esc(JSON.stringify({before:e.before,after:e.after},null,2))}</pre></details></article>`).join('')||'<p>ยังไม่มีการแก้ไขข้อมูลสาธิต</p>');
        if(action==='export'){
          const url=URL.createObjectURL(new Blob([JSON.stringify(state,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='feet-oil-local-demo.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
        }
      }catch(error){message(error.message,true);}
    };
    $('search').oninput=e=>{query=e.target.value;page=1;render();};
    $('status').onchange=e=>{status=e.target.value;page=1;render();};
    $('size').onchange=e=>{pageSize=Number(e.target.value);page=1;render();};
    if(standalone)$('role').onchange=e=>{actor={id:'demo-'+e.target.value,name:'ผู้ทดสอบ '+e.target.value,role:e.target.value};reload();};
    reload();
  }
  function showTab(mode, actor) {
    document.getElementById('bus-directory-actions').hidden=mode!=='directory';
    document.getElementById('fleet-oil-updated').hidden=mode!=='oil';
    document.getElementById('fleet-oil-actions').hidden=mode!=='oil';
    document.getElementById('bus-directory-panel').hidden=mode!=='directory';
    document.getElementById('bus-oil-panel').hidden=mode!=='oil';
    document.querySelectorAll('[data-bus-tab]').forEach(button=>{const selected=button.dataset.busTab===mode;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;});
    if(mode==='oil')window.OilTrackingLiveUI.mount(document.getElementById('bus-oil-panel'),actor);
  }
  window.OilTrackingUI={mount,showTab};
  document.querySelector('.bus-section-tabs')?.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const tabs=[...document.querySelectorAll('[data-bus-tab]')],index=tabs.indexOf(event.target);if(index<0)return;
    event.preventDefault();
    const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
    tabs[next].focus();tabs[next].click();
  });
  const root=document.getElementById('oil-demo-root');
  if(root)mount(root,{id:'demo-admin',name:'ผู้ทดสอบ Admin',role:'admin'},true);
})();
