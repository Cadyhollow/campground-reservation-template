-- ============================================================
-- ResoNation Campground Reservation System
-- Complete Database Setup Script
-- Run this entire file in Supabase SQL Editor for each new client
-- ============================================================
-- Last updated: 2026-06-08
-- Verified against Cady Hollow + Lakeshore production schemas (22 tables)
-- ============================================================


-- ============================================================
-- TABLES
-- ============================================================

-- Settings (one row per campground)
CREATE TABLE IF NOT EXISTS settings (
  id integer PRIMARY KEY DEFAULT 1,
  park_name text,
  park_tagline text DEFAULT '',
  park_email text DEFAULT '',
  park_phone text DEFAULT '',
  park_address text DEFAULT '',
  park_website text DEFAULT '',
  park_location text DEFAULT '',
  logo_url text,
  logo_shape text DEFAULT 'circle',
  accent_color text DEFAULT '#2D6A4F',
  primary_color text DEFAULT '#2D6A4F',
  season_start text,
  season_end text,
  closed_season_message text DEFAULT 'We are closed for the season. We look forward to welcoming you back next year!',
  check_in_time text DEFAULT '2:00 PM',
  check_out_time text DEFAULT '12:00 PM',
  same_day_cutoff_time text DEFAULT '11:00 AM',
  same_day_cutoff_message text DEFAULT 'Same-day reservations are not available online. Please call us to book.',
  extra_adult_fee integer DEFAULT 0,
  extra_child_fee integer DEFAULT 0,
  base_adult_rate integer DEFAULT 0,
  base_child_rate integer DEFAULT 0,
  base_occupancy_adults integer DEFAULT 2,
  base_occupancy_children integer DEFAULT 2,
  cancellation_policy text DEFAULT '',
  confirmation_message text DEFAULT '',
  admin_password text DEFAULT 'admin123',
  show_site_map boolean DEFAULT false,
  sender_name text DEFAULT '',
  sender_email text DEFAULT '',
  reply_to_email text DEFAULT '',
  use_custom_sender boolean DEFAULT false,
  waiver_enabled boolean DEFAULT true,
  waiver_text text DEFAULT '',
  plan text DEFAULT 'ridgeline',
  pos_enabled boolean DEFAULT false,
  card_surcharge_percent numeric DEFAULT 0,
  electric_bill_message text DEFAULT '',
  square_terminal_device_id text DEFAULT '',
  square_terminal_name text DEFAULT '',
  seasonal_enabled boolean DEFAULT false,
  total_sites integer DEFAULT 0,
  total_cabins integer DEFAULT 0,
  max_credit_amount integer DEFAULT 0,
  early_checkin_enabled boolean DEFAULT false,
  early_checkin_price integer DEFAULT 0,
  early_checkin_time text DEFAULT '',
  early_checkin_show_customers boolean DEFAULT false,
  late_checkout_enabled boolean DEFAULT false,
  late_checkout_price integer DEFAULT 0,
  late_checkout_time text DEFAULT '',
  late_checkout_show_customers boolean DEFAULT false,
  maintenance_mode boolean DEFAULT false,
  maintenance_message text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Insert default settings row
INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;


-- Sites
CREATE TABLE IF NOT EXISTS sites (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  site_number text NOT NULL,
  site_type text NOT NULL,
  amp_service text DEFAULT 'none',
  max_rv_length numeric,
  hookups text DEFAULT 'none',
  base_rate integer NOT NULL DEFAULT 0,
  description text DEFAULT '',
  display_order integer DEFAULT 0,
  is_active boolean DEFAULT true,
  is_available boolean DEFAULT true,
  in_rotation boolean DEFAULT true,
  photo_url text,
  photo_url_2 text
);


-- Reservations
CREATE TABLE IF NOT EXISTS reservations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  site_id uuid REFERENCES sites(id),
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'manual')),
  arrival_date date NOT NULL,
  departure_date date NOT NULL,
  num_adults integer DEFAULT 2,
  num_children integer DEFAULT 0,
  guest_name text NOT NULL,
  guest_email text NOT NULL,
  guest_phone text DEFAULT '',
  base_nightly_rate integer DEFAULT 0,
  extra_guest_fee_total integer DEFAULT 0,
  addons_total integer DEFAULT 0,
  discount_amount integer DEFAULT 0,
  fees_total integer DEFAULT 0,
  total_price integer NOT NULL DEFAULT 0,
  amount_paid integer DEFAULT 0,
  payment_type text DEFAULT 'full' CHECK (payment_type IN ('full', 'deposit', 'unpaid')),
  payment_method text DEFAULT '',
  square_payment_id text,
  waiver_signed boolean DEFAULT false,
  waiver_signed_at timestamptz,
  waiver_signature text,
  notes text DEFAULT '',
  confirmation_number text,
  discount_code text,
  checked_in boolean DEFAULT false,
  special_requests text DEFAULT '',
  site_name text DEFAULT '',
  camper_type text DEFAULT '',
  camper_length integer DEFAULT 0,
  camper_amperage text DEFAULT ''
);


