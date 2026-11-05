const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {PDFDocument}=require('pdf-lib');
const fs=require('fs');
const model=require('../public/inspection-model');
const {render}=require('../public/inspection-print');
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:900,height:1300}});
    const record={template:model.template,templateVersion:model.version,answers:Object.fromEntries(model.template.map(item=>[item.id,{status:'pass',count:item.count?2:null}])),plate:'30-1111 สข',number:'VI-TEST-A4',state:'submitted',inspectedAt:'2026-11-05T08:30',route:'หาดใหญ่ – กรุงเทพฯ',driver1:'คนขับทดสอบ',driver2:'คนขับคนที่สอง',inspector:'เจ้าหน้าที่ตรวจรถ',supervisor:'ผู้ควบคุม',attachments:[],notes:'ตรวจสภาพและอุปกรณ์ก่อนเดินทาง'};
    const signatures=['คนขับ','ผู้ตรวจ','ผู้ควบคุม'].map(label=>({label,name:label+' ทดสอบ'}));
    await page.setContent(render(record,signatures));await page.evaluate(()=>prepareInspectionPrint());
    fs.mkdirSync('tmp/inspection-print',{recursive:true});
    await page.locator('.page').screenshot({path:'tmp/inspection-print/a4-preview.png'});
    const buffer=await page.pdf({preferCSSPageSize:true,printBackground:true,displayHeaderFooter:false,path:'tmp/inspection-print/a4.pdf'});
    const pdf=await PDFDocument.load(buffer);assert.equal(pdf.getPageCount(),1);
    assert.ok(Math.abs(pdf.getPage(0).getSize().width-595.28)<2);
    assert.equal(await page.locator('tbody tr:not(.group)').count(),68);
    assert.ok(await page.evaluate(()=>Math.abs(document.querySelector('.sheet').getBoundingClientRect().width-document.querySelector('.page').getBoundingClientRect().width)<1),'print content must fill the paper width without horizontal scaling');
    assert.ok(await page.evaluate(()=>document.querySelector('.sheet').getBoundingClientRect().height<=document.querySelector('.page').clientHeight));
    for(const item of record.template)record.answers[item.id]={status:'fail',note:'ข้อความทดสอบปัญหา '.repeat(25),count:item.count?2:null};
    record.notes='หมายเหตุยาว '.repeat(160);
    record.route='ทดสอบชื่อเส้นทางยาว '.repeat(12);
    await page.setContent(render(record,signatures));await page.evaluate(()=>prepareInspectionPrint());
    const stress=await PDFDocument.load(await page.pdf({preferCSSPageSize:true,printBackground:true,displayHeaderFooter:false}));
    assert.equal(stress.getPageCount(),1,'long notes must remain a clearly labelled one-page summary');
    assert.ok(await page.evaluate(()=>document.querySelector('.sheet').scrollHeight<=document.querySelector('.page').clientHeight),'all content must fit without clipping');
    assert.ok((await page.locator('.notes').innerText()).includes('4/68'));
    console.log('PASS: 68 checklist items, A4 portrait, exactly one PDF page, signatures, explicitly abbreviated long notes');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
