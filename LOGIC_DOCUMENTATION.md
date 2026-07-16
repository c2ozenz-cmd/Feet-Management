# Logic Documentation - Feet / Bus Repair Management

เอกสารนี้สรุป logic การทำงานของโปรเจกต์ Google Apps Script/Web App จากไฟล์หลักในโฟลเดอร์นี้ ได้แก่ `Code.gs`, `Line.gs`, `PDF.gs`, `Js.html` และไฟล์หน้า `page_*.html`

## 1. ภาพรวมระบบ

ระบบนี้เป็น Web App สำหรับจัดการงานซ่อมรถบัส, ใบสั่งซื้ออะไหล่, สต็อกอะไหล่, ข้อมูลรถ, ร้านค้า, ผู้ใช้, รายงานค่าใช้จ่าย และการแจ้งเตือนผ่าน LINE

สถาปัตยกรรมหลัก:

- Frontend: `Index.html`, `Js.html`, `Css.html`, `page_*.html`, `sidebar.html`, `topbar.html`
- Backend: `Code.gs`
- LINE Webhook/LINE Messaging API: `Line.gs`
- สร้าง PDF ใบสั่งซื้อ: `PDF.gs`
- Database: Google Sheets ใน Spreadsheet ปัจจุบัน
- File storage: Google Drive สำหรับเก็บ PDF และรูป/ลายเซ็น

## 2. Entry Point ของระบบ

### Web App

`Code.gs`

- `doGet(e)` โหลดหน้า `Index.html` เป็นหน้า Web App
- `include(filename)` ใช้ include ไฟล์ HTML ย่อย เช่น CSS, JS, หน้า dashboard, repairs, PO, stock

### LINE Webhook

`Line.gs`

- `doPost(e)` รับ event จาก LINE
- แยก event เป็น 2 กลุ่มหลัก:
  - `postback`: ผู้ใช้กดปุ่มใน Flex Message เช่น อนุมัติ, ปฏิเสธ, แจ้งเสร็จ, รออะไหล่, พิมพ์รายงาน
  - `message text`: ผู้ใช้พิมพ์ข้อความ เช่น รายงานงานซ่อม, ขออนุมัติ PO/Repair, ส่งสถานะ PO

## 3. Google Sheets ที่ใช้เป็นฐานข้อมูล

กำหนดใน `SHEETS` ของ `Code.gs`

| Key | Sheet | หน้าที่ |
|---|---|---|
| `settings` | `Settings` | เก็บ config เช่น LINE token, group id, ข้อมูลบริษัท |
| `users` | `Users` | ผู้ใช้, role, LINE User ID, signature |
| `buses` | `Buses` | ข้อมูลรถ |
| `repairs` | `Repairs` | ใบแจ้งซ่อม |
| `parts` | `RepairParts` | อะไหล่ที่ผูกกับใบแจ้งซ่อม |
| `po` | `PurchaseOrders` | ใบสั่งซื้อ |
| `poItems` | `POItems` | รายการสินค้าใน PO |
| `stock` | `Stock` | สต็อกอะไหล่ |
| `stockLog` | `StockLog` | ประวัติรับเข้า/ตัดออก/ยกเลิก |
| `shops` | `Shops` | ร้านค้า/ผู้ขาย |
| `lineLog` | `LineLog` | log การส่งข้อความ LINE |
| - | `OilTemplates` | template รายการเปลี่ยนถ่ายน้ำมันตามรถ/โปรแกรม |
| - | `LineDebugLog` | debug log workflow ของ LINE |

`initializeSheets()` สร้างชีทที่จำเป็นถ้ายังไม่มี และเพิ่ม user เริ่มต้น `admin/admin1234`, `user/user1234`

## 4. Authentication และ User

### Login

`login(username, password)`

- อ่านข้อมูลจากชีท `Users`
- ตรวจ username/password
- ต้องมี `Status = active`
- คืนข้อมูล user ได้แก่ `id`, `username`, `name`, `role`, `signatureUrl`

### User Management

- `getUsers()` อ่านรายชื่อผู้ใช้
- `saveUser(user)` เพิ่ม/แก้ไขผู้ใช้
- `deleteUser(id)` ลบผู้ใช้
- `getNameByLineId(lineUserId)` หา user จาก LINE User ID
- `isLineUserAllowed(lineUserId, requiredRole)` ตรวจสิทธิ์ LINE โดยเฉพาะการอนุมัติที่ต้องเป็น admin

## 5. Settings

ใช้ชีท `Settings` แบบ key/value

ฟังก์ชันหลัก:

- `getCompanySettings()` คืน settings เป็น object
- `getSettingValue(key)` ดึงค่า setting ราย key
- `getAllSettings()` คืน settings ทั้งหมดเป็น array
- `saveSettings(settings)` ล้างและเขียน settings ใหม่

ค่าที่สำคัญ:

- `LINE_CHANNEL_TOKEN`
- `LINE_GROUP_ID`
- `LINE_GROUP_ID_PO`
- `LINE_GROUP_ID_SERVICE`
- ข้อมูลบริษัท เช่น logo, stamp, ที่อยู่, เลขภาษี สำหรับ PDF/print

