# API ติดตามเปลี่ยนถ่าย: เตรียม backend ระยะที่ 1

## สิ่งที่เปิดและสิ่งที่ยังปิด

- `functions/oil-tracking.js` มี `createHandler(repository)` สำหรับทดสอบ/inject repository
- export `handler` ที่ Netlify/run-local เรียกจริง **คืน 503 เสมอ** พร้อม code
  `OIL_TRACKING_NOT_CONNECTED` ไม่สร้าง Supabase client ไม่อ่านคีย์ ไม่ติดต่อฐานข้อมูล
- ไม่มี environment flag ที่เปิดข้อมูลจริงได้โดยไม่แก้โค้ด
- ตามโจทย์ล่าสุด หน้ารถ → ติดตามเปลี่ยนถ่ายอ่านทะเบียน Feet/ไมล์ HR-POS จริงแบบ read-only
  ผ่าน endpoint แยก ดู `docs/oil-current-mileage.md` ไม่มีการเปิด API บันทึกจริงโดยเงียบ ๆ
- RPC adapter รับ client จาก server เท่านั้น ยังไม่มีจุดใดในแอปสร้างหรือเรียก adapter นี้จริง
- ไม่เพิ่ม Supabase key ฝั่ง browser ไม่เปลี่ยน repair/stock/PO/LINE หรือ HR-POS

## โครงสร้าง

| ไฟล์ | หน้าที่ |
| --- | --- |
| `functions/oil-tracking.js` | ตรวจ session/สิทธิ์, GET list/history/audit/settings, POST commands |
| `functions/lib/oil-tracking-service.js` | ตรวจ input, สร้าง append-only mutation และ audit จาก actor/เวลาฝั่ง server |
| `functions/lib/oil-tracking-memory.js` | ฐานข้อมูลจำลอง มี commit queue, rollback และ idempotency ในหน่วยความจำ |
| `functions/lib/oil-tracking-rpc-repository.js` | contract ของ PostgreSQL snapshot/request/commit RPC; ยังไม่ต่อฐานจริง |
| `run-oil-api-demo.js` | HTTP sandbox เฉพาะ loopback ไม่โหลด .env หรือ SDK ฐานข้อมูล |
| `sql/oil-tracking-phase1.DRAFT.sql` | ตารางและ RPC ฉบับร่าง ยังไม่รัน มี guard ภายใน transaction |

## วิธีทดสอบ API แบบไม่แตะข้อมูลจริง

```powershell
npm run test:oil-api
```

ชุดแรกทดสอบ handler ด้วย signed mock sessions และ memory repository
ชุดที่สองเปิด HTTP server เฉพาะ 127.0.0.1 บนพอร์ตชั่วคราว ทดสอบแล้วปิดเอง
ไม่มี external network และไม่รัน SQL

หากต้องการทดลอง HTTP ด้วยตัวเอง:

```powershell
npm run local:oil-api
```

ใช้ URL ที่ terminal แสดง ปกติ `http://localhost:5191`
นี่เป็น **API sandbox แยกจากแอป 5173 และหน้า Demo 5190**
บันทึกเฉพาะ memory ใน process ปิด server แล้วข้อมูลหาย ไม่มีไฟล์ฐานข้อมูลถาวร
session ที่ออกจาก `/demo/session` ใช้ได้เฉพาะ sandbox process นี้ หมดอายุใน 1 ชั่วโมง
และไม่ใช่บัญชี/สิทธิ์จริง ไม่สามารถใช้ล็อกอินแอปเดิมได้

ตัวอย่าง PowerShell (ทุกข้อมูลเป็นข้อมูลจำลอง):

