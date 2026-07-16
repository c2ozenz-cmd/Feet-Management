-- Clear duplicated migrated data from Supabase while keeping uploaded files.
--
-- Use this in Supabase SQL Editor before importing data again.
--
-- This script DOES NOT touch:
-- - storage.buckets
-- - storage.objects
-- - files in the "signatures" bucket
-- - files in the "pdf-orders" bucket
-- - public.profiles, so user signature_url values remain
-- - public.settings, so LINE/Supabase/company settings remain
--
-- It clears operational/business data that can be safely rebuilt from migration:
-- buses, shops, stock, repairs, repair_parts, purchase_orders, po_items,
-- stock_logs, oil_templates, and line_logs.

BEGIN;

TRUNCATE TABLE
  public.line_logs,
  public.stock_logs,
  public.po_items,
  public.repair_parts,
  public.oil_templates,
  public.purchase_orders,
  public.repairs,
  public.stock,
  public.shops,
  public.buses
RESTART IDENTITY CASCADE;

COMMIT;

-- Optional full app-data reset:
-- If you also want to clear users/settings from the database while still keeping
-- the actual uploaded signature/PDF files in Supabase Storage, run this instead.
-- Be careful: this removes profile rows and setting rows, but not storage files.
--
-- BEGIN;
-- TRUNCATE TABLE
--   public.line_logs,
--   public.stock_logs,
--   public.po_items,
--   public.repair_parts,
--   public.oil_templates,
--   public.purchase_orders,
--   public.repairs,
--   public.stock,
--   public.shops,
--   public.buses,
--   public.profiles,
--   public.settings
-- RESTART IDENTITY CASCADE;
-- COMMIT;
