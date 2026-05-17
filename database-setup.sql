-- ============================================================
-- ResoNation Campground Reservation System
-- Complete Database Setup Script
-- Run this entire file in Supabase SQL Editor for each new client
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
  season_start text,
  season_end text,
  closed_season_message text DEFAULT 'We are closed for the season. We look forward to welcoming you back next year!',
  check_in_time text DEFAULT '2:00 PM',
  check_out_time text DEFAULT '12:00 PM',
  same_day_cutoff_time text DEFAULT '11:00 AM',
  same_day_cutoff_message text DEFAULT 'Same-day reservations are not available online. Please call us to book.',
  extra_adult_fee integer DEFAULT 0,
  extra_child_fee integer DEFAULT 0,
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
  reply_to_email text DEFAULT '',
  waiver_enabled boolean DEFAULT true,
  waiver_text text DEFAULT '',
  plan text DEFAULT 'ridgeline'
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
  total_price integer NOT NULL DEFAULT 0,
  amount_paid integer DEFAULT 0,
  payment_type text DEFAULT 'full' CHECK (payment_type IN ('full', 'deposit', 'unpaid')),
  square_payment_id text,
  waiver_signed boolean DEFAULT false,
  waiver_signed_at timestamptz,
  waiver_signature text,
  notes text DEFAULT '',
  confirmation_number text,
  discount_code text,
  checked_in boolean DEFAULT false
);


-- Add-ons
CREATE TABLE IF NOT EXISTS addons (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  name text NOT NULL,
  description text DEFAULT '',
  price integer NOT NULL DEFAULT 0,
  is_active boolean DEFAULT true,
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
  start_date date NOT NULL,
  end_date date NOT NULL,
  nightly_rate integer NOT NULL,
  priority integer DEFAULT 0,
  is_active boolean DEFAULT true,
  site_ids text DEFAULT ''
);


-- Minimum Stay Rules
CREATE TABLE IF NOT EXISTS min_stay_rules (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  name text NOT NULL,
  site_id uuid REFERENCES sites(id),
  site_type text,
  start_date date NOT NULL,
  end_date date NOT NULL,
  min_nights integer NOT NULL DEFAULT 1,
  is_active boolean DEFAULT true,
  site_ids text DEFAULT ''
);


-- Cancellation Rules
CREATE TABLE IF NOT EXISTS cancellation_rules (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  name text NOT NULL,
  days_before_arrival integer NOT NULL,
  refund_percentage integer NOT NULL DEFAULT 0,
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
  type text NOT NULL CHECK (type IN ('percentage', 'flat')),
  amount integer NOT NULL,
  start_date date,
  end_date date,
  max_uses integer,
  uses_count integer DEFAULT 0,
  is_active boolean DEFAULT true
);


-- Fees / Taxes
CREATE TABLE IF NOT EXISTS fees (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('percentage', 'flat')),
  amount numeric NOT NULL,
  applies_to text DEFAULT 'all',
  is_active boolean DEFAULT true
);


-- Categories (for grouping sites)
CREATE TABLE IF NOT EXISTS categories (
  id bigint generated always as identity primary key,
  created_at timestamptz DEFAULT now(),
  name text NOT NULL,
  campground_id uuid
);


-- Site Categories (junction table)
CREATE TABLE IF NOT EXISTS site_categories (
  id bigint generated always as identity primary key,
  site_id uuid NOT NULL,
  category_id int8 NOT NULL
);


-- Square OAuth Connections
CREATE TABLE IF NOT EXISTS square_connections (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  merchant_id text NOT NULL,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  location_id text
);


-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE addons ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_addons ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE min_stay_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE cancellation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocked_dates ENABLE ROW LEVEL SECURITY;
ALTER TABLE discounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fees ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE square_connections ENABLE ROW LEVEL SECURITY;


-- ============================================================
-- RLS POLICIES (allow all for simplicity — service role used for admin)
-- ============================================================

DO $$ BEGIN
  -- settings
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'settings' AND policyname = 'Allow all on settings') THEN
    CREATE POLICY "Allow all on settings" ON settings FOR ALL USING (true) WITH CHECK (true);
  END IF;
  -- sites
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'sites' AND policyname = 'Allow all on sites') THEN
    CREATE POLICY "Allow all on sites" ON sites FOR ALL USING (true) WITH CHECK (true);
  END IF;
  -- reservations
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'reservations' AND policyname = 'Allow all on reservations') THEN
    CREATE POLICY "Allow all on reservations" ON reservations FOR ALL USING (true) WITH CHECK (true);
  END IF;
  -- addons
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'addons' AND policyname = 'Allow all on addons') THEN
    CREATE POLICY "Allow all on addons" ON addons FOR ALL USING (true) WITH CHECK (true);
  END IF;
  -- reservation_addons
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'reservation_addons' AND policyname = 'Allow all on reservation_addons') THEN
    CREATE POLICY "Allow all on reservation_addons" ON reservation_addons FOR ALL USING (true) WITH CHECK (true);
  END IF;
  -- pricing_rules
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'pricing_rules' AND policyname = 'Allow all on pricing_rules') THEN
    CREATE POLICY "Allow all on pricing_rules" ON pricing_rules FOR ALL USING (true) WITH CHECK (true);
  END IF;
  -- min_stay_rules
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'min_stay_rules' AND policyname = 'Allow all on min_stay_rules') THEN
    CREATE POLICY "Allow all on min_stay_rules" ON min_stay_rules FOR ALL USING (true) WITH CHECK (true);
  END IF;
  -- cancellation_rules
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cancellation_rules' AND policyname = 'Allow all on cancellation_rules') THEN
    CREATE POLICY "Allow all on cancellation_rules" ON cancellation_rules FOR ALL USING (true) WITH CHECK (true);
  END IF;
  -- blocked_dates
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'blocked_dates' AND policyname = 'Allow all on blocked_dates') THEN
    CREATE POLICY "Allow all on blocked_dates" ON blocked_dates FOR ALL USING (true) WITH CHECK (true);
  END IF;
  -- discounts
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'discounts' AND policyname = 'Allow all on discounts') THEN
    CREATE POLICY "Allow all on discounts" ON discounts FOR ALL USING (true) WITH CHECK (true);
  END IF;
  -- fees
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'fees' AND policyname = 'Allow all on fees') THEN
    CREATE POLICY "Allow all on fees" ON fees FOR ALL USING (true) WITH CHECK (true);
  END IF;
  -- categories
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'categories' AND policyname = 'Allow all on categories') THEN
    CREATE POLICY "Allow all on categories" ON categories FOR ALL USING (true) WITH CHECK (true);
  END IF;
  -- site_categories
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'site_categories' AND policyname = 'Allow all on site_categories') THEN
    CREATE POLICY "Allow all on site_categories" ON site_categories FOR ALL USING (true) WITH CHECK (true);
  END IF;
  -- square_connections
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'square_connections' AND policyname = 'Allow all on square_connections') THEN
    CREATE POLICY "Allow all on square_connections" ON square_connections FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;


-- ============================================================
-- STORAGE BUCKETS
-- Note: Run these separately if they fail (buckets may need
-- to be created manually in Supabase Storage UI)
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


-- ============================================================
-- DONE!
-- Next steps after running this script:
-- 1. Go to Settings page in admin and fill in park details
-- 2. Add sites in the Sites page
-- 3. Set up Square OAuth in Settings > Square Payments
-- 4. Verify your email domain in Resend
-- 5. Add your environment variables to Vercel
-- ============================================================
