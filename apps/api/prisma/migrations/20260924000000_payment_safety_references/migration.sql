-- Payment safety hardening: additive only. No historical migration is rewritten.
-- Provider references are captured on the order/payment so a callback can be
-- matched to exactly one checkout and replayed safely.

-- AlterTable: invoice/job timestamps and ownership history
ALTER TABLE "Invoice"
  ADD COLUMN "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Job"
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Ownership"
  ADD COLUMN "periodEnd" TIMESTAMP(3);

-- AlterTable: payment provider/session/payment/event references
ALTER TABLE "PaymentOrder"
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'viva',
  ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'EUR',
  ADD COLUMN "sessionRef" TEXT,
  ADD COLUMN "paymentRef" TEXT,
  ADD COLUMN "eventRef" TEXT,
  ADD COLUMN "pspRef" TEXT,
  ADD COLUMN "settledAt" TIMESTAMP(3);

-- Existing orderCode is the provider's checkout reference for all historical
-- providers. Recover the provider/currency from the invoice's building rather
-- than labelling every historical international order as Viva.
UPDATE "PaymentOrder" po
SET "provider" = COALESCE(b."pspProvider", 'viva'),
    "currency" = COALESCE(b."currency", 'EUR')
FROM "Invoice" i
JOIN "Unit" u ON u."id" = i."unitId"
JOIN "Building" b ON b."id" = i."buildingId"
WHERE po."invoiceId" = i."id";

-- Backfill only the missing session column; do not infer a payment or event id
-- that the PSP did not provide.
UPDATE "PaymentOrder"
SET "sessionRef" = "orderCode"
WHERE "sessionRef" IS NULL;

ALTER TABLE "Payment"
  ADD COLUMN "paymentOrderId" TEXT,
  ADD COLUMN "provider" TEXT,
  ADD COLUMN "currency" TEXT,
  ADD COLUMN "eventRef" TEXT;

-- CreateIndex: exact-reference and replay constraints
CREATE UNIQUE INDEX "PaymentOrder_eventRef_key" ON "PaymentOrder"("eventRef");
CREATE UNIQUE INDEX "PaymentOrder_pspRef_key" ON "PaymentOrder"("pspRef");
CREATE INDEX "PaymentOrder_provider_sessionRef_idx" ON "PaymentOrder"("provider", "sessionRef");
CREATE INDEX "PaymentOrder_provider_paymentRef_idx" ON "PaymentOrder"("provider", "paymentRef");

CREATE UNIQUE INDEX "Payment_paymentOrderId_key" ON "Payment"("paymentOrderId");
CREATE UNIQUE INDEX "Payment_pspRef_key" ON "Payment"("pspRef");
CREATE INDEX "Payment_provider_currency_idx" ON "Payment"("provider", "currency");

-- RefreshSession.tokenHash is a one-time token identity. The old non-unique
-- lookup index is redundant after the unique index is installed.
DROP INDEX IF EXISTS "RefreshSession_tokenHash_idx";
CREATE UNIQUE INDEX "RefreshSession_tokenHash_key" ON "RefreshSession"("tokenHash");

-- AddForeignKey
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_paymentOrderId_fkey"
  FOREIGN KEY ("paymentOrderId") REFERENCES "PaymentOrder"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
