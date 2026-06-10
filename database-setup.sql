-- ============================================================
-- database-setup.sql — ResoNation client schema (DOCUMENTATION)
-- ============================================================
-- This file is AUTO-GENERATED from the authoritative onboarding
-- SQL in resonation-admin/app/api/onboard/route.ts (DATABASE_SETUP_SQL).
-- That route.ts constant is what actually provisions new clients.
-- Do not hand-edit this file; regenerate it from route.ts instead.
-- Last regenerated: 2026-06-10
-- ============================================================
-- ============================================================
-- ResoNation Campground Reservation System
-- Complete Database Setup Script  -  run once per new client
-- Generated from the live Cady Hollow schema (authoritative source of truth)
-- Client-specific values (password, phone, site counts, pos) are genericized.
-- ============================================================

-- ============================================================
-- TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS addons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  price integer NOT NULL,
  is_active boolean DEFAULT true,
  is_early_checkin boolean DEFAULT false,
  display_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS blocked_dates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid,
  date date NOT NULL,
  reason text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS broadcast_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  subject text NOT NULL,
  message text NOT NULL,
  recipient_count integer DEFAULT 0,
  bypassed_opt_out boolean DEFAULT false,
  sent_by text DEFAULT 'admin'::text
);

CREATE TABLE IF NOT EXISTS cancellation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  deposit_refundable boolean DEFAULT true,
  refund_percent integer DEFAULT 90,
  cancellation_deadline_days integer DEFAULT 7,
  policy_text text NOT NULL,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  name text,
  campground_id uuid
);

CREATE TABLE IF NOT EXISTS discounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  description text,
  discount_type text,
  discount_value integer NOT NULL,
  valid_from date,
  valid_until date,
  max_uses integer,
  times_used integer DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS electric_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  guest_id uuid,
  billing_month text NOT NULL,
  previous_reading numeric DEFAULT 0,
  current_reading numeric DEFAULT 0,
  kwh_used numeric DEFAULT 0,
  rate_per_kwh numeric DEFAULT 0.27,
  minimum_charge integer DEFAULT 1500,
  calculated_amount integer DEFAULT 0,
  final_amount integer DEFAULT 0,
  folio_line_item_id uuid,
  notes text DEFAULT ''::text
);

CREATE TABLE IF NOT EXISTS fees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  type text NOT NULL,
  amount numeric NOT NULL,
  applies_to text DEFAULT 'all'::text,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  card_only boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS folio_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  folio_id uuid NOT NULL,
  product_id uuid,
  description text NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  unit_price integer NOT NULL DEFAULT 0,
  tax_amount integer NOT NULL DEFAULT 0,
  line_total integer NOT NULL DEFAULT 0,
  category text DEFAULT ''::text,
  charged_at timestamptz DEFAULT now(),
  notes text
);

CREATE TABLE IF NOT EXISTS folio_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  folio_id uuid NOT NULL,
  method text NOT NULL DEFAULT 'cash'::text,
  amount integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'completed'::text,
  reference_number text DEFAULT ''::text,
  square_payment_id text DEFAULT ''::text,
  note text DEFAULT ''::text,
  paid_at timestamptz DEFAULT now(),
  surcharge_amount integer DEFAULT 0,
  receipt_sent_at timestamptz
);

CREATE TABLE IF NOT EXISTS folios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  reservation_id uuid,
  guest_name text NOT NULL DEFAULT ''::text,
  guest_email text DEFAULT ''::text,
  folio_type text NOT NULL DEFAULT 'reservation'::text,
  status text NOT NULL DEFAULT 'open'::text,
  label text DEFAULT ''::text,
  opened_at timestamptz DEFAULT now(),
  closed_at timestamptz,
  notes text DEFAULT ''::text,
  guest_id uuid
);

CREATE TABLE IF NOT EXISTS guests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  name text NOT NULL,
  email text DEFAULT ''::text,
  phone text DEFAULT ''::text,
  site_number text DEFAULT ''::text,
  is_seasonal boolean DEFAULT false,
  season_start date,
  season_end date,
  notes text DEFAULT ''::text,
  last_visit date,
  email_opt_out boolean DEFAULT false,
  is_monthly boolean DEFAULT false,
  electric_billing_enabled boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS min_stay_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  site_id uuid,
  site_type text,
  start_date date NOT NULL,
  end_date date NOT NULL,
  min_nights integer NOT NULL,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  site_ids text DEFAULT ''::text
);

CREATE TABLE IF NOT EXISTS pricing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  site_id uuid,
  site_type text,
  start_date date NOT NULL,
  end_date date NOT NULL,
  nightly_rate integer NOT NULL,
  priority integer DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  site_ids text DEFAULT ''::text
);

