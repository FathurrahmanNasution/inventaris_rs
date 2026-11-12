-- Additive migration. Apply explicitly to the intended database; never at app startup.
BEGIN;
CREATE TABLE IF NOT EXISTS stock_documents (
  document_id uuid PRIMARY KEY,
  transaction_type varchar(20) NOT NULL CHECK (transaction_type IN ('IN', 'OUT')),
  reference_number varchar(100) NOT NULL CHECK (length(btrim(reference_number)) > 0),
  transaction_date date NOT NULL,
  supplier varchar(255),
  destination varchar(100),
  notes varchar(300),
  user_id integer REFERENCES users(user_id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((transaction_type = 'IN' AND supplier IS NOT NULL) OR
         (transaction_type = 'OUT' AND destination IS NOT NULL))
);
ALTER TABLE stock_transactions ADD COLUMN IF NOT EXISTS document_id uuid REFERENCES stock_documents(document_id) ON DELETE RESTRICT;
ALTER TABLE stock_transactions ADD COLUMN IF NOT EXISTS unit_price numeric(15,2) CHECK (unit_price >= 0);
CREATE INDEX IF NOT EXISTS stock_transactions_document_idx ON stock_transactions(document_id);
CREATE INDEX IF NOT EXISTS stock_batches_fefo_idx ON medicine_batches(medicine_code, expired_date, batch_number) WHERE current_qty > 0;
COMMIT;
