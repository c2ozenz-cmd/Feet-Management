-- SQL Schema for Fleet & Stock Management Database (Supabase PostgreSQL - Simplified Version)

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. USERS / PROFILES (Independent table, direct lookup)
CREATE TABLE IF NOT EXISTS public.profiles (
    id TEXT PRIMARY KEY, -- e.g. U1689...
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL, -- Plain text password matching original Sheets
    name TEXT NOT NULL,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    role TEXT DEFAULT 'user' CHECK (role IN ('admin', 'manager', 'user', 'mechanic')),
    line_user_id TEXT DEFAULT '',
    signature_url TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. BUSES
CREATE TABLE IF NOT EXISTS public.buses (
    plate TEXT PRIMARY KEY,
    chassis TEXT DEFAULT '',
    model TEXT DEFAULT '',
    year TEXT DEFAULT '',
    color TEXT DEFAULT '',
    engine_no TEXT DEFAULT '',
    last_inspect DATE,
    reg_expiry DATE,
    insurance_expiry DATE,
    note TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. SHOPS
CREATE TABLE IF NOT EXISTS public.shops (
    id TEXT PRIMARY KEY DEFAULT ('SHP' || EXTRACT(EPOCH FROM NOW())::TEXT),
    name TEXT NOT NULL,
    address TEXT DEFAULT '',
    tax_id TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    note TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. STOCK
CREATE TABLE IF NOT EXISTS public.stock (
    id TEXT PRIMARY KEY DEFAULT ('STK' || EXTRACT(EPOCH FROM NOW())::TEXT),
    part_code TEXT DEFAULT '',
    part_name TEXT UNIQUE NOT NULL,
    unit TEXT DEFAULT 'ชิ้น',
    qty NUMERIC DEFAULT 0,
    min_qty NUMERIC DEFAULT 0,
    location TEXT DEFAULT '',
    note TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. REPAIRS
CREATE TABLE IF NOT EXISTS public.repairs (
    repair_no TEXT PRIMARY KEY,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    plate TEXT REFERENCES public.buses(plate) ON DELETE SET NULL,
    chassis TEXT DEFAULT '',
    mileage INTEGER DEFAULT 0,
    oil_program TEXT DEFAULT '',
    repair_list TEXT DEFAULT '',
    repair_summary TEXT DEFAULT '',
    status TEXT DEFAULT 'รอดำเนินการ' CHECK (status IN ('รอดำเนินการ', 'กำลังซ่อม', 'รออะไหล่', 'เสร็จแล้ว')),
    created_by TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    approved_by TEXT DEFAULT '',
    approved_at TEXT DEFAULT ''
);

-- 7. REPAIR PARTS
CREATE TABLE IF NOT EXISTS public.repair_parts (
    id BIGSERIAL PRIMARY KEY,
    repair_no TEXT REFERENCES public.repairs(repair_no) ON DELETE CASCADE,
    part_name TEXT NOT NULL,
    qty NUMERIC DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. PURCHASE ORDERS
CREATE TABLE IF NOT EXISTS public.purchase_orders (
    po_no TEXT PRIMARY KEY,
    shop_name TEXT NOT NULL,
    shop_address TEXT DEFAULT '',
    tax_id TEXT DEFAULT '',
    issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
    quote_date DATE,
    ref_repair_no TEXT REFERENCES public.repairs(repair_no) ON DELETE SET NULL,
    quote_no TEXT DEFAULT '',
    plate TEXT REFERENCES public.buses(plate) ON DELETE SET NULL,
    vat_type TEXT DEFAULT 'none' CHECK (vat_type IN ('none', 'exclusive', 'inclusive')),
    status TEXT DEFAULT 'รออนุมัติ' CHECK (status IN ('รออนุมัติ', 'อนุมัติแล้ว', 'รับของแล้ว', 'ออกPO')),
    created_by TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by_signature_url TEXT DEFAULT '',
    approved_by TEXT DEFAULT '',
    approved_at TEXT DEFAULT '',
    line_sent_at TEXT DEFAULT '',
    pdf_url TEXT DEFAULT '',
    grp_ref TEXT DEFAULT '',
    quote_no_is_auto BOOLEAN DEFAULT FALSE,
    printed_at TEXT DEFAULT ''
);

-- 9. PO ITEMS
CREATE TABLE IF NOT EXISTS public.po_items (
    id BIGSERIAL PRIMARY KEY,
    po_no TEXT REFERENCES public.purchase_orders(po_no) ON DELETE CASCADE,
    part_name TEXT NOT NULL,
    qty NUMERIC DEFAULT 1,
    unit TEXT DEFAULT 'ชิ้น',
    price_per_unit NUMERIC DEFAULT 0,
    discount NUMERIC DEFAULT 0,
    amount NUMERIC DEFAULT 0,
    note TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. STOCK LOGS
CREATE TABLE IF NOT EXISTS public.stock_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    type TEXT NOT NULL,
    part_name TEXT NOT NULL,
    qty NUMERIC NOT NULL,
    ref TEXT DEFAULT '',
    log_id TEXT DEFAULT ''
);

-- 11. OIL TEMPLATES
CREATE TABLE IF NOT EXISTS public.oil_templates (
    id BIGSERIAL PRIMARY KEY,
    plate TEXT REFERENCES public.buses(plate) ON DELETE CASCADE,
    program TEXT NOT NULL,
    part_name TEXT NOT NULL,
    qty NUMERIC DEFAULT 1,
    unit TEXT DEFAULT 'ชิ้น',
    price_per_unit NUMERIC DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 12. SETTINGS
CREATE TABLE IF NOT EXISTS public.settings (
    key TEXT PRIMARY KEY,
    value TEXT DEFAULT '',
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 13. LINE LOGS
CREATE TABLE IF NOT EXISTS public.line_logs (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    stage TEXT NOT NULL,
    detail TEXT NOT NULL
);

-- 14. SUPABASE STORAGE BUCKETS
INSERT INTO storage.buckets (id, name, public)
VALUES
  ('signatures', 'signatures', true),
  ('company-assets', 'company-assets', true),
  ('pdf-orders', 'pdf-orders', true)
ON CONFLICT (id) DO NOTHING;

-- DISABLE ROW LEVEL SECURITY (RLS) FOR DIRECT ACCESS SIMILAR TO GOOGLE SHEETS
ALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.buses DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.shops DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.repairs DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.repair_parts DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_orders DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.po_items DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.oil_templates DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.line_logs DISABLE ROW LEVEL SECURITY;