CREATE TABLE IF NOT EXISTS product_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  name text NOT NULL,
  display_order integer DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  name text NOT NULL,
  description text DEFAULT ''::text,
  category text NOT NULL DEFAULT 'General'::text,
  price integer NOT NULL DEFAULT 0,
  tax_class text NOT NULL DEFAULT 'standard'::text,
  track_inventory boolean NOT NULL DEFAULT false,
  stock_quantity integer,
  active boolean NOT NULL DEFAULT true,
  display_order integer DEFAULT 0,
  variable_price boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS reservation_addons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid,
  addon_id uuid,
  quantity integer DEFAULT 1,
  price_at_booking integer NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid,
  status text DEFAULT 'confirmed'::text,
  arrival_date date NOT NULL,
  departure_date date NOT NULL,
  num_adults integer NOT NULL DEFAULT 2,
  num_children integer NOT NULL DEFAULT 0,
  guest_name text NOT NULL,
  guest_email text NOT NULL,
  guest_phone text,
  base_nightly_rate integer NOT NULL,
  extra_guest_fee_total integer DEFAULT 0,
  addons_total integer DEFAULT 0,
  discount_amount integer DEFAULT 0,
  total_price integer NOT NULL,
  amount_paid integer DEFAULT 0,
  payment_type text,
  square_payment_id text,
  waiver_signed boolean DEFAULT false,
  waiver_signed_at timestamptz,
  notes text,
  created_at timestamptz DEFAULT now(),
  discount_code text DEFAULT ''::text,
  special_requests text DEFAULT ''::text,
  site_name text DEFAULT ''::text,
  confirmation_number text DEFAULT ''::text,
  checked_in boolean DEFAULT false,
  camper_type text DEFAULT ''::text,
  camper_length integer DEFAULT 0,
  camper_amperage text DEFAULT ''::text,
  fees_total integer DEFAULT 0,
  payment_method text DEFAULT 'cash'::text,
  early_checkin boolean DEFAULT false,
  early_checkin_fee integer DEFAULT 0,
  late_checkout boolean DEFAULT false,
  late_checkout_fee integer DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  park_name text NOT NULL DEFAULT 'My Campground'::text,
  park_tagline text,
  park_email text,
  park_phone text,
  park_address text,
  park_website text,
  check_in_time text DEFAULT '2:00 PM'::text,
  check_out_time text DEFAULT '12:00 PM'::text,
  base_adult_rate integer DEFAULT 0,
  base_child_rate integer DEFAULT 0,
  extra_adult_fee integer DEFAULT 1000,
  extra_child_fee integer DEFAULT 500,
  base_occupancy_adults integer DEFAULT 2,
  base_occupancy_children integer DEFAULT 2,
  cancellation_policy text,
  primary_color text DEFAULT '#2D6A4F'::text,
  logo_url text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  season_start text DEFAULT 'May 1'::text,
  season_end text DEFAULT 'October 31'::text,
  closed_season_message text DEFAULT 'We are closed for the season. We look forward to seeing you next year!'::text,
  same_day_cutoff_time time DEFAULT '11:00:00'::time without time zone,
  accent_color text DEFAULT '#3DBDD4'::text,
  show_site_map boolean DEFAULT false,
  admin_password text DEFAULT 'admin123'::text,
  park_location text,
  logo_shape text DEFAULT 'circle'::text,
  confirmation_message text,
  waiver_enabled boolean DEFAULT true,
  waiver_text text,
  same_day_cutoff_message text DEFAULT 'Same-day reservations are not available online. Please call us to book.'::text,
  plan text DEFAULT 'ridgeline'::text,
  maintenance_mode boolean DEFAULT false,
  maintenance_message text DEFAULT 'We are temporarily unavailable for online reservations. Please call us to book your stay!'::text,
  sender_email text DEFAULT ''::text,
  reply_to_email text DEFAULT ''::text,
  sender_name text DEFAULT ''::text,
  use_custom_sender boolean DEFAULT false,
  card_surcharge_percent numeric DEFAULT 0,
  early_checkin_enabled boolean DEFAULT false,
  early_checkin_price integer DEFAULT 0,
  early_checkin_time text DEFAULT '12:00'::text,
  early_checkin_show_customers boolean DEFAULT false,
  late_checkout_enabled boolean DEFAULT false,
  late_checkout_price integer DEFAULT 0,
  late_checkout_time text DEFAULT '12:00'::text,
  late_checkout_show_customers boolean DEFAULT false,
  electric_bill_message text DEFAULT ''::text,
  square_terminal_device_id text DEFAULT ''::text,
  square_terminal_name text DEFAULT ''::text,
  pos_enabled boolean DEFAULT false,
  total_sites integer DEFAULT 0,
  total_cabins integer DEFAULT 0,
  seasonal_enabled boolean DEFAULT false,
  max_credit_amount integer DEFAULT 0,
  auto_sync_guests boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS site_categories (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id uuid NOT NULL,
  category_id bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_number text NOT NULL,
  site_type text NOT NULL,
  amp_service text,
  max_rv_length integer,
  hookups text,
  is_available boolean DEFAULT true,
  base_rate integer NOT NULL,
  description text,
  display_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  in_rotation boolean DEFAULT false,
  photo_url text,
  photo_url_2 text
);