```powershell
$base = 'http://localhost:5191'
$session = Invoke-RestMethod "$base/demo/session" -Method Post -ContentType 'application/json' -Body '{"role":"admin"}'
$headers = @{ Authorization = "Bearer $($session.token)" }
$list = Invoke-RestMethod "$base/.netlify/functions/oil-tracking?pageSize=25" -Headers $headers
$vehicle = $list.records | Where-Object { $_.vehicle.plate -eq '30-1002 สข' }
$requestId = [guid]::NewGuid().ToString()
$body = @{
  action = 'reading'
  requestId = $requestId
  expectedRevision = $list.revision
  input = @{
    vehicleId = $vehicle.vehicle.id
    date = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'SE Asia Standard Time').ToString('yyyy-MM-dd')
    odometer = 1000
    note = 'ทดสอบ API จำลอง'
  }
} | ConvertTo-Json -Depth 5
Invoke-RestMethod "$base/.netlify/functions/oil-tracking" -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

คำตอบต้องมี `mode: local-api-mock` และ `persisted: false` เสมอใน sandbox
ลอง POST body เดิมซ้ำจะได้ event ID เดิมและ `replayed: true`
เลือก role `user` หรือ `manager` จาก `/demo/session` เพื่อทดสอบดูได้แต่บันทึกไม่ได้
Origin/Host นอก localhost/127.0.0.1 ถูกปฏิเสธ ไม่มี CORS เปิดให้เว็บไซต์อื่น
ไม่ให้บริการไฟล์ .env หรือ function อื่น เช่น LINE/PO

## HTTP Contract

ทุกคำขอ API ต้องมี `Authorization: Bearer <signed-session>`
สิทธิ์ตาม custom session ของระบบเดิม: Admin เขียนได้; User/Manager อ่านอย่างเดียว
actor, role, source, sequence และ recordedAt จาก client ไม่ได้รับอนุญาตให้แก้ไข

### GET

- `?action=list&search=30-5115&status=near&page=1&pageSize=25`
  คืนทะเบียน/กลุ่มรอบ ไมล์/วันล่าสุด ครบกำหนด คงเหลือ สถานะ และ counts
- `?action=history&vehicleId=<uuid>&kind=services&page=1&pageSize=25`
  หรือ `kind=readings` คืนทุกฉบับ พร้อม `active: true/false`
- `?action=audit&vehicleId=<uuid>` คืน audit ของรถและการเปลี่ยนนโยบาย
- `?action=settings` คืนเกณฑ์ปัจจุบัน
- จำนวนต่อหน้า 1–100 ไม่ตัดผลลัพธ์เงียบ ๆ ทุกคำตอบมี `revision`

### POST

```json
{
  "action": "service",
  "requestId": "d8b24c97-2339-41bf-af05-241af0f37e11",
  "expectedRevision": 0,
  "input": {
    "vehicleId": "900d6dad-dc59-42cd-b991-ea247523a9ee",
    "date": "2026-11-01",
    "odometer": 1000,
    "program": "S2",
    "repairRef": "",
    "note": "วันที่เปลี่ยนจริง"
  }
}
```

| action | input |
| --- | --- |
| `service` | vehicleId, date, odometer, program S/M/S2/L, repairRef?, note? |
| `reading` | vehicleId, date, odometer, note?; source ถูกกำหนดเป็น manual |
| แก้ service/reading | action เดิม เพิ่ม supersedes ของฉบับ active และ reason ห้ามว่าง |
| `registerVehicle` | plate, type (bus/minibus/van หรือว่าง), reason |
| `classify` | vehicleId, type, reason |
| `configure` | settings ครบทั้ง 4 กลุ่มและ 3 เกณฑ์, reason |

การลงทะเบียนรถเป็นข้อมูลใหม่ในโมดูลติดตามเท่านั้น **ยังไม่อ่าน/เพิ่ม/แก้ buses เดิม**
ไม่มี import อัตโนมัติจาก Local Demo และไม่มีอนุมานประวัติจากใบซ่อม
ต้องออกแบบ mapping รถเดิมให้ชัดก่อนต่อฐานจริง

## ความถูกต้องและธุรกรรม

1. ตรวจ token ฝั่ง server แล้วใช้ id/name/role ที่ผ่านการลงนามเท่านั้น
2. ปฏิเสธ User/Manager ก่อนเข้าการเขียน
3. ตรวจ JSON, allowlist fields, ขนาดคำขอไม่เกิน 64 KiB, UUID และ revision
4. ตรวจ request receipt ของ actor+requestId; fingerprint ใช้ action+input ที่จัด key แล้ว
5. อ่าน snapshot เดียว ตรวจวัน/ไมล์ โปรแกรม ฉบับ active และ timeline
6. commit ตรวจ idempotency ซ้ำภายใน lock แล้ว compare-and-swap global revision
7. mutation, audit, receipt และ revision สำเร็จหรือย้อนกลับพร้อมกัน

global revision ใช้ร่วมกันทั้งโมดูลในระยะนี้ แม้แก้รถคนละคันก็อาจได้ 409
เป็น trade-off สำหรับความง่ายและความปลอดภัยในเฟสแรก
ผู้ใช้ต้องรีเฟรชก่อนส่งคำขอใหม่ ไม่ retry ด้วย revision ใหม่โดยอัตโนมัติ
หากเครือข่ายหลุดหลังบันทึก ให้ retry **requestId และ action/input เดิม**
แม้ expectedRevision เก่าก็ได้ผลลัพธ์เดิม ไม่เพิ่มประวัติซ้ำ
หากเปลี่ยนข้อมูล ให้ใช้ requestId ใหม่ คำขอ ID เดิมแต่ข้อมูลต่างกันได้ 409
ระบบยังคงตรวจสิทธิ์ทุกครั้งก่อน replay

HTTP errors: 400 input ผิด, 401 session ผิด/หมดอายุ, 403 ไม่มีสิทธิ์,
404 ไม่พบรถ, 409 revision/idempotency conflict, 413 ข้อมูลใหญ่เกิน,
503 ยังไม่ต่อฐาน/โครงสร้างไม่พร้อม/ไม่ทราบว่าธุรกรรมสำเร็จหรือไม่
หาก commit ตอบไม่ถึง client ห้ามตีความ 503 ว่า rollback แล้วเสมอ
ให้ retry requestId เดิมเพื่ออ่าน receipt อย่างปลอดภัย

## SQL และงานที่ยังต้องผ่านก่อนเชื่อมจริง

SQL ร่างเพิ่ม 6 ตาราง เปิด RLS ปิด anon/authenticated และให้ service_role
ใช้ RPC เฉพาะ server ไม่มี policy ที่ใช้ custom app token เป็น Supabase Auth token
events/policies/audit/receipts ให้ SELECT+INSERT เท่านั้น ไม่ให้ UPDATE/DELETE
global revision และข้อมูลกลุ่มรถแก้ได้ผ่าน transaction ฝั่ง server
snapshot เป็น single SQL statement ป้องกันอ่านตารางคนละ revision
receipt ไม่มีการล้างอัตโนมัติ เพื่อไม่ให้ retry เก่ากลายเป็นรายการใหม่

**ยังไม่ได้ทดสอบ RPC บน PostgreSQL จริง** ทดสอบแล้วเฉพาะ adapter contract
และ behavior ของ memory transaction ต้องยืนยันบน staging ก่อน:

- SQL syntax/permissions/RLS/grants และการ map JSON จาก PostgreSQL ไป shared model
- failure ระหว่าง mutation/audit/receipt ต้อง rollback จริงทั้ง transaction
- concurrent writes/retries และ single-snapshot consistency
- หน่วยความจำ/เวลาตอบเมื่อประวัติมาก: snapshot ปัจจุบันอ่านทั้งโมดูลเพื่อ validate
  หากข้อมูลโต ต้องเปลี่ยนเป็น per-vehicle transaction โดยคง invariant เดิม
- นโยบายเปลี่ยนป้ายทะเบียน/stable ID, แก้เลขไมล์ผิด และเปลี่ยนเรือนไมล์จริง
- ตรวจสถานะบัญชี/role revocation: ปัจจุบันยึด role ใน signed token ตามระบบเดิม
  ถ้าต้องเพิกถอนทันทีต้องออกแบบ server profile check เพิ่มก่อนใช้งานจริง
- ต่อ UI เป็น API mode อย่างชัดเจนพร้อมข้อความสถานะ ไม่ใช้ Demo fallback เมื่อ API ล้มเหลว

การรัน SQL, ต่อ Supabase, เปลี่ยน UI เป็นบันทึกจริง และ Deploy ต้องได้รับอนุมัติแยก
ยังไม่ทำระยะ 2/3 และไม่เพิ่ม background jobs หรือ LINE notifications