-- Add-ons
CREATE TABLE IF NOT EXISTS addons (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  name text NOT NULL,
  description text DEFAULT '',
  price integer NOT NULL DEFAULT 0,
  is_active boolean DEFAULT true,
  is_early_checkin boolean DEFAULT false,
  display_order integer DEFAULT 0
);


-- Reservation Add-ons (junction table)
CREATE TABLE IF NOT EXISTS reservation_addons (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  reservation_id uuid REFERENCES reservations(id) ON DELETE CASCADE,
  addon_id uuid REFERENCES addons(id),
  quantity integer DEFAULT 1,
  price_at_booking integer DEFAULT 0
);


-- Pricing Rules
CREATE TABLE IF NOT EXISTS pricing_rules (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  name text NOT NULL,
  site_id uuid REFERENCES sites(id),
  site_type text,
  site_ids text,
  start_date date NOT NULL,
  end_date date NOT NULL,
  nightly_rate integer NOT NULL,
  priority integer DEFAULT 0,
  is_active boolean DEFAULT true
);


-- Minimum Stay Rules
CREATE TABLE IF NOT EXISTS min_stay_rules (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  name text NOT NULL,
  site_id uuid REFERENCES sites(id),
  site_type text,
  site_ids text,
  start_date date NOT NULL,
  end_date date NOT NULL,
  min_nights integer NOT NULL DEFAULT 1,
  is_active boolean DEFAULT true
);


-- Cancellation Rules
CREATE TABLE IF NOT EXISTS cancellation_rules (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  name text NOT NULL,
  start_date date,
  end_date date,
  deposit_refundable boolean DEFAULT true,
  refund_percent integer DEFAULT 90,
  cancellation_deadline_days integer DEFAULT 7,
  policy_text text,
  is_active boolean DEFAULT true
);


-- Blocked Dates
CREATE TABLE IF NOT EXISTS blocked_dates (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  site_id uuid REFERENCES sites(id),
  date date NOT NULL,
  reason text DEFAULT ''
);


-- Discounts / Coupon Codes
CREATE TABLE IF NOT EXISTS discounts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  code text NOT NULL UNIQUE,
  description text,
  discount_type text,
  discount_value integer,
  valid_from date,
  valid_until date,
  max_uses integer,
  times_used integer DEFAULT 0,
  is_active boolean DEFAULT true
);


-- Fees / Taxes
CREATE TABLE IF NOT EXISTS fees (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  name text NOT NULL,
  type text NOT NULL,
  amount numeric NOT NULL,
  applies_to text DEFAULT 'all',
  is_active boolean DEFAULT true,
  card_only boolean DEFAULT false
);


-- Site Categories (junction table for grouping sites)
CREATE TABLE IF NOT EXISTS site_categories (
  id bigint generated always as identity primary key,
  site_id uuid NOT NULL,
  category_id bigint NOT NULL
);


-- Square OAuth Connections
CREATE TABLE IF NOT EXISTS square_connections (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  campground_id text NOT NULL UNIQUE,
  merchant_id text NOT NULL,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  token_expires_at timestamptz NOT NULL,
  location_id text
);


-- Product Categories
CREATE TABLE IF NOT EXISTS product_categories (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  name text NOT NULL,
  display_order integer DEFAULT 0
);