## 6. Workflow ใบแจ้งซ่อม

### สร้าง/แก้ไขใบแจ้งซ่อม

`saveRepair(repair, parts)`

กรณีสร้างใหม่:

1. สร้างเลข `REPYYMM####` ด้วย `generateRepairNumber()`
2. บันทึกข้อมูลลง `Repairs`
3. ตั้งสถานะเริ่มต้นเป็น `รอดำเนินการ`
4. บันทึกรายการอะไหล่ลง `RepairParts`

กรณีแก้ไข:

1. ตรวจว่ารายการยังไม่ใช่สถานะ `เสร็จแล้ว`
2. อัปเดตข้อมูลหลัก แต่คง `status` และ `createdAt` เดิม
3. ลบรายการอะไหล่เดิมของ repair นั้น
4. เพิ่มรายการอะไหล่ใหม่

### อ่านข้อมูลซ่อม

- `getRepairs()` อ่านรายการซ่อมทั้งหมด
- `getRepairParts(repairNo)` อ่านอะไหล่ของใบแจ้งซ่อม
- `deleteRepair(repairNo)` ลบใบแจ้งซ่อมและรายการอะไหล่ที่เกี่ยวข้อง

### สถานะใบแจ้งซ่อม

สถานะที่พบใน logic:

- `รอดำเนินการ`
- `กำลังซ่อม`
- `รออะไหล่`
- `เสร็จแล้ว`

`updateRepairStatus(repairNo, status)`

- อัปเดตสถานะใน `Repairs`
- ถ้าเปลี่ยนเป็น `เสร็จแล้ว` จะเรียก `deductStockForRepair(repairNo)` เพื่อตัดสต็อก
- ถ้าเปลี่ยนออกจาก `เสร็จแล้ว` จะเรียก `restoreStockForRepair(repairNo)` เพื่อคืนสต็อก

## 7. Workflow ใบสั่งซื้อ PO

### สร้าง/แก้ไข PO

`savePO(po, items)`

กรณีสร้างใหม่:

1. สร้างเลข `POYYMM####` ด้วย `generatePONumber()`
2. เรียก `ensurePOColumns()` เพื่อให้คอลัมน์สำคัญมีครบ
3. บันทึกข้อมูล PO ลง `PurchaseOrders`
4. ตั้งสถานะเริ่มต้นเป็น `รออนุมัติ`
5. บันทึกรายการสินค้าใน `POItems`

กรณีแก้ไข:

1. คงสถานะเดิมของ PO
2. คง `CreatedAt` และ `createdBySignatureUrl` เดิมถ้ามี
3. ลบ item เดิมของ PO นั้น
4. เพิ่ม item ใหม่

### อ่านข้อมูล PO

- `getPOs()` อ่าน PO ทั้งหมด
- `getPOItems(poNo)` อ่านรายการสินค้าใน PO
- `getPOForPrint(poNo)` อ่าน PO, items, settings, signature สำหรับหน้าพิมพ์
- `deletePO(poNo)` ลบ PO และ items เฉพาะ PO ที่ยังไม่อนุมัติหรือรับของแล้ว

### สถานะ PO

สถานะที่พบใน logic:

- `รออนุมัติ`
- `ออกPO`
- `อนุมัติแล้ว`
- `รับของแล้ว`

`updatePOStatus(poNo, status, approvedBy, syncStock)`

- อัปเดตสถานะ PO
- ถ้าสถานะเป็น `อนุมัติแล้ว` จะบันทึก `approvedBy` และ `approvedAt`
- ถ้าสถานะเป็น `รับของแล้ว` และ `syncStock !== false`:
  - เรียก `addStockFromPO(poNo)` เพื่อเพิ่มสต็อก
  - เรียก `syncPOPartsToRepair(poNo)` เพื่อ sync รายการอะไหล่จาก PO ไปยังใบแจ้งซ่อมที่อ้างอิง

### Sync อะไหล่จาก PO ไป Repair

`syncPOPartsToRepair(poNo)`

1. หา `RefRepairNo` จาก PO
2. อ่านรายการ `POItems`
3. ถ้าใน `RepairParts` มี part เดิมของ repair นั้นอยู่แล้ว จะบวกจำนวนเพิ่ม
4. ถ้ายังไม่มี จะเพิ่มรายการใหม่ใน `RepairParts`

## 8. Stock และ Stock Log

### Stock Master

- `generatePartCode()` สร้างรหัสอะไหล่ `PRTYYMM###`
- `getStock()` อ่านสต็อกทั้งหมด และเติม `lastPrice` จากราคาซื้อล่าสุดใน `POItems`
- `saveStockItem(item)` เพิ่ม/แก้ไขอะไหล่
- `deleteStockItem(id)` ลบอะไหล่

### รับเข้าจาก PO

`addStockFromPO(poNo)`

- อ่าน items จาก PO
- ถ้าอะไหล่มีอยู่ใน stock แล้ว จะบวกจำนวน
- ถ้าไม่มี จะสร้าง stock item ใหม่
- บันทึก log เป็น `IN` อ้างอิง `PO: {poNo}`