CREATE TABLE IF NOT EXISTS terminal_checkouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  folio_id uuid,
  square_checkout_id text NOT NULL,
  amount integer NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text,
  payment_id text DEFAULT ''::text,
  device_id text DEFAULT ''::text,
  note text DEFAULT ''::text,
  completed_at timestamptz,
  surcharge_amount integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS square_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  merchant_id text NOT NULL,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  location_id text
);

-- Seed early/late check-in as POS products (walk-in tiles)
INSERT INTO products (name, description, category, price, tax_class, active, display_order)
SELECT 'Early Check-In', 'Arrive before standard check-in time', 'Fees', 1000, 'none', true, 100
WHERE NOT EXISTS (SELECT 1 FROM products WHERE name = 'Early Check-In');
INSERT INTO products (name, description, category, price, tax_class, active, display_order)
SELECT 'Late Check-Out', 'Depart after standard check-out time', 'Fees', 1000, 'none', true, 101
WHERE NOT EXISTS (SELECT 1 FROM products WHERE name = 'Late Check-Out');

-- Guest auto-sync trigger (dormant unless settings.auto_sync_guests = true)
CREATE OR REPLACE FUNCTION sync_guest_from_reservation()
RETURNS TRIGGER AS $func$
DECLARE
  v_enabled boolean;
  v_email text;
  v_site_number text;
  v_existing_id uuid;
  v_existing_last_visit date;
BEGIN
  SELECT auto_sync_guests INTO v_enabled FROM settings LIMIT 1;
  IF v_enabled IS NOT TRUE THEN RETURN NEW; END IF;
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;
  v_email := lower(trim(coalesce(NEW.guest_email, '')));
  IF v_email = '' THEN RETURN NEW; END IF;
  SELECT site_number INTO v_site_number FROM sites WHERE id = NEW.site_id;
  SELECT id, last_visit INTO v_existing_id, v_existing_last_visit
  FROM guests WHERE lower(email) = v_email LIMIT 1;
  IF v_existing_id IS NULL THEN
    INSERT INTO guests (name, email, phone, site_number, last_visit, is_seasonal)
    VALUES (coalesce(NEW.guest_name, ''), NEW.guest_email, coalesce(NEW.guest_phone, ''),
            coalesce(v_site_number, ''), NEW.arrival_date::date, false);
  ELSE
    IF NEW.arrival_date::date > coalesce(v_existing_last_visit, '0001-01-01'::date) THEN
      UPDATE guests SET last_visit = NEW.arrival_date::date,
        site_number = coalesce(v_site_number, site_number) WHERE id = v_existing_id;
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$func$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_guest_from_reservation ON reservations;
CREATE TRIGGER trg_sync_guest_from_reservation
AFTER INSERT ON reservations
FOR EACH ROW EXECUTE FUNCTION sync_guest_from_reservation();

-- Seed exactly one settings row (app reads it via .single())
INSERT INTO settings (park_name)
SELECT 'My Campground'
WHERE NOT EXISTS (SELECT 1 FROM settings);

-- ============================================================
-- ROW LEVEL SECURITY (permissive: anon key works)
-- ============================================================

DO $$
DECLARE t text; tables text[] := ARRAY['addons','blocked_dates','broadcast_emails','cancellation_rules','categories','discounts','electric_readings','fees','folio_line_items','folio_payments','folios','guests','min_stay_rules','pricing_rules','product_categories','products','reservation_addons','reservations','settings','site_categories','sites','terminal_checkouts','square_connections'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "Allow all" ON %I', t);
    EXECUTE format('CREATE POLICY "Allow all" ON %I FOR ALL USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- ============================================================
-- STORAGE BUCKETS + POLICIES
-- (buckets are also created via the Supabase Storage API during
--  onboarding; these statements are idempotent and safe here too)
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('logos', 'logos', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public)
VALUES ('site-photos', 'site-photos', true)
ON CONFLICT (id) DO NOTHING;

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
