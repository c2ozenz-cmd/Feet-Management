-- SQL Schema for Fleet & Stock Management Database (Supabase PostgreSQL)

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. USERS / PROFILES (Links to auth.users in Supabase)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    username TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    role TEXT DEFAULT 'user' CHECK (role IN ('admin', 'manager', 'user', 'mechanic')),
    line_user_id TEXT DEFAULT '',
    signature_url TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS policies for profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Profiles are viewable by authenticated users" 
ON public.profiles FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Profiles can be updated by admin only" 
ON public.profiles FOR UPDATE USING (
    EXISTS (
        SELECT 1 FROM public.profiles 
        WHERE id = auth.uid() AND role = 'admin'
    )
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

ALTER TABLE public.buses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Buses are viewable by authenticated users" ON public.buses FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Buses are editable by authenticated users" ON public.buses FOR ALL USING (auth.role() = 'authenticated');

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

ALTER TABLE public.shops ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Shops are viewable by authenticated users" ON public.shops FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Shops are editable by authenticated users" ON public.shops FOR ALL USING (auth.role() = 'authenticated');

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

ALTER TABLE public.stock ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Stock is viewable by authenticated users" ON public.stock FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Stock is editable by authenticated users" ON public.stock FOR ALL USING (auth.role() = 'authenticated');

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

ALTER TABLE public.repairs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Repairs are viewable by authenticated users" ON public.repairs FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Repairs are editable by authenticated users" ON public.repairs FOR ALL USING (auth.role() = 'authenticated');

-- 7. REPAIR PARTS
CREATE TABLE IF NOT EXISTS public.repair_parts (
    id BIGSERIAL PRIMARY KEY,
    repair_no TEXT REFERENCES public.repairs(repair_no) ON DELETE CASCADE,
    part_name TEXT NOT NULL,
    qty NUMERIC DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.repair_parts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Repair parts viewable by authenticated users" ON public.repair_parts FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Repair parts editable by authenticated" ON public.repair_parts FOR ALL USING (auth.role() = 'authenticated');

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

ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "POs are viewable by authenticated users" ON public.purchase_orders FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "POs are editable by authenticated users" ON public.purchase_orders FOR ALL USING (auth.role() = 'authenticated');

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

ALTER TABLE public.po_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "PO items are viewable by authenticated users" ON public.po_items FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "PO items are editable by authenticated users" ON public.po_items FOR ALL USING (auth.role() = 'authenticated');

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

ALTER TABLE public.stock_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Stock logs are viewable by authenticated users" ON public.stock_logs FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Stock logs can be created by authenticated users" ON public.stock_logs FOR INSERT WITH CHECK (auth.role() = 'authenticated');

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

ALTER TABLE public.oil_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Oil templates are viewable by authenticated users" ON public.oil_templates FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Oil templates are editable by authenticated users" ON public.oil_templates FOR ALL USING (auth.role() = 'authenticated');

-- 12. SETTINGS
CREATE TABLE IF NOT EXISTS public.settings (
    key TEXT PRIMARY KEY,
    value TEXT DEFAULT '',
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Settings viewable by authenticated users" ON public.settings FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Settings can be updated by admin only" ON public.settings FOR ALL USING (
    EXISTS (
        SELECT 1 FROM public.profiles 
        WHERE id = auth.uid() AND role = 'admin'
    )
);

-- 13. LINE LOGS
CREATE TABLE IF NOT EXISTS public.line_logs (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    stage TEXT NOT NULL,
    detail TEXT NOT NULL
);

ALTER TABLE public.line_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Line logs are viewable by authenticated users" ON public.line_logs FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Line logs can be inserted by anyone" ON public.line_logs FOR INSERT WITH CHECK (true);

-- 14. TRIGGER FOR PROFILE CREATION ON USER SIGNUP
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, username, name, role, status)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'username', NEW.email),
        COALESCE(NEW.raw_user_meta_data->>'name', NEW.raw_user_meta_data->>'username', NEW.email),
        COALESCE(NEW.raw_user_meta_data->>'role', 'user'),
        'active'
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 15. SUPABASE STORAGE BUCKETS & POLICIES
-- Create buckets if they don't exist
INSERT INTO storage.buckets (id, name, public)
VALUES
  ('signatures', 'signatures', true),
  ('company-assets', 'company-assets', true),
  ('pdf-orders', 'pdf-orders', true)
ON CONFLICT (id) DO NOTHING;

-- Public read access policies for buckets
CREATE POLICY "Public Read Access on signatures" ON storage.objects
  FOR SELECT USING (bucket_id = 'signatures');

CREATE POLICY "Public Read Access on company-assets" ON storage.objects
  FOR SELECT USING (bucket_id = 'company-assets');

CREATE POLICY "Public Read Access on pdf-orders" ON storage.objects
  FOR SELECT USING (bucket_id = 'pdf-orders');

-- Authenticated upload access policies
CREATE POLICY "Authenticated Upload Access on signatures" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'signatures' AND auth.role() = 'authenticated');

CREATE POLICY "Authenticated Upload Access on company-assets" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'company-assets' AND auth.role() = 'authenticated');

CREATE POLICY "Authenticated Upload Access on pdf-orders" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'pdf-orders' AND auth.role() = 'authenticated');