### ตัดสต็อกจากใบซ่อม

`deductStockForRepair(repairNo)`

- ตรวจ `StockLog` ก่อนเพื่อกันตัดซ้ำ
- อ่านอะไหล่จาก `RepairParts`
- ตัดจำนวนใน `Stock`
- บันทึก log เป็น `OUT` อ้างอิง `Repair: {repairNo}`

### คืนสต็อกจากใบซ่อม

`restoreStockForRepair(repairNo)`

- หา log `OUT` ที่อ้างอิง repair นั้น
- บวกจำนวนกลับเข้า stock
- ลบ log การตัดออกเดิม

### ตัดสต็อกแบบ manual

`manualDeductStock(items, date, plate, note)`

- ตัด stock ตามรายการที่เลือก
- บันทึก log เป็น `OUT-MANUAL`
- ref เก็บวันที่, ทะเบียน, ราคา, หมายเหตุ

`cancelDeductStock(logId)`

- หา log manual จาก `logId`
- คืนจำนวนเข้า stock
- เปลี่ยน type ของ log เป็น `CANCEL`
- เติมข้อความยกเลิกใน ref

## 9. LINE Integration

### Config

`Line.gs`

- `getLineToken()` อ่าน `LINE_CHANNEL_TOKEN`
- `getLineGroupId(type)` เลือก group id ตามประเภท:
  - `po` ใช้ `LINE_GROUP_ID_PO`
  - `service` ใช้ `LINE_GROUP_ID_SERVICE`
  - fallback เป็น `LINE_GROUP_ID`

### ส่งใบแจ้งซ่อมเข้า LINE

`sendRepairToLine(repairNo)`

1. หาใบแจ้งซ่อม
2. ตรวจว่าต้องอยู่สถานะ `รอดำเนินการ`
3. ตรวจ `lineSentAt` เพื่อกันส่งซ้ำ
4. ส่ง Flex Message ผ่าน `notifyRepairToLine(repair)`
5. ถ้าส่งสำเร็จ บันทึกเวลา `lineSentAt`

`forceSendRepairToLine(repairNo)` ส่งซ้ำโดยไม่กันด้วยสถานะ/lineSentAt แบบเข้มเท่าตัวปกติ

### ส่ง PO เข้า LINE

`sendPOToLine(poNo)`

1. หา PO
2. ตรวจสถานะ ต้องเป็น `รออนุมัติ` หรือ `ออกPO`
3. ตรวจ `lineSentAt` เพื่อกันส่งซ้ำ
4. อ่าน items
5. ส่ง Flex Message ผ่าน `notifyPOToLine(po, items)`
6. ถ้าส่งสำเร็จ บันทึกเวลา `lineSentAt`

`sendPOsToLineQueue(poNos)` ส่งหลาย PO แบบ queue และหน่วง `Utilities.sleep(300)` ระหว่างรายการ

`forceSendPOToLine(poNo)` ส่งซ้ำแบบบังคับ

### LINE Postback: อนุมัติ/ปฏิเสธ

`handlePostback(event)`

กรณี action ของ admin:

- `action=approve&type=repair&id=REP...`
  - ตรวจสิทธิ์ admin จาก LINE User ID
  - ตรวจสถานะต้องเป็น `รอดำเนินการ`
  - เปลี่ยนสถานะเป็น `กำลังซ่อม`
  - บันทึกผู้อนุมัติด้วย `saveApprovalInfo()`
  - ส่ง Flex Message ผลอนุมัติ พร้อมปุ่มสำหรับช่าง

- `action=reject&type=repair&id=REP...`
  - แจ้งข้อความปฏิเสธใน LINE
  - จากโค้ดปัจจุบันไม่ได้เปลี่ยนสถานะในชีท

- `action=approve&type=po&id=PO...`
  - ตรวจสิทธิ์ admin
  - ตรวจสถานะต้องเป็น `รออนุมัติ` หรือ `ออกPO`
  - เปลี่ยนสถานะเป็น `อนุมัติแล้ว`
  - บันทึกผู้อนุมัติ
  - สร้าง PDF ด้วย `generateAndSavePOPdf(id)`
  - ส่ง Flex Message พร้อมลิงก์ PDF

- `action=reject&type=po&id=PO...`
  - แจ้งข้อความปฏิเสธใน LINE
  - จากโค้ดปัจจุบันไม่ได้เปลี่ยนสถานะในชีท

### LINE Postback: ช่างรายงานงาน

Action ที่ช่างใช้ได้โดยไม่ต้องเป็น admin:

- `tech_done`
  - เปลี่ยนสถานะ repair เป็น `เสร็จแล้ว`
  - ส่งข้อความยืนยัน

- `tech_waiting`
  - เปลี่ยนสถานะ repair เป็น `รออะไหล่`
  - ส่งข้อความยืนยัน

- `tech_report`
  - ตั้ง pending session ใน `PropertiesService`
  - ให้ช่างพิมพ์รายละเอียดงานในข้อความถัดไป

### Pending Report Session

