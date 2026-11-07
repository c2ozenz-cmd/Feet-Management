const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const fs=require('fs');
const path=require('path');
const M=require('../public/oil-tracking-model');
const {assemble}=require('../functions/lib/oil-current-mileage');
const {enrich}=require('../functions/lib/oil-repair-history');
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const base='http://localhost:5101';
    const buses=['30-5115 สข','30-1001 สข','30-1002 สข','30-1003 สข','ฮท-1234 สข'].map((plate,i)=>({plate,chassis:'TEST-CHASSIS-'+i,model:i===4?'Toyota':'Hino '+(i===3?'LongModelName'.repeat(12):'Bus'),year:'2565',color:'ขาว',reg_expiry:'2027-01-01',insurance_expiry:'2027-06-01'}));
    const repairs=buses.slice(0,4).map((b,i)=>({repair_no:'DEMO-REPAIR-'+i,plate:b.plate,date:'2026-10-01',mileage:i===3?0:100000,oil_program:['S','M','S2','L'][i],repair_list:'เปลี่ยนถ่ายน้ำมันเครื่อง',repair_summary:'บันทึกทดสอบ',status:'เสร็จแล้ว',created_at:'2026-10-01T00:00:00Z'}));
    const hr=buses.map((b,i)=>({plate_no:b.plate,vehicle_type:i===4?'รถตู้ปรับอากาศ 10 ที่นั่ง':'รถบัสปรับอากาศ 1 ชั้น 40 ที่นั่ง'}));
    const clearances=buses.map((b,i)=>({row_id:i,vehicle_plate:b.plate,return_date:M.today(),odom_before:100000,odom_after:[121000,133500,105000,110000,104000][i],job_no:'DEMO-JOB-'+i,clearance_code:'DEMO-CLR-'+i}));
    const records=enrich(assemble(buses,hr,clearances),repairs);
    const tables={buses,repairs};
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.hostname.endsWith('.supabase.co')||url.hostname==='api.line.me')throw new Error('Unexpected backend request');
      if(url.origin!==base)return route.continue();
      if(url.pathname.startsWith('/.netlify/functions/'))return route.fulfill({json:{success:true,used:0,limit:300,remaining:300}});
      const folder=path.resolve('public'),file=path.resolve(folder,url.pathname==='/'?'index.html':url.pathname.slice(1));
      return file.startsWith(folder+path.sep)&&fs.existsSync(file)?route.fulfill({path:file}):route.abort();
    });
    await page.route('**/supabase-js@2',route=>route.fulfill({contentType:'application/javascript',body:`const tables=${JSON.stringify(tables)};window.supabase={createClient:()=>({from:table=>{let q=new Proxy({},{get:(_,key)=>{if(['insert','update','upsert','delete'].includes(key))throw Error('Writes forbidden in UI tests');return key==='then'?(resolve)=>Promise.resolve({data:tables[table]||[],error:null}).then(resolve):()=>q;}});return q;}})};`}));
    await page.route('**/.netlify/functions/oil-current-mileage',route=>{assert.equal(route.request().method(),'GET');return route.fulfill({json:{success:true,mode:'local-read-only',fetchedAt:new Date().toISOString(),records}});});
    await page.addInitScript(()=>{sessionStorage.setItem('currentUser',JSON.stringify({id:'fleet-test',name:'Fleet Tester',role:'admin'}));sessionStorage.setItem('appSessionToken','fleet-test');});
    await page.goto(base);await page.locator('.sidebar-nav-item[data-page="buses"]').click();await page.waitForSelector('#busTableBody tr td[data-label="ทะเบียน"]');
    assert.equal(await page.locator('#busTableBody tr').count(),5);assert.ok((await page.locator('#fleet-directory-count').innerText()).includes('5 จาก 5'));
    assert.equal(await page.locator('#bus-directory-panel .fleet-summary-item').count(),4);
    assert.ok(await page.locator('#bus-directory-panel .fleet-summary-item').first().evaluate(el=>{const s=getComputedStyle(el);return s.borderTopWidth==='1px'&&s.boxShadow!=='none'&&s.borderRadius===getComputedStyle(document.documentElement).getPropertyValue('--radius').trim();}),'summary cards match stock border, radius and shadow');
    await page.locator('#busSearch').fill('30-1001');assert.equal(await page.locator('#busTableBody tr').count(),1);
    await page.locator('#viewCardBtn').click();assert.equal(await page.locator('#viewCardBtn').getAttribute('aria-pressed'),'true');assert.ok(await page.locator('#busCardView').isVisible());
    await page.locator('#busSearch').fill('');assert.equal(await page.locator('.fleet-record').count(),5);
    await page.locator('#viewTableBtn').click();
    fs.mkdirSync('tmp/fleet-ui',{recursive:true});await page.screenshot({path:'tmp/fleet-ui/directory-desktop.png',fullPage:true});
    for(const width of [360,390,430,768,1024,1440]){
      await page.setViewportSize({width,height:900});
      await page.waitForFunction(w=>getComputedStyle(document.querySelector('.main-content')).marginLeft===(w<=992?'0px':'260px'),width);
      await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth+1,null,{timeout:3000}).catch(async error=>{console.log('Overflow',width,await page.evaluate(()=>({total:document.documentElement.scrollWidth,items:[...document.querySelectorAll('#page-buses *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.right>innerWidth+1;}).slice(0,12).map(e=>({tag:e.tagName,id:e.id,cls:e.className,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right}))})));throw error;});
      if(width===390)await page.screenshot({path:'tmp/fleet-ui/directory-mobile.png',fullPage:true});
      await page.locator('#viewCardBtn').click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'cards fit at '+width);
      await page.locator('#viewTableBtn').click();
    }
    await page.locator('[data-bus-tab="oil"]').click();await page.waitForSelector('#otl-rows .fleet-program');
    assert.equal(await page.locator('#bus-oil-panel>.ot-bar h2').count(),0);
    assert.equal(await page.locator('#fleet-oil-updated #otl-message').count(),1);
    assert.equal(await page.locator('.fleet-tabs-row #otl-refresh').count(),1);
    assert.ok(await page.locator('#fleet-oil-updated').evaluate(el=>getComputedStyle(el).textAlign==='right'),'timestamp aligns top right');
    assert.equal(await page.locator('#otl-rows tr').count(),5);assert.equal(await page.locator('#otl-rows td').count(),40);
    assert.equal(await page.locator('#otl-summary .fleet-summary-item').count(),4);
    assert.equal(await page.locator('#bus-oil-panel>.ot-demo').count(),0);
    await page.screenshot({path:'tmp/fleet-ui/oil-desktop.png',fullPage:true});
    await page.locator('#otl-status').selectOption('due');assert.equal(await page.locator('#otl-rows tr').count(),1);
    await page.locator('#otl-status').selectOption('');await page.locator('#otl-search').fill('30-1002');assert.equal(await page.locator('#otl-rows tr').count(),1);
    await page.locator('#otl-rows [data-detail]').click();assert.ok((await page.locator('#otl-detail').innerText()).includes('DEMO-REPAIR-2'));await page.locator('#otl-close').click();
    await page.locator('#otl-search').fill('');
    for(const width of [360,390,430,768,1024,1440]){
      await page.setViewportSize({width,height:900});
      await page.waitForFunction(w=>getComputedStyle(document.querySelector('.main-content')).marginLeft===(w<=992?'0px':'260px'),width);
      await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth+1);
      if(width===390)await page.screenshot({path:'tmp/fleet-ui/oil-mobile.png',fullPage:true});
    }
    await page.locator('#otl-rows [data-repair="DEMO-REPAIR-2"]').click();await page.waitForFunction(()=>document.getElementById('repairSearch').value==='DEMO-REPAIR-2');
    assert.equal(await page.locator('#repairTableBody tr').count(),1);
    assert.deepEqual(errors,[]);
    console.log('PASS: modern directory table/cards, search and counts, oil 8-column layout, filters, source dialog and repair link, long text, desktop/mobile 360–1440; all data mocked and writes forbidden');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