-- Products
CREATE TABLE IF NOT EXISTS products (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  name text NOT NULL,
  description text DEFAULT '',
  category text DEFAULT 'General',
  category_id uuid REFERENCES product_categories(id) ON DELETE SET NULL,
  price integer NOT NULL DEFAULT 0,
  tax_class text DEFAULT 'standard',
  track_inventory boolean DEFAULT false,
  stock_quantity integer,
  in_stock boolean DEFAULT true,
  active boolean DEFAULT true,
  display_order integer DEFAULT 0,
  variable_price boolean DEFAULT false
);


-- Guests (camper directory; first/last kept nullable for future sortable directory)
CREATE TABLE IF NOT EXISTS guests (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  name text,
  first_name text,
  last_name text,
  email text DEFAULT '',
  phone text DEFAULT '',
  site_id uuid REFERENCES sites(id) ON DELETE SET NULL,
  site_number text DEFAULT '',
  is_seasonal boolean DEFAULT false,
  season_start date,
  season_end date,
  notes text DEFAULT '',
  last_visit date,
  email_opt_out boolean DEFAULT false
);


-- Folios (running charge accounts)
CREATE TABLE IF NOT EXISTS folios (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  type text NOT NULL,
  reservation_id uuid REFERENCES reservations(id) ON DELETE SET NULL,
  guest_id uuid REFERENCES guests(id) ON DELETE SET NULL,
  guest_name text
);


-- Folio Line Items
CREATE TABLE IF NOT EXISTS folio_line_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  folio_id uuid REFERENCES folios(id) ON DELETE CASCADE,
  description text,
  amount integer NOT NULL DEFAULT 0,
  quantity integer DEFAULT 1,
  notes text,
  voided boolean DEFAULT false
);


-- Folio Payments
CREATE TABLE IF NOT EXISTS folio_payments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  folio_id uuid REFERENCES folios(id) ON DELETE CASCADE,
  amount integer NOT NULL DEFAULT 0,
  method text,
  note text,
  receipt_sent_at timestamptz
);


-- Square Terminal Checkouts
CREATE TABLE IF NOT EXISTS terminal_checkouts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  folio_id uuid REFERENCES folios(id) ON DELETE SET NULL,
  device_id text,
  amount integer NOT NULL DEFAULT 0,
  surcharge_amount integer DEFAULT 0,
  status text,
  square_checkout_id text
);


-- Electric Readings
CREATE TABLE IF NOT EXISTS electric_readings (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  guest_id uuid REFERENCES guests(id) ON DELETE CASCADE,
  reading_date date NOT NULL,
  kwh integer NOT NULL DEFAULT 0,
  amount integer NOT NULL DEFAULT 0,
  note text,
  email_sent_at timestamptz
);


-- Broadcast Emails Log
CREATE TABLE IF NOT EXISTS broadcast_emails (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  sent_at timestamptz DEFAULT now(),
  subject text,
  recipient_count integer,
  sent_by text
);


-- ============================================================
-- ROW LEVEL SECURITY + POLICIES
-- Enable RLS and create permissive policies so the anon key works.
-- ============================================================

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'settings','sites','reservations','addons','reservation_addons',
    'pricing_rules','min_stay_rules','cancellation_rules','blocked_dates',
    'discounts','fees','site_categories','square_connections',
    'product_categories','products','guests','folios','folio_line_items',
    'folio_payments','terminal_checkouts','electric_readings','broadcast_emails'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "Allow all" ON %I', t);
    EXECUTE format('CREATE POLICY "Allow all" ON %I FOR ALL USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;


-- ============================================================
-- STORAGE BUCKETS
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('logos', 'logos', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public)
VALUES ('site-photos', 'site-photos', true)
ON CONFLICT (id) DO NOTHING;


-- ============================================================
-- STORAGE POLICIES
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'objects' AND policyname = 'Allow public read on logos') THEN
    CREATE POLICY "Allow public read on logos" ON storage.objects FOR SELECT USING (bucket_id = 'logos');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'objects' AND policyname = 'Allow upload on logos') THEN
    CREATE POLICY "Allow upload on logos" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'logos');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'objects' AND policyname = 'Allow public read on site-photos') THEN
    CREATE POLICY "Allow public read on site-photos" ON storage.objects FOR SELECT USING (bucket_id = 'site-photos');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'objects' AND policyname = 'Allow upload on site-photos') THEN
    CREATE POLICY "Allow upload on site-photos" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'site-photos');
  END IF;
END $$;