- `setPendingReport(lineUserId, refId)` บันทึกว่า user คนนี้กำลังจะรายงานงานไหน
- `getPendingReport(lineUserId)` อ่าน pending session และหมดอายุใน 10 นาที
- `clearPendingReport(lineUserId)` ล้าง session

เมื่อ LINE ได้ข้อความถัดไปจาก user ที่มี pending:

1. เรียก `handleTechReport(replyToken, lineUserId, refId, report)`
2. บันทึกรายงานลงคอลัมน์ `repairSummary`
3. เปลี่ยนสถานะเป็น `เสร็จแล้ว`
4. ส่ง Flex ยืนยันการบันทึก

### LINE Text Command

ใน `doPost(e)` มีการ parse ข้อความที่พิมพ์ใน LINE เช่น:

- รายงานงานด้วยรูปแบบ `รายงาน REP...: ข้อความ`
- ขออนุมัติ PO ด้วยข้อความที่มีเลข `PO...`
- ขออนุมัติใบซ่อมด้วยข้อความที่มีเลข `REP...`
- ส่งสถานะ PO เพื่อดึง Flex ที่มีสถานะ/ลิงก์ PDF

### LINE Logging

- `callLineAPI()` ส่ง request ไป LINE และเรียก `logLineMessage()`
- `logLineMessage()` บันทึกลง `LineLog` ว่าเป็น Push หรือ Reply
- `logLineWorkflow()` บันทึก debug ลง `LineDebugLog`
- `getLineQuotaStatus()` อ่าน quota และ usage จาก LINE API
- `getLineLogs()` อ่าน log ไปแสดงหน้า Line Log
- `clearLineLogs()` ล้าง log

## 10. PDF ใบสั่งซื้อ

`PDF.gs`

### สร้าง PDF

`generateAndSavePOPdf(poNo)`

1. อ่าน PO จาก `PurchaseOrders`
2. อ่าน items จาก `POItems`
3. อ่าน settings บริษัทจาก `Settings`
4. หา signature ของผู้อนุมัติ
5. แปลง logo/stamp/signature จาก Drive URL เป็น base64
6. embed ฟอนต์ Sarabun ผ่าน `fetchGoogleFontAsBase64()`
7. สร้าง HTML ด้วย `buildPOHtmlForPdf(...)`
8. แปลง HTML เป็น PDF blob
9. บันทึก PDF ลง Google Drive
10. อัปเดต `pdfUrl` กลับเข้า row ของ PO

### Helper สำคัญ

- `formatDate(d)` แปลงวันที่เป็นรูปแบบไทย
- `fmtNum(n)` format ตัวเลข 2 ตำแหน่ง
- `imageUrlToBase64(url)` แปลงรูปจาก URL/Drive เป็น base64
- `convertDriveUrlForPdf(url)` แปลง Drive URL เป็น direct view URL
- `buildPOHtmlForPdf(...)` สร้าง HTML สำหรับ PDF รวม header, supplier, table, notes, signature, footer

## 11. ข้อมูลรถ

`Code.gs`

- `getBusPlates()` คืนทะเบียนและ chassis สำหรับ dropdown
- `getFullBuses()` คืนข้อมูลรถเต็ม
- `saveBus(bus)` เพิ่ม/แก้ไขข้อมูลรถ โดยใช้ทะเบียนเดิม `oldPlate` ถ้ามีการเปลี่ยนทะเบียน
- `deleteBus(plate)` ลบรถ

Frontend ใช้ข้อมูลรถเพื่อ:

- เลือกทะเบียนในใบแจ้งซ่อม/PO
- ดูสถานะรถจากงานซ่อมที่ยังไม่เสร็จ
- แจ้งเตือนวันตรวจสภาพ/ทะเบียน/ประกันใกล้หมด

## 12. ร้านค้า

`Code.gs`

- `getShops()` อ่านร้านค้า
- `saveShop(shop)` เพิ่ม/แก้ไขร้านค้า
- `deleteShop(id)` ลบร้านค้า

Frontend ใช้ร้านค้าในหน้า PO เพื่อเติมชื่อ, ที่อยู่, เลขภาษี, เบอร์โทร และข้อมูลประกอบใบสั่งซื้อ

## 13. Oil Template

ใช้สำหรับจำ template อะไหล่ตามทะเบียนรถและโปรแกรม เช่น S, M, S2, L

Backend:

- `getOilTemplates()`
- `getOilTemplateItems(program, plate)`
- `saveOilTemplate(plate, program, items)`
- `getOilTemplateByPlateProgram(plate, program)`
- `getOilProgramsByPlate(plate)`

Frontend:

- โหลดทะเบียนรถ
- เลือกโปรแกรม
- เลือกอะไหล่จาก stock
- บันทึก template
- โหลด template กลับมาใช้ซ้ำตอนสร้างรายการ

## 14. Dashboard, Summary และ Notifications

### Dashboard

`Js.html`

`loadDashboard()` ดึงข้อมูลจาก backend แล้วสรุป:

- งานซ่อมรอดำเนินการ/กำลังซ่อม/รออะไหล่/ค้างทั้งหมด
- PO รออนุมัติ
- stock ต่ำกว่าขั้นต่ำ
- วันหมดอายุของข้อมูลรถ เช่น ตรวจสภาพ/ทะเบียน/ประกัน

