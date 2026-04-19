-- Run this entire file in your Supabase SQL Editor to set up your database

-- Sites table
CREATE TABLE IF NOT EXISTS sites (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  site_number text NOT NULL,
  site_type text NOT NULL,
  amp_service text,
  max_rv_length numeric,
  hookups text,
  base_rate numeric NOT NULL,
  description text,
  display_order integer,
  is_active boolean DEFAULT true,
  is_available boolean DEFAULT true,
  in_rotation boolean DEFAULT true
);

-- Settings table
CREATE TABLE IF NOT EXISTS settings (
  id integer PRIMARY KEY DEFAULT 1,
  park_name text,
  park_tagline text DEFAULT '',
  park_email text DEFAULT '',
  park_phone text DEFAULT '',
  park_address text DEFAULT '',
  park_website text DEFAULT '',
  season_start date,
  season_end date,
  min_stay integer DEFAULT 1,
  same_day_cutoff_time text DEFAULT '14:00',
  check_in_time text DEFAULT '3:00 PM',
  check_out_time text DEFAULT '11:00 AM',
  extra_adult_fee integer DEFAULT 0,
  extra_child_fee integer DEFAULT 0,
  base_occupancy_adults integer DEFAULT 2,
  base_occupancy_children integer DEFAULT 0,
  cancellation_policy text DEFAULT '',
  closed_season_message text DEFAULT '',
  accent_color text DEFAULT '#3DBDD4',
  liability_waiver_text text DEFAULT ''
);

-- Reservations table
CREATE TABLE IF NOT EXISTS reservations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  site_id uuid REFERENCES sites(id),
  guest_name text NOT NULL,
  guest_email text NOT NULL,
  guest_phone text,
  arrival_date date NOT NULL,
  departure_date date NOT NULL,
  num_adults integer DEFAULT 1,
  num_children integer DEFAULT 0,
  status text DEFAULT 'pending',
  payment_type text DEFAULT 'unpaid',
  total_price numeric,
  amount_paid numeric DEFAULT 0,
  base_nightly_rate numeric DEFAULT 0,
  extra_guest_fee_total numeric DEFAULT 0,
  addons_total numeric DEFAULT 0,
  discount_amount numeric DEFAULT 0,
  discount_code text DEFAULT '',
  square_payment_id text DEFAULT '',
  waiver_signed boolean DEFAULT false,
  special_requests text DEFAULT '',
  site_name text DEFAULT '',
  confirmation_number text DEFAULT '',
  notes text,
  created_at timestamptz DEFAULT now()
);

-- Blocked dates table
CREATE TABLE IF NOT EXISTS blocked_dates (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  site_id uuid REFERENCES sites(id),
  blocked_date date NOT NULL,
  reason text
);

-- Addons table
CREATE TABLE IF NOT EXISTS addons (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  price numeric NOT NULL,
  description text,
  is_active boolean DEFAULT true
);

-- Reservation addons table
CREATE TABLE IF NOT EXISTS reservation_addons (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  reservation_id uuid REFERENCES reservations(id),
  addon_id uuid REFERENCES addons(id),
  quantity integer DEFAULT 1,
  price numeric
);

-- Discounts table
CREATE TABLE IF NOT EXISTS discounts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  code text UNIQUE NOT NULL,
  type text NOT NULL,
  amount numeric NOT NULL,
  is_active boolean DEFAULT true
);

-- Cancellation rules table
CREATE TABLE IF NOT EXISTS cancellation_rules (
  id integer PRIMARY KEY DEFAULT 1,
  full_refund_days integer DEFAULT 7,
  partial_refund_days integer DEFAULT 3,
  partial_refund_percent numeric DEFAULT 50
);

-- Insert default rows
INSERT INTO settings (id, park_name) VALUES (1, 'My Campground') ON CONFLICT (id) DO NOTHING;
INSERT INTO cancellation_rules (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
