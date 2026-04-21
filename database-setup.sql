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
  liability_waiver_text text DEFAULT '',
  show_site_map boolean DEFAULT false
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
  date date NOT NULL,
  end_date date,
  reason text,
  notes text DEFAULT '',
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- Addons table
CREATE TABLE IF NOT EXISTS addons (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  description text,
  price integer NOT NULL DEFAULT 0,
  is_early_checkin boolean DEFAULT false,
  is_active boolean DEFAULT true,
  display_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
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
  description text DEFAULT '',
  discount_type text NOT NULL DEFAULT 'percentage',
  discount_value numeric NOT NULL DEFAULT 0,
  valid_from date,
  valid_until date,
  max_uses integer,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- Cancellation rules table
CREATE TABLE IF NOT EXISTS cancellation_rules (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name text DEFAULT '',
  start_date date,
  end_date date,
  deposit_refundable boolean DEFAULT true,
  refund_percent numeric DEFAULT 100,
  cancellation_deadline_days integer DEFAULT 7,
  policy_text text DEFAULT '',
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- Insert default rows
INSERT INTO settings (id, park_name) VALUES (1, 'My Campground') ON CONFLICT (id) DO NOTHING;
INSERT INTO cancellation_rules (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Fees table (taxes and other charges)
CREATE TABLE IF NOT EXISTS fees (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('percentage', 'flat')),
  amount numeric NOT NULL,
  applies_to text DEFAULT 'all',
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);