### Weekly Summary

`Code.gs`

`getWeeklySummary(weekOffset)`

- คำนวณช่วงสัปดาห์จันทร์-อาทิตย์
- งานที่เปิดในสัปดาห์
- งานที่เสร็จในสัปดาห์
- งานค้างทั้งหมด
- งานค้างข้ามสัปดาห์
- สรุปตามสถานะ
- รถที่มีงานซ่อมบ่อยที่สุดในสัปดาห์

### Expense Summary

`getExpenseSummary(filter)`

รวมค่าใช้จ่ายจาก 2 แหล่ง:

1. PO ที่สถานะ `รับของแล้ว`
2. รายการตัด stock แบบ manual (`OUT-MANUAL`)

ผลลัพธ์ประกอบด้วย:

- ยอดรวม
- จำนวนรายการ
- สรุปตามทะเบียนรถ
- สรุปตามร้านค้า
- สรุปตามเดือน
- รายละเอียดรายการทั้งหมด

### Notifications

`getNotifications()`

สร้างรายการแจ้งเตือนจาก:

- PO อนุมัติแล้ว รอพิมพ์
- งานซ่อมอนุมัติแล้ว/กำลังซ่อม
- PO รออนุมัติ
- อะไหล่ใกล้หมด

Frontend เก็บสถานะอ่านแล้วไว้ใน `localStorage`

## 15. Frontend Logic

ไฟล์หลักคือ `Js.html`

### State หลัก

ตัวแปร global สำคัญ:

- `currentUser`
- `allRepairs`
- `allPOs`
- `currentPOList`
- `selectedPONos`
- `allStock`
- `allBuses`
- `allShops`
- `allNotifications`
- `repairPartRows`
- `poItemRows`
- `deductRows`
- `oilTemplateRows`

### Login และ Init

- `doLogin()` เรียก backend `login`
- `initApp()` ตั้งค่า UI ตาม user/role, โหลด dashboard, repair, stock, PO, notifications
- ถ้า role ไม่ใช่ admin จะซ่อน element ที่มี class `admin-only`

### Navigation

`navigateTo(page)`

- ซ่อนทุกหน้า `[id^=page-]`
- เปิดหน้าที่เลือก
- set active menu ทั้ง sidebar และ mobile nav
- trigger load function ของหน้านั้น เช่น dashboard, repairs, PO, stock, users, settings

### Repair UI

Frontend ทำหน้าที่:

- โหลดรายการซ่อม
- filter/search
- เปิด modal สร้าง/แก้ไข
- เพิ่มรายการอะไหล่
- เลือกอะไหล่จาก stock picker
- save ผ่าน `google.script.run.saveRepair(...)`
- ส่งเข้า LINE ผ่าน `sendRepairToLine` หรือ `forceSendRepairToLine`

### PO UI

Frontend ทำหน้าที่:

- โหลด PO และ items
- สร้าง/แก้ไข PO
- เลือกร้านค้า
- เลือกอะไหล่จาก stock picker
- คำนวณยอดรวม, ส่วนลด, VAT ตาม `vatType`
- ส่ง PO เข้า LINE ทีละใบหรือหลายใบ
- print preview และ mark printed ด้วย `markPOAsPrinted(poNo)`

### Stock UI

Frontend ทำหน้าที่:

- แสดง stock table/cards
- filter และ preset เช่น in stock, low stock, out of stock
- เพิ่ม/แก้ไข/ลบอะไหล่
- ตัด stock manual
- ยกเลิกการตัด stock
- ดูประวัติอะไหล่จาก `StockLog`

### Settings UI

Frontend ทำหน้าที่:

- แก้ข้อมูลบริษัท
- preview logo/stamp จาก Drive URL
- จัดการ settings key/value อื่น ๆ
- บันทึกผ่าน `saveSettings`

### Line Log UI

Frontend ทำหน้าที่:

- โหลด `getLineLogs()`
- โหลด quota ด้วย `getLineQuotaStatus()`
- filter log
- clear log ด้วย `clearLineLogs()`

## 16. การสร้างเลขเอกสาร

ระบบสร้างเลขตามปี/เดือนปัจจุบัน:

- Repair: `REPYYMM####`
- PO: `POYYMM####`
- Part: `PRTYYMM###`

ตัวเลขท้ายจะหา max จากข้อมูลเดิมในชีท แล้วบวก 1

## 17. Guard / Validation สำคัญ

Logic ป้องกันข้อผิดพลาดที่มีอยู่:

- ไม่ให้แก้ไขใบซ่อมที่สถานะ `เสร็จแล้ว`
- ไม่ให้ส่งอนุมัติซ้ำถ้ามี `lineSentAt`
- ไม่ให้ส่งใบซ่อมเข้า LINE ถ้าไม่ได้อยู่สถานะ `รอดำเนินการ`
- ไม่ให้ส่ง PO เข้า LINE ถ้าไม่ได้อยู่สถานะ `รออนุมัติ` หรือ `ออกPO`
- ไม่ให้ลบ PO ที่ `อนุมัติแล้ว` หรือ `รับของแล้ว`
- ป้องกันตัด stock ซ้ำจาก repair เดิมด้วย `StockLog`
- LINE approval ต้องเป็น user role `admin`
- Pending report หมดอายุใน 10 นาที

