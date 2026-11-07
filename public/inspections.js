const InspectionUI = (() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  const fields = ['plate','inspectedAt','route','driver1','driver2','license1','license2','assistant','inspector','supervisor','odometer','notes'];
  const labels = { pass: 'ผ่าน', fail: 'ไม่ผ่าน', na: 'ไม่มี / ไม่เกี่ยวข้อง', '': 'ยังไม่ตรวจ' };
  const targetNames = { front:'ด้านหน้า', back:'ด้านหลัง', left:'ด้านซ้าย', right:'ด้านขวา', general:'ทั่วไป', 'signature-driver':'คนขับ', 'signature-inspector':'ผู้ตรวจ', 'signature-supervisor':'ผู้ควบคุม' };
  let records = [], filtered = [], buses = [], current = null, editable = true, dirty = false, busy = false, pageNumber = 1, loadedUser = '', restoreTimer, checkMode='all';
  const pads = new Map();
  let signatureDirty=false;
  const cacheKey = () => `vi:draft:${window.currentUser?.id || ''}`;
  async function api(method, query = {}, body) {
    const response = await fetch('/.netlify/functions/vehicle-inspections?' + new URLSearchParams(query), {
      method, headers: { 'Content-Type':'application/json', Authorization:`Bearer ${window.appSessionToken || ''}` },
      body: body ? JSON.stringify(body) : undefined
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) throw new Error(result.message || 'ติดต่อระบบตรวจรถไม่สำเร็จ');
    return result;
  }
  async function load(force = false) {
    if (loadedUser !== window.currentUser?.id) { records = []; buses = []; current = null; dirty = false; loadedUser = window.currentUser?.id; }
    if (!dirty) back(false);
    $('vi-count').textContent = 'กำลังโหลด...';
    try {
      const [result, busRows] = await Promise.all([
        api('GET'), new Promise((resolve, reject) => google.script.run.withSuccessHandler(resolve).withFailureHandler(reject).getBusPlates())
      ]);
      records = result.records;
      buses = (busRows || []).map(bus => bus.plate).filter(Boolean);
      $('vi-bus-list').innerHTML = buses.map(plate => `<option value="${esc(plate)}"></option>`).join('');
      filter();
      const plate = new URLSearchParams(location.search).get('inspectionPlate');
      if (plate) {
        const url = new URL(location.href); url.searchParams.delete('inspectionPlate'); history.replaceState(null, '', url);
        await newRecord(InspectionModel.qrPlate(plate, buses));
      }
    } catch (error) {
      $('vi-count').textContent = error.message;
      $('vi-rows').innerHTML = '<tr><td colspan="6" class="text-center py-4">โหลดข้อมูลไม่สำเร็จ</td></tr>';
      showToast('error', error.message);
    }
  }
  function filter() {
    const query = $('vi-query').value.trim().toLowerCase(), from = $('vi-from').value, to = $('vi-to').value, state = $('vi-filter').value;
    filtered = from && to && from > to ? [] : records.filter(record => (!query || [record.number,record.plate,record.route,record.driver1,record.inspector].join(' ').toLowerCase().includes(query))
      && (!from || record.inspectedAt.slice(0,10) >= from) && (!to || record.inspectedAt.slice(0,10) <= to)
      && (!state || (state === 'issues' ? record.failed > 0 : record.state === state)));
    pageNumber = 1; renderList();
  }
  function renderList() {
    const start = (pageNumber - 1) * 20;
    $('vi-count').textContent = `${filtered.length} ครั้งตรวจ · พบข้อบกพร่อง ${filtered.filter(record => record.failed > 0).length} ครั้ง`;
    $('vi-rows').innerHTML = filtered.slice(start,start+20).map((record,index) => `<tr><td><strong>${esc(record.number)}</strong><div class="small text-muted">${esc(record.inspectedAt.replace('T',' '))}</div></td><td>${esc(record.plate || 'ยังไม่ระบุ')}<div class="small">${esc(record.route)}</div></td><td>${esc(record.driver1)}</td><td>${esc(record.inspector)}</td><td><span class="badge ${record.state === 'draft' ? 'bg-secondary-light text-secondary' : record.failed ? 'bg-danger-light text-danger' : 'bg-success-light text-success'}">${record.state === 'draft' ? 'แบบร่าง' : 'ส่งผลแล้ว'}</span><div class="small">ตรวจ ${record.checked}/${record.total} · ไม่ผ่าน ${record.failed}</div></td><td><button class="btn btn-sm btn-outline-primary" title="เปิดแบบตรวจ" onclick="InspectionUI.open(${start+index})"><i class="bi bi-eye"></i></button></td></tr>`).join('') || '<tr><td colspan="6" class="text-center text-muted py-4">ไม่พบรายการตรวจ</td></tr>';
    $('vi-page').textContent = filtered.length ? `${start+1}–${Math.min(start+20,filtered.length)} จาก ${filtered.length}` : '';
    $('vi-prev').disabled = pageNumber <= 1; $('vi-next').disabled = start+20 >= filtered.length;
    $('vi-rows').querySelectorAll('tr').forEach(row=>Array.from(row.cells).forEach((cell,index)=>{cell.dataset.label=['เลขรายการ','รถ / เส้นทาง','คนขับ','ผู้ตรวจ','ผลตรวจ',''][index];}));
  }
  function page(delta) { pageNumber = Math.max(1, Math.min(Math.ceil(filtered.length/20)||1,pageNumber+delta)); renderList(); }
  function canLeave() {
    if(busy)return false;
    if(!dirty)return true;
    if(!confirm('มีข้อมูลที่ยังไม่บันทึก ต้องการออกจากแบบตรวจหรือไม่?'))return false;
    clearTimeout(restoreTimer);
    try{sessionStorage.setItem(cacheKey(),JSON.stringify(collect()));}catch(_){}
    dirty=false;return true;
  }
  function back(check = true) {
    if (check && !canLeave()) return;
    if (check) dirty = false;
    document.body.classList.remove('inspection-editing');
    $('inspection-form').classList.add('d-none'); $('inspection-list').classList.remove('d-none');
  }
  async function newRecord(plate = '') {
    if (!canLeave()) return;
    const now = new Date(); now.setMinutes(now.getMinutes()-now.getTimezoneOffset());
    current = { id:crypto.randomUUID(), revision:0, templateVersion:InspectionModel.version, template:InspectionModel.template,
      plate, inspectedAt:now.toISOString().slice(0,16), inspector:window.currentUser?.name || '', answers:{}, attachments:[], state:'draft' };
    try {
      const cached = JSON.parse(sessionStorage.getItem(cacheKey()) || 'null');
      if (cached && !plate && confirm('พบข้อมูลแบบตรวจที่ยังไม่บันทึก ต้องการกรอกต่อหรือไม่?')) current = cached;
    } catch (_) {}
    editable = true; dirty = false; renderForm();
  }
  async function open(index) {
    if (!canLeave()) return;
    try {
      showLoading('กำลังเปิดแบบตรวจ...');
      const result = await api('GET', { id:filtered[index].id });
      current = result.record; editable = result.canEdit; dirty = false;
      Swal.close(); renderForm();
    } catch(error) { Swal.close(); showToast('error',error.message); }
  }
  function renderForm() {
    document.body.classList.add('inspection-editing');
    $('inspection-list').classList.add('d-none'); $('inspection-form').classList.remove('d-none');
    $('vi-title').textContent = current.number || 'ตรวจรถก่อนออกงาน';
    $('vi-state').textContent = current.state === 'submitted' ? `ส่งผลแล้ว · ${current.submittedBy} · ${new Date(current.submittedAt).toLocaleString('th-TH')}` : 'แบบร่าง';
    fields.forEach(field => { $(`vi-${field}`).value = current[field] ?? ''; $(`vi-${field}`).disabled = !editable; });
    $('vi-scan').disabled = !editable; $('vi-photo-button').classList.toggle('d-none',!editable);
    $('vi-save-actions').classList.toggle('d-none',!editable);
    const template = current.template || InspectionModel.template;
    const groups = [...new Set(template.map(item=>item.group))];
    $('vi-trip-details').open=true;
    $('vi-trip-label').textContent=current.plate||'';
    checkMode='all';
    $('vi-checklist').innerHTML = groups.map((group,groupIndex)=>`<details class="vi-section vi-group" ${innerWidth>768||groupIndex===0?'open':''}><summary><span class="vi-group-number">${groupIndex+1}</span><span>${esc(group)}</span><span class="vi-group-count" data-group="${esc(group)}"></span><i class="bi bi-chevron-down"></i></summary><div class="vi-group-body">${template.filter(item=>item.group===group).map(item=>{
      const answer=current.answers[item.id]||{};
      return `<div class="vi-check" id="vi-check-${item.id}"><div class="vi-check-name">${esc(item.label)}</div><div class="vi-options" role="group" aria-label="${esc(item.label)}">${['pass','fail',...(item.optional?['na']:[])].map(status=>`<label class="vi-choice ${status}"><input type="radio" name="${item.id}" value="${status}" ${answer.status===status?'checked':''} ${!editable?'disabled':''} onchange="InspectionUI.answer('${item.id}','status',this.value)"><span>${labels[status]}</span></label>`).join('')}</div>${item.count?`<label class="vi-count">จำนวน<input type="number" class="form-control form-control-sm" min="0" max="1000" step="1" value="${answer.count??''}" ${!editable?'disabled':''} oninput="InspectionUI.answer('${item.id}','count',this.value)"></label>`:''}<textarea aria-label="หมายเหตุ ${esc(item.label)}" placeholder="หมายเหตุ / ปัญหาที่พบ" class="form-control vi-check-note ${answer.status==='fail'||answer.note?'':'d-none'}" rows="2" maxlength="500" ${!editable?'disabled':''} oninput="InspectionUI.answer('${item.id}','note',this.value)">${esc(answer.note||'')}</textarea></div>`;
    }).join('')}</div></details>`).join('');
    $('vi-checklist').querySelectorAll('details').forEach(group=>group.addEventListener('toggle',()=>{
      if(group.open&&innerWidth<=768)$('vi-checklist').querySelectorAll('details').forEach(other=>{if(other!==group)other.open=false;});
    }));
    $('vi-photo-target').innerHTML = ['front','back','left','right','general'].map(target=>`<option value="${target}">${targetNames[target]}</option>`).join('') + template.map(item=>`<option value="${item.id}">${esc(item.label)}</option>`).join('');
    renderPhotos(); renderSignatures(); progress();filterChecks('all');
    $('vi-form').oninput = () => changed();
    $('vi-form').onchange = () => changed();
    window.scrollTo({top:0,behavior:'smooth'});
  }
  function collect() {
    fields.forEach(field=>{ current[field]=$(`vi-${field}`).value; });
    current.pendingSignatures = {};
    for(const[role,pad]of pads){if(pad.changed)current.pendingSignatures[role]=pad.canvas.toDataURL('image/png');}
    return current;
  }
  function changed() {
    if (!editable || !current) return;
    dirty = true; clearTimeout(restoreTimer);
    restoreTimer = setTimeout(()=>{ try { sessionStorage.setItem(cacheKey(),JSON.stringify(collect())); } catch (_) {} },400);
  }
  function answer(id, field, value) {
    if (!editable) return;
    current.answers[id] = {...(current.answers[id]||{}),[field]:value};
    if (field==='status') $('vi-check-'+id).querySelector('textarea').classList.toggle('d-none',value!=='fail'&&!current.answers[id].note);
    $('vi-check-'+id).dataset.result=current.answers[id].status||'';
    progress(); changed();
  }
  function progress() {
    const summary=InspectionModel.summary(current);
    $('vi-progress-text').textContent=`ตรวจแล้ว ${summary.checked}/${summary.total} · ไม่ผ่าน ${summary.failed} · ไม่มีอุปกรณ์ ${summary.skipped}`;
    $('vi-progress-bar').value=summary.checked; $('vi-progress-bar').max=summary.total;
    $('vi-checklist').querySelectorAll('.vi-group-count').forEach(element=>{
      const items=(current.template||InspectionModel.template).filter(item=>item.group===element.dataset.group);
      const count=items.filter(item=>current.answers[item.id]?.status).length;
      const failed=items.some(item=>current.answers[item.id]?.status==='fail');
      element.textContent=`${count}/${items.length}`;element.classList.toggle('complete',count===items.length);element.classList.toggle('has-issues',failed);
    });
  }
  function filterChecks(mode) {
    checkMode=mode;
    $('inspection-form').querySelectorAll('.vi-result-filter button').forEach(button=>{const active=button.dataset.mode===mode;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
    for(const item of current.template||InspectionModel.template){
      const element=$('vi-check-'+item.id),status=current.answers[item.id]?.status||'';
      element.hidden=mode==='pending'?!!status:mode==='fail'?status!=='fail':false;element.dataset.result=status;
    }
    $('vi-checklist').querySelectorAll('.vi-group').forEach(group=>{group.hidden=!Array.from(group.querySelectorAll('.vi-check')).some(item=>!item.hidden);});
    const empty=!Array.from($('vi-checklist').querySelectorAll('.vi-check')).some(item=>!item.hidden);
    $('vi-check-empty').classList.toggle('d-none',!empty);
    $('vi-check-empty').textContent=mode==='fail'?'ยังไม่มีข้อที่ไม่ผ่าน':'ตอบผลตรวจครบแล้ว';
  }
  function reveal(id) {
    filterChecks('all');const element=$('vi-check-'+id);element.closest('details').open=true;
    requestAnimationFrame(()=>element.scrollIntoView({behavior:'smooth',block:'center'}));
  }
  function nextUnchecked(start=false) {
    const item=(current.template||InspectionModel.template).find(item=>!current.answers[item.id]?.status);
    if(item){if(start)$('vi-trip-details').open=false;reveal(item.id);}
    else{showToast('success','ตอบผลตรวจครบแล้ว');$('vi-signatures').scrollIntoView({behavior:'smooth',block:'center'});}
  }
  async function upload(dataURL,target) {
    if ((current.attachments||[]).length>=20) throw new Error('แนบรูปและลายเซ็นได้ไม่เกิน 20 รูป');
    const result=await api('POST',{}, {action:'upload',id:current.id,templateVersion:current.templateVersion,target,base64:dataURL.split(',')[1]});
    if(target.startsWith('signature-')) current.attachments=current.attachments.filter(item=>item.target!==target);
    current.attachments.push(result.attachment); changed();
  }
  async function photo(input) {
    const file=input.files?.[0]; if(!file||!editable||busy) return;
    if(!['image/jpeg','image/png'].includes(file.type)) { showToast('warning','กรุณาใช้รูป JPG หรือ PNG'); return; }
    busy=true;
    try {
      const image=await createImageBitmap(file); const ratio=Math.min(1,1400/Math.max(image.width,image.height));
      const canvas=document.createElement('canvas'); canvas.width=Math.round(image.width*ratio); canvas.height=Math.round(image.height*ratio);
      canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height); image.close();
      let quality=.8, url=canvas.toDataURL('image/jpeg',quality);
      while(url.length>1250000&&quality>.25){quality-=.15;url=canvas.toDataURL('image/jpeg',quality);}
      await upload(url,$('vi-photo-target').value);renderPhotos();
    } catch(error){showToast('error',error.message);} finally{busy=false;input.value='';}
  }
  function renderPhotos() {
    $('vi-photos').innerHTML=current.attachments.map((attachment,index)=>attachment.target.startsWith('signature-')?'':`<figure><a href="${esc(attachment.url||'')}" target="_blank" rel="noopener"><img src="${esc(attachment.url||'')}" alt="${esc(targetNames[attachment.target]||'รูปจุดตรวจ')}" loading="lazy"></a><figcaption>${esc(targetNames[attachment.target]||(current.template||InspectionModel.template).find(item=>item.id===attachment.target)?.label||'รูปแนบ')}${editable?`<button type="button" class="btn btn-sm btn-outline-danger ms-1" onclick="InspectionUI.removePhoto(${index})" title="นำรูปออก"><i class="bi bi-trash"></i></button>`:''}</figcaption></figure>`).join('');
  }
  function removePhoto(index){if(!editable||busy)return;current.attachments.splice(index,1);changed();renderPhotos();}
  function renderSignatures() {
    pads.clear();
    $('vi-signatures').innerHTML=['driver','inspector','supervisor'].map(role=>{
      const existing=current.attachments.find(item=>item.target==='signature-'+role);
      return `<div class="col-12 col-md-4"><div class="d-flex align-items-center justify-content-between mb-2"><label for="vi-sign-button-${role}" class="form-label mb-0">${targetNames['signature-'+role]}</label>${editable?`<button type="button" class="btn btn-sm btn-outline-secondary" title="ล้างลายเซ็น" onclick="InspectionUI.clearSignature('${role}')"><i class="bi bi-eraser"></i></button>`:''}</div>${editable?`<button id="vi-sign-button-${role}" type="button" class="vi-sign-open" onclick="InspectionUI.openSignature('${role}')" aria-label="เปิดพื้นที่เซ็น ${targetNames['signature-'+role]}"><canvas id="vi-pad-${role}" width="600" height="220" aria-hidden="true"></canvas><span><i class="bi bi-pen me-1"></i>เซ็น / แก้ไขลายเซ็น</span></button>`:existing?`<img class="vi-signed-image" src="${esc(existing.url)}" alt="ลายเซ็น ${targetNames['signature-'+role]}">`:'<div class="text-muted py-3">ไม่ได้ลงลายเซ็น</div>'}</div>`;
    }).join('');
    if(!editable)return;
    ['driver','inspector','supervisor'].forEach(role=>{
      const canvas=$('vi-pad-'+role),ctx=canvas.getContext('2d');ctx.lineWidth=3;ctx.lineCap='round';ctx.strokeStyle='#172d42';
      const pad={canvas,changed:false,drawing:false};pads.set(role,pad);
      const existing=current.attachments.find(item=>item.target==='signature-'+role);
      const restored=current.pendingSignatures?.[role];
      if(restored||existing?.url){const image=new Image();image.crossOrigin='anonymous';image.onload=()=>{if(!pad.changed){ctx.drawImage(image,0,0,canvas.width,canvas.height);pad.changed=!!restored;}};image.src=restored||existing.url;}
    });
  }
  function clearSignature(role){if(!editable||busy)return;const pad=pads.get(role);pad.canvas.getContext('2d').clearRect(0,0,600,220);pad.changed=false;current.attachments=current.attachments.filter(item=>item.target!=='signature-'+role);changed();}
  function openSignature(role) {
    if(!editable||busy||!pads.has(role)||$('vi-sign-dialog'))return;
    const preview=pads.get(role),dialog=document.createElement('dialog');dialog.id='vi-sign-dialog';
    dialog.innerHTML=`<header><div><strong>ลายเซ็น${targetNames['signature-'+role]}</strong><small>${esc(current.plate||'')}</small></div><button type="button" class="btn btn-outline-secondary" data-action="cancel"><i class="bi bi-x-lg me-1"></i>ยกเลิก</button></header><div class="vi-sign-stage"><canvas id="vi-sign-full" aria-label="พื้นที่วาดลายเซ็น"></canvas></div><footer><button type="button" class="btn btn-outline-secondary" data-action="clear"><i class="bi bi-eraser me-1"></i>ล้าง</button><span id="vi-sign-message" role="status"></span><button type="button" class="btn btn-primary" data-action="use"><i class="bi bi-check2 me-1"></i>ใช้ลายเซ็น</button></footer>`;
    document.body.appendChild(dialog);dialog.showModal();
    const canvas=$('vi-sign-full'),ctx=canvas.getContext('2d');let drawing=false;
    const oldOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
    const fit=(image)=>{if(!image.width||!image.height)return;const scale=Math.min(canvas.width/image.width,canvas.height/image.height)*.9;ctx.drawImage(image,(canvas.width-image.width*scale)/2,(canvas.height-image.height*scale)/2,image.width*scale,image.height*scale);};
    const resize=()=>{
      const snapshot=document.createElement('canvas');snapshot.width=canvas.width;snapshot.height=canvas.height;snapshot.getContext('2d').drawImage(canvas,0,0);
      const rect=canvas.parentElement.getBoundingClientRect(),ratio=Math.min(devicePixelRatio||1,2);
      canvas.width=Math.max(1,Math.round(rect.width*ratio));canvas.height=Math.max(1,Math.round(rect.height*ratio));
      if(snapshot.width&&snapshot.height){const scale=Math.min(canvas.width/snapshot.width,canvas.height/snapshot.height);ctx.drawImage(snapshot,(canvas.width-snapshot.width*scale)/2,(canvas.height-snapshot.height*scale)/2,snapshot.width*scale,snapshot.height*scale);}
      drawing=false;
    };
    resize();fit(preview.canvas);
    const point=event=>{const rect=canvas.getBoundingClientRect();return[(event.clientX-rect.left)*canvas.width/rect.width,(event.clientY-rect.top)*canvas.height/rect.height];};
    canvas.onpointerdown=event=>{if(!event.isPrimary)return;event.preventDefault();canvas.setPointerCapture(event.pointerId);drawing=true;signatureDirty=true;ctx.strokeStyle='#172d42';ctx.fillStyle='#172d42';ctx.lineWidth=2.5*Math.min(devicePixelRatio||1,2);ctx.lineCap='round';ctx.lineJoin='round';const[x,y]=point(event);ctx.beginPath();ctx.arc(x,y,ctx.lineWidth/2,0,2*Math.PI);ctx.fill();ctx.beginPath();ctx.moveTo(x,y);$('vi-sign-message').textContent='';};
    canvas.onpointermove=event=>{if(drawing){ctx.lineTo(...point(event));ctx.stroke();}};
    canvas.onpointerup=canvas.onpointercancel=()=>{drawing=false;};
    const observer=new ResizeObserver(()=>{if(dialog.open)resize();});observer.observe(canvas.parentElement);
    const cleanup=()=>{observer.disconnect();signatureDirty=false;document.body.style.overflow=oldOverflow;dialog.remove();};
    dialog.addEventListener('close',cleanup,{once:true});
    dialog.querySelector('[data-action="cancel"]').onclick=()=>dialog.close();
    dialog.querySelector('[data-action="clear"]').onclick=()=>{ctx.clearRect(0,0,canvas.width,canvas.height);signatureDirty=true;};
    dialog.querySelector('[data-action="use"]').onclick=()=>{
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      let minX=canvas.width,minY=canvas.height,maxX=-1,maxY=-1;
      for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){if(pixels[(y*canvas.width+x)*4+3]>0){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}}
      if(maxX<0){$('vi-sign-message').textContent='กรุณาลงลายเซ็นก่อน';return;}
      const width=maxX-minX+1,height=maxY-minY+1,scale=Math.min(560/width,180/height),target=preview.canvas.getContext('2d');
      target.clearRect(0,0,600,220);target.drawImage(canvas,minX,minY,width,height,(600-width*scale)/2,(220-height*scale)/2,width*scale,height*scale);
      preview.changed=true;changed();dialog.close();
    };
  }
  async function save(state) {
    if(!editable||busy)return;
    try { InspectionModel.normalize(collect(),state==='submitted'); }
    catch(error){
      const item=(current.template||InspectionModel.template).find(item=>{
        const answer=current.answers[item.id]||{};
        return !answer.status||(answer.status==='fail'&&!answer.note?.trim())||(item.count&&answer.status!=='na'&&(answer.count===''||answer.count==null||!Number.isInteger(Number(answer.count))||Number(answer.count)<0));
      });
      if(item)reveal(item.id);else{$('vi-trip-details').open=true;$('vi-trip-details').scrollIntoView({behavior:'smooth',block:'start'});}
      showToast('warning',error.message);return;
    }
    if(state==='submitted'){
      const result=await Swal.fire({icon:'question',title:'ส่งผลตรวจ?',text:'เมื่อส่งแล้วจะเก็บเป็นประวัติและไม่สามารถแก้ไขได้',showCancelButton:true,confirmButtonText:'ส่งผลตรวจ',cancelButtonText:'กลับไปตรวจ'});
      if(!result.isConfirmed)return;
    }
    busy=true;showLoading('กำลังบันทึกแบบตรวจ...');
    try {
      for(const[role,pad]of pads){if(pad.changed){await upload(pad.canvas.toDataURL('image/png'),'signature-'+role);pad.changed=false;}}
      const result=await api('POST',{}, {action:'save',id:current.id,revision:current.revision||0,state,record:collect()});
      current.revision=result.revision;current.number=result.number;current.state=state;
      clearTimeout(restoreTimer);sessionStorage.removeItem(cacheKey());dirty=false;
      current.submittedAt=state==='submitted'?new Date().toISOString():'';current.submittedBy=state==='submitted'?window.currentUser?.name:'';
      editable=state==='draft';
      try{const saved=await api('GET',{id:current.id});current=saved.record;editable=saved.canEdit;}catch(_){/* The write succeeded; a failed refresh must not report it as a failed save. */}
      records=[{...current,...InspectionModel.summary(current)},...records.filter(record=>record.id!==current.id)];filter();
      Swal.close();renderForm();showToast('success',state==='draft'?'บันทึกแบบร่างแล้ว':'บันทึกผลตรวจแล้ว');
    } catch(error){Swal.close();showToast('error',error.message);}finally{busy=false;}
  }
  async function scan() {
    let scanner, closed=false;
    await Swal.fire({title:'สแกน QR ทะเบียนรถ',html:'<div id="vi-qr-reader"></div><div id="vi-qr-error" class="text-danger small mt-2"></div><label class="btn btn-outline-secondary mt-2">เลือกรูป QR<input type="file" id="vi-qr-file" accept="image/*" class="visually-hidden"></label>',showConfirmButton:false,showCloseButton:true,
      didOpen:async()=>{
        scanner=new Html5Qrcode('vi-qr-reader');
        const accept=async value=>{try{const plate=InspectionModel.qrPlate(value,buses);$('vi-plate').value=plate;changed();if(scanner.isScanning)await scanner.stop();Swal.close();}catch(error){$('vi-qr-error').textContent=error.message;}};
        $('vi-qr-file').onchange=async event=>{try{if(scanner.isScanning)await scanner.stop();await accept(await scanner.scanFile(event.target.files[0],true));}catch(error){$('vi-qr-error').textContent='อ่าน QR จากรูปไม่สำเร็จ';}};
        try{await scanner.start({facingMode:'environment'},{fps:10,qrbox:220},accept,()=>{});if(closed&&scanner.isScanning)await scanner.stop();}catch(error){if($('vi-qr-error'))$('vi-qr-error').textContent='เปิดกล้องไม่ได้ กรุณาอนุญาตกล้อง หรือเลือกรูป QR';}
      },willClose:()=>{closed=true;if(scanner?.isScanning)scanner.stop().catch(()=>{});}
    });
  }
  async function qrSheet() {
    const options=Object.fromEntries(buses.map(plate=>[plate,plate]));
    const result=await Swal.fire({title:'QR ประจำรถ',input:'select',inputOptions:options,inputPlaceholder:'เลือกทะเบียน',showCancelButton:true,confirmButtonText:'เปิด QR',cancelButtonText:'ยกเลิก',inputValidator:value=>!value?'กรุณาเลือกทะเบียน':undefined});
    if(!result.isConfirmed)return;
    try{const qr=await api('GET',{action:'qr',plate:result.value});await Swal.fire({title:qr.plate,imageUrl:qr.image,imageAlt:qr.plate,confirmButtonText:'พิมพ์ QR',showCancelButton:true,cancelButtonText:'ปิด'}).then(answer=>{
      if(answer.isConfirmed){const win=window.open('','_blank');if(!win){showToast('warning','กรุณาอนุญาตป๊อปอัป');return;}win.document.write(`<html lang="th"><title>QR ${esc(qr.plate)}</title><body style="font-family:Tahoma;text-align:center"><h1>${esc(qr.plate)}</h1><img src="${qr.image}" width="300" height="300" alt="QR"><p>บันทึกตรวจรถ · Feet Management</p><button onclick="window.print()">พิมพ์</button></body></html>`);win.document.close();}
    });}catch(error){showToast('error',error.message);}
  }
  async function print() {
    if(!current)return;
    collect();const win=window.open('','_blank');if(!win){showToast('warning','กรุณาอนุญาตป๊อปอัป');return;}
    if(current.revision){
      try{const fresh=await api('GET',{id:current.id});const urls=new Map(fresh.record.attachments.map(item=>[item.path,item.url]));current.attachments.forEach(item=>{if(urls.has(item.path))item.url=urls.get(item.path);});}
      catch(_){/* Existing image URLs can still be printed when a refresh is temporarily unavailable. */}
    }
    const signatures=['driver','inspector','supervisor'].map(role=>{
      const item=current.attachments.find(attachment=>attachment.target==='signature-'+role),pad=pads.get(role);
      return {src:editable&&pad?.changed?pad.canvas.toDataURL():item?.url,label:targetNames['signature-'+role],
        name:role==='driver'?current.driver1:role==='inspector'?current.inspector:current.supervisor};
    });
    win.document.write(InspectionPrint.render({...current,template:current.template||InspectionModel.template},signatures));win.document.close();
  }
  window.addEventListener('beforeunload',event=>{if(dirty||signatureDirty){event.preventDefault();event.returnValue='';}});
  return {load,filter,page,newRecord,open,back,canLeave,answer,photo,removePhoto,clearSignature,openSignature,save,scan,qrSheet,print,filterChecks,nextUnchecked};
})();
