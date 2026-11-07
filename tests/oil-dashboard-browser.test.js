const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const fs=require('fs');
const path=require('path');
const fixture=()=>['due','near','review','pending','normal','due','near','review'].map((status,i)=>({
  vehicle:{id:'dash-'+i,plate:'30-'+String(1000+i)+' สข',type:'bus'},status,reason:status==='review'?'เลขไมล์ต้องตรวจสอบ':'ข้อมูลสำหรับทดสอบ',
  nextProgram:['M','S2','L','S'][i%4],dueKm:status==='review'||status==='pending'?null:135000,dueDate:'2027-02-01',
  remainingKm:status==='due'?-1000:status==='near'?1000:20000,remainingDays:status==='due'?-2:60,
  reading:{odometer:136000,date:'2026-11-06'},oil:{program:'S',odometer:100000,date:'2026-08-01',repairNo:'DEMO-REP'},rule:{name:'รถบัสทั่วไป',km:35000,months:6},
  matchedPlate:'30-'+String(1000+i),hrVehicleType:'รถบัส',sourceHistory:[],repairHistory:[],pendingOilRepairs:[]
}));
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1100}}),page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const base='http://localhost:5100';let failed=true,calls=0,records=fixture();
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.hostname.endsWith('.supabase.co')||url.hostname==='api.line.me')throw new Error('Unexpected real backend');
      if(url.origin!==base)return route.continue();
      if(url.pathname.startsWith('/.netlify/functions/'))return route.fulfill({json:{success:true,used:0,limit:300,remaining:300}});
      const folder=path.resolve('public'),file=path.resolve(folder,url.pathname==='/'?'index.html':url.pathname.slice(1));
      return file.startsWith(folder+path.sep)&&fs.existsSync(file)?route.fulfill({path:file}):route.abort();
    });
    const tables={
      repairs:[{repair_no:'REP-DEMO-1',date:'2026-10-01',plate:'30-1000 สข',mileage:100000,status:'รออะไหล่',repair_list:'เปลี่ยนอะไหล่ทดสอบ',created_at:'2026-10-01T00:00:00Z'},{repair_no:'REP-DEMO-2',date:'2026-10-02',plate:'30-1001 สข',status:'รอดำเนินการ',repair_list:'ตรวจเช็คทดสอบ',created_at:'2026-10-02T00:00:00Z'},{repair_no:'REP-DEMO-3',date:'2026-10-03',plate:'30-1000 สข',status:'เสร็จแล้ว',repair_list:'ปิดงานทดสอบ',created_at:'2026-10-03T00:00:00Z'}],
      purchase_orders:[{po_no:'PO-DEMO-OLD',shop_name:'ร้านทดสอบ',issue_date:'2026-01-01',plate:'30-1000 สข',status:'รออนุมัติ'},{po_no:'PO-DEMO-NEW',shop_name:'ร้านทดสอบ',issue_date:'2026-11-01',plate:'30-1001 สข',status:'รออนุมัติ'}],
      stock:[{id:'stock-a',part_code:'P001',part_name:'กรองน้ำมัน ทดสอบ',qty:0,min_qty:2,unit:'ชิ้น'},{id:'stock-b',part_code:'P002',part_name:'สายพาน ทดสอบ',qty:1,min_qty:2,unit:'เส้น'}],
      buses:[{plate:'30-1000 สข',chassis:'DEMO',model:'DEMO',reg_expiry:'2026-11-15',insurance_expiry:'2026-10-01'},{plate:'30-1001 สข',chassis:'DEMO',model:'DEMO'}]
    };
    await page.route('**/supabase-js@2',route=>route.fulfill({contentType:'application/javascript',body:`window.TEST_TABLES=${JSON.stringify(tables)};window.supabase={createClient:()=>({from:(table)=>{let q=new Proxy({},{get:(_,k)=>k==='then'?(resolve)=>Promise.resolve(window.TEST_FAIL_REPAIRS&&table==='repairs'?{data:null,error:{message:'mock error'}}:{data:window.TEST_TABLES[table]||[],error:null}).then(resolve):()=>q});return q;}})};`}));
    await page.route('**/.netlify/functions/oil-current-mileage',route=>{
      calls++;assert.equal(route.request().method(),'GET');
      return failed?route.fulfill({status:503,json:{success:false,message:'ต้นทางยังไม่พร้อม'}}):route.fulfill({json:{success:true,mode:'local-read-only',fetchedAt:new Date().toISOString(),records}});
    });
    await page.addInitScript(()=>{sessionStorage.setItem('currentUser',JSON.stringify({id:'test-dashboard',name:'Dashboard Tester',role:'user'}));sessionStorage.setItem('appSessionToken','dashboard-mock');});
    await page.goto(base);
    await page.waitForSelector('#do-message .ot-error');
    assert.equal(await page.locator('#do-metrics strong').first().textContent(),'—');
    assert.equal(await page.locator('#do-metrics button:not(:disabled)').count(),0);
    failed=false;await page.locator('#do-refresh').click();
    await page.waitForSelector('#do-attention .ot-dash-row');
    assert.deepEqual(await page.locator('#do-metrics strong').allTextContents(),['2','2','2','1','1']);
    assert.equal(await page.locator('#do-attention .ot-dash-row').count(),3);
    assert.deepEqual(await page.locator('#do-attention .ot-status').allTextContents(),['ครบหรือเกินกำหนด','ครบหรือเกินกำหนด','ใกล้ครบ']);
    await page.waitForFunction(()=>document.getElementById('dashPendingTotal').textContent==='2');
    assert.equal(await page.locator('#dashPOPending').innerText(),'2');
    assert.equal(await page.locator('#dashStockOut').innerText(),'1');
    assert.ok((await page.locator('#dash-oil').boundingBox()).width<600,'compact card in dashboard side column');
    assert.ok((await page.locator('#dash-oil').boundingBox()).height<550,'compact card height');
    assert.ok(Math.abs((await page.locator('.dash-repairs').boundingBox()).height-(await page.locator('#dash-oil').boundingBox()).height)<1,'repair and oil panels share row height');
    assert.ok(await page.evaluate(()=>{
      const el=document.createElement('div');el.style.background='var(--claude-bg)';document.body.append(el);
      const matches=getComputedStyle(el).backgroundColor===getComputedStyle(document.body).backgroundColor;el.remove();return matches;
    }),'dashboard uses existing theme background');
    const firstCalls=calls;
    await page.locator('#do-metrics [data-oil-status="due"]').click();
    await page.waitForSelector('#otl-rows .ot-plate');
    assert.equal(await page.locator('#otl-status').inputValue(),'due');assert.equal(await page.locator('#otl-rows .ot-plate').count(),2);
    assert.equal(calls,firstCalls,'dashboard-to-tracking uses the same cached response');
    await page.locator('.sidebar-nav-item[data-page="dashboard"]').click();
    await page.waitForSelector('#do-attention .ot-dash-row');
    await page.locator('#do-attention [data-plate]').first().click();
    assert.equal(await page.locator('#otl-search').inputValue(),'30-1000 สข');
    assert.equal(await page.locator('#otl-rows .ot-plate').count(),1);
    await page.locator('.sidebar-nav-item[data-page="dashboard"]').click();await page.waitForSelector('#do-attention .ot-dash-row');
    await page.locator('#dashRecentRepairs .dash-text-link').first().click();
    await page.waitForFunction(()=>document.getElementById('repairSearch').value==='REP-DEMO-1');
    assert.equal(await page.locator('#repairTableBody tr').count(),1);
    await page.locator('.sidebar-nav-item[data-page="dashboard"]').click();await page.waitForSelector('#dashPOList .dash-text-link');
    await page.locator('#dashPOList .dash-text-link').first().click();
    await page.waitForFunction(()=>document.getElementById('poSearch').value==='PO-DEMO-OLD');
    assert.equal(await page.locator('#poTableBody tr').count(),1);
    await page.locator('.sidebar-nav-item[data-page="dashboard"]').click();await page.waitForSelector('#do-attention .ot-dash-row');
    await page.locator('#dashRepairMetric').click();
    await page.waitForFunction(()=>document.getElementById('repairStatusFilter').value==='pending');
    assert.equal(await page.locator('#repairTableBody tr').count(),2);
    await page.locator('.sidebar-nav-item[data-page="dashboard"]').click();await page.waitForFunction(()=>!document.getElementById('dashPOMetric').disabled);
    await page.locator('#dashPOMetric').click();
    await page.waitForFunction(()=>document.getElementById('poStatusFilter').value==='รออนุมัติ');
    await page.waitForFunction(()=>document.querySelectorAll('#poTableBody tr').length===2);
    assert.equal(await page.locator('#poMonthFilter').inputValue(),'');
    assert.equal(await page.locator('#poTableBody tr').count(),2,'PO link includes waiting orders across all months');
    await page.locator('.sidebar-nav-item[data-page="dashboard"]').click();await page.waitForFunction(()=>!document.getElementById('dashStockMetric').disabled);
    await page.locator('#dashStockMetric').click();
    await page.waitForFunction(()=>document.getElementById('stockStatusFilter').value==='out');
    assert.equal(await page.locator('#stockTableBody tr').count(),1);
    await page.locator('.sidebar-nav-item[data-page="dashboard"]').click();await page.waitForSelector('#dashExpiryAlert [data-search]');
    await page.locator('#dashExpiryAlert [data-search]').first().click();
    await page.waitForFunction(()=>document.getElementById('busSearch').value==='30-1000 สข');
    assert.equal(await page.locator('#busTableBody tr').count(),1);
    await page.locator('.sidebar-nav-item[data-page="dashboard"]').click();await page.waitForSelector('#do-attention .ot-dash-row');
    await page.locator('#do-metrics [data-oil-status="pending"]').click();
    assert.equal(await page.locator('#otl-status').inputValue(),'pending');assert.equal(await page.locator('#otl-rows .ot-plate').count(),1);
    await page.locator('.sidebar-nav-item[data-page="dashboard"]').click();await page.waitForSelector('#do-attention .ot-dash-row');
    records[0].reason='<img src=x onerror="window.DASH_XSS=true">';await page.locator('#do-refresh').click();await page.waitForFunction(()=>document.querySelector('#do-message').textContent.includes('รถทั้งหมด'));
    assert.equal(await page.locator('#do-attention img').count(),0);assert.equal(await page.evaluate(()=>Boolean(window.DASH_XSS)),false);
    records=fixture();await page.locator('#do-refresh').click();await page.waitForFunction(()=>document.querySelector('#do-message').textContent.includes('รถทั้งหมด'));
    await page.evaluate(()=>{for(let i=0;i<5;i++)window.TEST_TABLES.repairs.push({...window.TEST_TABLES.repairs[0],repair_no:'REP-EXTRA-'+i});});
    await page.locator('#dashRefresh').click();await page.waitForFunction(()=>document.getElementById('dashPendingTotal').textContent==='7');
    assert.equal(await page.locator('#dashRecentRepairs tr').count(),6);
    assert.ok(Math.abs((await page.locator('.dash-repairs').boundingBox()).height-(await page.locator('#dash-oil').boundingBox()).height)<1,'equal height when repair content is taller');
    fs.mkdirSync('tmp/oil-dashboard',{recursive:true});
    await page.locator('#dash-oil').screenshot({path:'tmp/oil-dashboard/desktop.png'});
    await page.screenshot({path:'tmp/oil-dashboard/redesign-desktop.png',fullPage:true});
    for(const width of [360,390,430,768,1024,1280]){
      await page.setViewportSize({width,height:900});
      await page.waitForFunction(w=>getComputedStyle(document.querySelector('.main-content')).marginLeft===(w<=992?'0px':'260px'),width);
      await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth+1);
      if(width<=900)assert.ok((await page.locator('#dash-oil').boundingBox()).width>=width-40);
      else assert.ok(Math.abs((await page.locator('.dash-repairs').boundingBox()).height-(await page.locator('#dash-oil').boundingBox()).height)<1,'equal panel height at '+width);
      if(width===390)await page.locator('#dash-oil').screenshot({path:'tmp/oil-dashboard/mobile.png'});
      if(width===390)await page.screenshot({path:'tmp/oil-dashboard/redesign-mobile.png',fullPage:true});
    }
    failed=true;await page.locator('#do-refresh').click();await page.waitForSelector('#do-message .ot-error');
    assert.equal(await page.locator('#do-attention .ot-dash-row').count(),0);assert.equal(await page.locator('#do-metrics strong').first().textContent(),'—');
    await page.evaluate(()=>{window.TEST_FAIL_REPAIRS=true;});await page.locator('#dashRefresh').click();await page.waitForSelector('#dashRepairError .dash-error');
    assert.equal(await page.locator('#dashPendingTotal').innerText(),'—');assert.equal(await page.locator('#dashRepairMetric').isDisabled(),true);
    failed=false;records=[];await page.evaluate(()=>{window.TEST_FAIL_REPAIRS=false;for(const key of Object.keys(window.TEST_TABLES))window.TEST_TABLES[key]=[];});
    await page.locator('#dashRefresh').click();await page.waitForFunction(()=>document.getElementById('dashPendingTotal').textContent==='0');
    await page.waitForFunction(()=>!document.getElementById('dashRefresh').disabled);
    assert.ok((await page.locator('#dashRecentRepairs').innerText()).includes('ไม่มีงานซ่อมค้าง'));
    assert.equal(await page.locator('#dashPOPending').innerText(),'0');assert.equal(await page.locator('#dashStockOut').innerText(),'0');
    assert.deepEqual(errors,[]);
    console.log('PASS: redesigned dashboard metrics/priority, repair/PO/stock/bus filters and exact record links, cross-month POs, shared oil cache, refresh, safe text, empty/failure states and desktop/mobile; all source reads mocked');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