## 18. จุดที่ควรระวังจากโค้ดปัจจุบัน

1. `initializeSheets()` กำหนด header ของ `Repairs` และ `RepairParts` บางจุดไม่ตรงกับรูปแบบที่ฟังก์ชันใช้งานจริง  
   ตัวอย่าง `getRepairParts()` อ่าน `r[2]` เป็น `partName` และ `r[3]` เป็น `qty` แต่ header ใน `initializeSheets()` ของ `RepairParts` มีเพียง `RepairNo, PartName, Qty` ขณะที่ `saveRepair()` เขียนเป็น `RepairNo, No, PartName, Qty`

2. สถานะในโค้ดมีหลายคำที่ต้องสะกดให้ตรงกันทุกจุด เช่น `กำลังซ่อม`, `กำลังดำเนินการ`, `อนุมัติซ่อม`, `รอซ่อม` ถ้า frontend/backend ใช้ไม่ตรงกัน อาจทำให้ filter หรือ badge เพี้ยน

3. การ `reject` ผ่าน LINE ตอนนี้ส่งข้อความแจ้งปฏิเสธ แต่ไม่ได้บันทึกสถานะปฏิเสธลงชีท

4. การ mark งานซ่อมเป็น `เสร็จแล้ว` จะตัด stock ทันที ถ้าอะไหล่ใน `RepairParts` ไม่ตรงชื่อกับ `Stock` จะไม่ถูกตัด

5. `manualDeductStock()` ใช้ ref เป็นข้อความภาษาไทยแล้ว `getExpenseSummary()` parse ด้วย regex ตาม key ภาษาไทย ถ้า format ref เปลี่ยน รายงานค่าใช้จ่าย manual อาจอ่านไม่ได้

6. `lineSentAt`, `approvedBy`, `approvedAt`, `printedAt`, `pdfUrl` มีการสร้าง column แบบ dynamic บางจุด ควรใช้ `ensurePOColumns()` และ schema ให้ตรงกันเสมอ

7. Project มี Web App access เป็น `ANYONE_ANONYMOUS` ใน `appsscript.json` จึงควรพึ่ง login/role ในระบบให้รัดกุม และระวังการ expose URL

## 19. ไฟล์หลักและหน้าที่

| ไฟล์ | หน้าที่ |
|---|---|
| `Code.gs` | Backend หลัก, CRUD, stock, PO, repair, summary, settings, users |
| `Line.gs` | LINE webhook, Flex Message, approval workflow, LINE logs |
| `PDF.gs` | สร้าง PDF ใบสั่งซื้อและบันทึกลง Drive |
| `Js.html` | JavaScript ฝั่งหน้าเว็บทั้งหมด |
| `Css.html` | Style ของระบบ |
| `Index.html` | Shell หลักของ Web App |
| `page_dashboard.html` | หน้า dashboard |
| `page_repairs.html` | หน้าแจ้งซ่อม |
| `page_po.html` | หน้า PO |
| `page_stock.html` | หน้าสต็อก |
| `page_summary.html` | หน้ารายงานค่าใช้จ่าย |
| `page_buses.html` | หน้าข้อมูลรถ |
| `page_shops.html` | หน้าร้านค้า |
| `page_users.html` | หน้าผู้ใช้ |
| `page_settings.html` | หน้าตั้งค่า |
| `page_oiltemplate.html` | หน้า template น้ำมัน/อะไหล่ |
| `page_linelog.html` | หน้า LINE log/quota |
| `sidebar.html` | เมนูด้านข้าง |
| `topbar.html` | แถบบน |

## 20. Netlify + Supabase Migration Layer

นอกจากโค้ด Google Apps Script เดิม โปรเจกต์นี้มีไฟล์สำหรับย้ายระบบไปทำงานบน Netlify และ Supabase ด้วย โดยแนวคิดคือยังใช้หน้าเว็บเดิมให้มากที่สุด แต่เปลี่ยน backend จาก `google.script.run`/Google Sheets ไปเป็น Supabase และ Netlify Functions

### ไฟล์ config และ build

| ไฟล์ | หน้าที่ |
|---|---|
| `package.json` | กำหนด dependency และ script `npm run dev` |
| `netlify.toml` | ตั้งค่า Netlify ให้ publish จาก `public` และใช้ serverless functions จาก `functions` |
| `build.js` | compile `Index.html` กับ `include(...)` ของ Apps Script ให้กลายเป็น static HTML ใน `public/index.html` |
| `public/supabase-bridge.js` | จำลอง `google.script.run` ให้เรียก Supabase แทน |

`build.js` จะทำงานหลัก ๆ ดังนี้:

1. อ่าน `Index.html`
2. หา syntax `<?= include('...'); ?>`
3. แทนที่ด้วยเนื้อหาจากไฟล์ `.html` จริง เช่น `Css.html`, `Js.html`, `page_*.html`
4. ถ้า include เป็น `Js.html` จะใส่ `<script src="supabase-bridge.js"></script>` เพิ่มก่อน
5. inject Supabase SDK CDN และค่า `SUPABASE_URL`, `SUPABASE_ANON_KEY`
6. เขียนผลลัพธ์ไปที่ `public/index.html`

