-- Minimal copy of the verified pre-migration schema. Only used in a fresh test schema.
CREATE TABLE users (
  user_id serial PRIMARY KEY, username varchar(100) UNIQUE NOT NULL, password_hash varchar(255) NOT NULL,
  role varchar(50) NOT NULL CHECK (role IN ('admin','gudang','pelayanan','kepala_farmasi')),
  status varchar(20) DEFAULT 'aktif', created_at timestamp DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE audit_logs (
  log_id serial PRIMARY KEY, user_id integer REFERENCES users(user_id) ON DELETE SET NULL,
  action varchar(100) NOT NULL, ip_address varchar(50), created_at timestamp DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE medicines (
  medicine_code varchar(50) PRIMARY KEY, name varchar(255) NOT NULL, category varchar(100) NOT NULL,
  unit varchar(50) NOT NULL, price numeric(15,2) NOT NULL DEFAULT 0, min_stock integer NOT NULL DEFAULT 0,
  status varchar(20) DEFAULT 'aktif', created_at timestamp DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE medicine_batches (
  batch_number varchar(100) PRIMARY KEY, medicine_code varchar(50) NOT NULL REFERENCES medicines(medicine_code) ON DELETE RESTRICT,
  current_qty integer NOT NULL DEFAULT 0 CHECK (current_qty >= 0), expired_date date NOT NULL,
  supplier varchar(255) NOT NULL, created_at timestamp DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE stock_transactions (
  transaction_id serial PRIMARY KEY, medicine_code varchar(50) NOT NULL REFERENCES medicines(medicine_code) ON DELETE RESTRICT,
  batch_number varchar(100) NOT NULL REFERENCES medicine_batches(batch_number) ON DELETE RESTRICT,
  user_id integer REFERENCES users(user_id) ON DELETE SET NULL,
  transaction_type varchar(20) NOT NULL CHECK (transaction_type IN ('IN','OUT','ADJUSTMENT')),
  quantity integer NOT NULL, transaction_date date DEFAULT CURRENT_DATE, reference_number varchar(100), created_at timestamp DEFAULT CURRENT_TIMESTAMP
);
