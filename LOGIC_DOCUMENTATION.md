# Logic Documentation - Feet Management

เอกสารนี้อธิบายโครงสร้างระบบเวอร์ชันปัจจุบันที่ใช้ Supabase และ Netlify เท่านั้น

## Architecture

- Static frontend: `Index.html`, `Css.html`, `Js.html`, `page_*.html`, `sidebar.html`, `topbar.html`
- Build script: `build.js` compile HTML includes ไปที่ `public/index.html`
- Client data layer: `public/supabase-bridge.js`
- Serverless backend: `functions/*.js`
- Database: Supabase tables จาก `supabase_schema.sql`
- Storage buckets: `signatures`, `company-assets`, `pdf-orders`
- Hosting and functions: Netlify ตาม `netlify.toml`

## Build And Deploy

Netlify ใช้ `netlify.toml`

```toml
[build]
  command = "node build.js"
  publish = "public"
  functions = "functions"
```

ขั้นตอน deploy ปกติคือ push ไปที่ GitHub branch `main` แล้ว Netlify build/deploy อัตโนมัติ

## Frontend Flow

หน้าเว็บยังใช้รูปแบบ source HTML แยกไฟล์เพื่อให้แก้ไขง่าย:

- `Index.html` เป็น entry point
- `page_dashboard.html` แดชบอร์ด
- `page_repairs.html` แจ้งซ่อมรถบัส
- `page_po.html` ใบสั่งซื้ออะไหล่
- `page_summary.html` สรุปค่าใช้จ่าย
- `page_stock.html` stock อะไหล่
- `page_shops.html` ร้านค้า
- `page_buses.html` จัดการรถบัส
- `page_oiltemplate.html` ตั้งค่าโปรแกรมน้ำมันเครื่อง
- `page_users.html` จัดการผู้ใช้
- `page_settings.html` ตั้งค่าระบบ
- `page_linelog.html` log การส่ง LINE

`build.js` จะรวมไฟล์เหล่านี้เป็น `public/index.html` และ inject Supabase client config จาก environment variables

## Supabase Bridge

`public/supabase-bridge.js` เป็น compatibility layer ระหว่าง frontend เดิมกับ Supabase

หน้าจอส่วนใหญ่เรียกผ่าน frontend command API เดิมของโปรเจกต์ โดย runtime ปัจจุบัน map คำสั่งไปที่ Supabase หรือ Netlify Functions ผ่าน bridge นี้

ตัวอย่างหน้าที่ bridge ดูแล:

- login ผ่าน `/.netlify/functions/auth-login`
- CRUD รถ, ร้านค้า, stock, repair, PO, settings
- ดึงข้อมูลสำหรับ dashboard และ summary
- ส่ง PO/repair ไป LINE ผ่าน Netlify Functions
- สร้าง PDF ผ่าน `/.netlify/functions/generate-pdf`
- upload signature ผ่าน `/.netlify/functions/upload-signature`

## Netlify Functions

| Function | หน้าที่ |
|---|---|
| `auth-login.js` | login และออก session token |
| `auth-utils.js` | sign/verify session token |
| `upload-signature.js` | upload/delete signature ไป bucket `signatures` |
| `line-send-po.js` | ส่ง PO ไป LINE group จาก setting `LINE_GROUP_ID_PO` |
| `line-send-repair.js` | ส่งแจ้งซ่อมไป LINE group จาก setting `LINE_GROUP_ID_SERVICE` |
| `line-webhook.js` | รับ LINE postback/message เพื่ออนุมัติหรืออัปเดตสถานะ |
| `generate-pdf.js` | สร้าง PDF PO และ upload ไป bucket `pdf-orders` |
| `admin-create-user.js` | สร้าง user ผ่าน Supabase Auth admin API |
| `admin-delete-user.js` | ลบ user ผ่าน Supabase Auth admin API |

## PO Approval Flow

1. ผู้ใช้สร้าง PO ในหน้าเว็บ
2. ระบบบันทึก `purchase_orders` และ `po_items`
3. ผู้ใช้กดส่งขออนุมัติ
4. `line-send-po.js` อ่าน `LINE_GROUP_ID_PO` จากตาราง `settings`
5. Function ส่ง Flex Message ไป LINE group
6. ผู้จัดการกดอนุมัติใน LINE
7. LINE ส่ง event เข้า `/.netlify/functions/line-webhook`
8. Webhook อัปเดต PO เป็น `อนุมัติแล้ว`
9. Webhook เรียก `generate-pdf.js`
10. PDF ใหม่พร้อมลายเซ็นผู้อนุมัติถูก upload ไป `pdf-orders`
11. ระบบตอบกลับ LINE พร้อมสถานะอนุมัติและลิงก์ PDF

## Repair Flow

1. ผู้ใช้เปิดแจ้งซ่อมรถบัส
2. ระบบบันทึก `repairs` และ `repair_parts`
3. ผู้ใช้ส่งแจ้งซ่อมเข้า LINE
4. `line-send-repair.js` อ่าน `LINE_GROUP_ID_SERVICE`
5. ช่างหรือผู้เกี่ยวข้องกด action ใน LINE
6. `line-webhook.js` อัปเดตสถานะ repair และบันทึก log

## Settings

ตาราง `settings` เป็น key/value

ค่าที่ใช้บ่อย:

- `LINE_GROUP_ID_PO`
- `LINE_GROUP_ID_SERVICE`
- `COMPANY_NAME_EN`
- `COMPANY_NAME_TH`
- `COMPANY_ADDRESS_EN`
- `COMPANY_ADDRESS_TH`
- `COMPANY_TEL`
- `COMPANY_FAX`
- `COMPANY_TAX_ID`
- `COMPANY_LOGO`
- `COMPANY_STAMP`

ค่าลับต้องอยู่ใน Netlify Environment Variables ไม่ควรใส่ในหน้า settings:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`
- `URL`
- `APP_SESSION_SECRET`

## Local Run

ใช้คำสั่ง:

```bash
npm run local
```

หรือ:

```bash
node run-local.js
```

สคริปต์จะ build frontend แล้วเปิด local server ที่ proxy Netlify Functions ได้

## Production Checklist

- Netlify site เชื่อม GitHub branch `main`
- Netlify Environment Variables ครบ
- `URL` ตั้งเป็น production URL เช่น `https://feet-management.netlify.app`
- LINE webhook ตั้งเป็น `https://feet-management.netlify.app/.netlify/functions/line-webhook`
- Supabase Storage buckets มี `signatures`, `company-assets`, `pdf-orders`
- ตั้งค่า `LINE_GROUP_ID_PO` และ `LINE_GROUP_ID_SERVICE` ในเมนูตั้งค่าระบบ
- ตรวจ RLS/policies ของ Supabase ก่อนใช้งานจริง