## 21. Supabase Database Schema

`supabase_schema.sql` สร้างตาราง PostgreSQL ที่แทน Google Sheets เดิม

ตารางหลัก:

- `profiles`: ผู้ใช้, role, LINE User ID, signature
- `buses`: ข้อมูลรถ
- `shops`: ร้านค้า
- `stock`: สต็อกอะไหล่
- `repairs`: ใบแจ้งซ่อม
- `repair_parts`: รายการอะไหล่ในงานซ่อม
- `purchase_orders`: ใบสั่งซื้อ
- `po_items`: รายการสินค้าใน PO
- `stock_logs`: ประวัติรับเข้า/ตัดออก
- `oil_templates`: template อะไหล่/น้ำมัน
- `settings`: key/value config
- `line_logs`: log การทำงาน LINE

Storage bucket:

- `signatures`
- `company-assets`
- `pdf-orders`

หมายเหตุ: schema ปัจจุบันปิด RLS ทุกตาราง เพื่อให้ทำงานคล้าย Google Sheets ที่ backend เข้าถึงตรงได้ง่าย แต่ถ้าขึ้น production จริงควรทบทวนเรื่องสิทธิ์และ policy อีกครั้ง

## 22. Supabase Bridge ฝั่ง Frontend

`public/supabase-bridge.js` เป็น compatibility layer ที่ทำให้โค้ดเดิมใน `Js.html` ยังเรียกแบบนี้ได้:

```js
google.script.run
  .withSuccessHandler(...)
  .withFailureHandler(...)
  .someFunction(...)
```

แต่เบื้องหลังเปลี่ยนเป็น Supabase query แทน

สิ่งที่ bridge ทำ:

- สร้าง Supabase client จาก `window.SUPABASE_URL` และ `window.SUPABASE_ANON_KEY`
- สร้าง class `ScriptRunBridge`
- รองรับ pattern `withSuccessHandler` / `withFailureHandler`
- map function เดิมบางส่วน เช่น login, settings, users, shops, buses ไปยัง table Supabase

ตัวอย่าง mapping:

- `login(username, password)` อ่านจาก `profiles`
- `getUsers()` อ่านจาก `profiles`
- `saveUser(user)` insert/update `profiles`
- `getShops()` อ่านจาก `shops`
- `saveShop(shop)` insert/update `shops`
- `getFullBuses()` อ่านจาก `buses`

## 23. Netlify Functions

โฟลเดอร์ `functions` เป็น backend serverless สำหรับงานที่ไม่ควรทำจาก frontend ตรง ๆ เช่น LINE, PDF, admin auth

### `functions/line-webhook.js`

เป็น webhook หลักของ LINE บน Netlify

ทำงานคล้าย `Line.gs` เดิม:

1. รับ `POST` จาก LINE
2. วน events
3. ถ้าเป็น `postback` เรียก `handlePostback`
4. ถ้าเป็น text message เรียก `handleTextMessage`
5. ใช้ Supabase service role key เพื่ออ่าน/เขียนข้อมูล

Logic สำคัญ:

- ช่างกด `tech_done` เพื่อเปลี่ยนงานเป็น `เสร็จแล้ว`
- ช่างกด `tech_waiting` เพื่อเปลี่ยนงานเป็น `รออะไหล่`
- ช่างกด `tech_report` เพื่อเปิด pending report
- admin กดอนุมัติ repair แล้วเปลี่ยนเป็น `กำลังซ่อม`
- admin กดอนุมัติ PO แล้วเปลี่ยนเป็น `อนุมัติแล้ว`
- หลังอนุมัติ PO จะเรียก `generate-pdf` เพื่อสร้าง PDF แล้วส่ง Flex กลับ LINE

### `functions/line-send-repair.js`

ส่งใบแจ้งซ่อมเข้า LINE group

ขั้นตอน:

1. รับ `repairNo` จาก query string
2. อ่าน repair จาก Supabase table `repairs`
3. อ่าน `LINE_GROUP_ID_SERVICE` จาก `settings`
4. สร้าง Repair Flex Message
5. Push เข้า LINE group
6. บันทึกเวลาส่งไว้ใน `settings` key รูปแบบ `linesent_repair:{repairNo}`

### `functions/line-send-po.js`

ส่ง PO เข้า LINE group

ขั้นตอน:

1. รับ `poNo`
2. อ่าน PO จาก `purchase_orders`
3. อ่าน items จาก `po_items`
4. อ่าน `LINE_GROUP_ID_PO`
5. สร้าง PO Flex Message
6. Push เข้า LINE group
7. อัปเดต `line_sent_at` ใน `purchase_orders`

### `functions/generate-pdf.js`

สร้าง PDF ใบสั่งซื้อบน Netlify ด้วย `pdfkit`

ขั้นตอน:

1. รับ `poNo`
2. อ่าน PO จาก `purchase_orders`
3. อ่าน items จาก `po_items`
4. อ่าน settings จาก `settings`
5. ดาวน์โหลดฟอนต์ Sarabun จาก Google Fonts
6. สร้าง PDF ด้วย `PDFDocument`
7. ดึง logo/stamp/signature จาก URL ถ้ามี
8. upload PDF ไป Supabase Storage bucket `pdf-orders`
9. เอา public URL กลับมาอัปเดต `purchase_orders.pdf_url`

### `functions/admin-create-user.js`

ใช้ Supabase Auth Admin API สร้างผู้ใช้

- รับ `email`, `password`, `username`, `name`, `role`
- เรียก `supabase.auth.admin.createUser`
- confirm email ให้ทันที
- คืน user id

### `functions/admin-delete-user.js`

ใช้ Supabase Auth Admin API ลบผู้ใช้

- รับ `id` จาก query string
- เรียก `supabase.auth.admin.deleteUser(id)`

## 24. Migration Helper

`migration_helper.gs` เป็นสคริปต์ Google Apps Script สำหรับย้ายข้อมูลจาก Google Sheets ไป Supabase

Flow หลัก:

1. ตั้งค่า `SUPABASE_URL` และ `SUPABASE_SERVICE_ROLE_KEY`
2. เรียก `runDataMigration()`
3. เก็บชุด key ที่ valid ก่อน เช่น plate, repair no, PO no เพื่อเลี่ยง foreign key error
4. migrate ตามลำดับ dependency:
   - settings
   - buses
   - shops
   - stock
   - profiles
   - repairs
   - repair parts
   - purchase orders
   - PO items
   - oil templates
5. มี helper สำหรับ upload ไฟล์จาก Google Drive ไป Supabase Storage เช่น signature/company assets/PDF

## 25. Test/Utility

`test-db.js`

- ใช้ `.env`
- ต่อ Supabase ด้วย anon key
- อ่าน `purchase_orders`
- สรุปจำนวน PO ที่มี `pdf_url` เป็น Google Drive, Supabase Storage หรือว่าง
- ใช้ตรวจสถานะ migration PDF URL

## 26. ภาพรวมสถานะโปรเจกต์ล่าสุด

ตอนนี้โปรเจกต์มี 2 แนวทางอยู่พร้อมกัน:

1. Google Apps Script เดิม  
   ใช้ `Code.gs`, `Line.gs`, `PDF.gs`, Google Sheets, Google Drive และ Web App ของ Apps Script

2. Netlify + Supabase ใหม่  
   ใช้ `build.js` compile หน้าเดิมเป็น static site, ใช้ `supabase-bridge.js` แทน `google.script.run`, ใช้ Netlify Functions สำหรับ LINE/PDF/Admin และใช้ Supabase เป็น database/storage

แนวทาง migration ที่เห็นจากไฟล์คือพยายามรักษา frontend เดิมไว้ แล้วค่อย ๆ map function เดิมไปยัง Supabase เพื่อให้เปลี่ยน backend โดยไม่ต้อง rewrite UI ทั้งหมด

## 27. จุดที่ควรตรวจเพิ่มสำหรับฝั่ง Supabase/Netlify

1. ไฟล์ `supabase_schema.sql` มี comment ว่า profiles trigger จะสร้าง profile จาก Supabase Auth แต่ใน schema ที่อ่านช่วงต้นยังไม่เห็น trigger/function นั้นชัดเจน ควรตรวจว่ามี script เพิ่มในช่วงท้ายหรือยัง

2. `public/supabase-bridge.js` น่าจะยัง map function ไม่ครบเท่า `Code.gs` ทั้งหมด ต้องไล่เทียบกับทุก function ที่ `Js.html` เรียก

3. หลายไฟล์มีข้อความภาษาไทยที่แสดงเป็น mojibake ใน terminal ถ้า deploy แล้วภาษาเพี้ยน ควรตรวจ encoding ให้เป็น UTF-8 ทุกไฟล์

4. `functions/line-send-repair.js` เก็บ sent timestamp ของ repair ใน table `settings` แทนคอลัมน์ใน `repairs` ขณะที่ PO เก็บใน `purchase_orders.line_sent_at` ควรกำหนดแนวทางเดียวกัน

5. `line-webhook.js` ยังเป็นเวอร์ชันย่อเมื่อเทียบกับ `Line.gs` เดิม บาง helper/Flex/stock sync อาจยังไม่ครบ

6. `generate-pdf.js` ใช้การ fetch font จาก internet ตอน runtime ถ้า network ช้าหรือ Google Fonts มีปัญหา การสร้าง PDF อาจ fail หรือช้า ควรพิจารณา bundle font หรือ cache

7. `package.json` มีทั้ง `pdf-lib` และ `pdfkit` แต่ function ใช้ `pdfkit` เป็นหลัก อาจมี dependency ที่ไม่ได้ใช้

8. `test-db.js` เป็นไฟล์ใหม่ที่ยัง untracked ใน git ตอนตรวจล่าสุด ถ้าต้องการเก็บไว้ควร add/commit ถ้าเป็นไฟล์ทดลองควรพิจารณา `.gitignore`
