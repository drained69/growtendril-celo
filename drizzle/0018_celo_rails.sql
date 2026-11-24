CREATE TABLE "altana_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"public_key" text NOT NULL,
	"sealed_key" text NOT NULL,
	"session" jsonb NOT NULL,
	"cap_micro" bigint NOT NULL,
	"period" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"grant_tx_hash" text,
	"revoke_tx_hash" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corridor_payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"project_id" text NOT NULL,
	"token" text NOT NULL,
	"token_address" text NOT NULL,
	"rfq_id" text NOT NULL,
	"taker_pays_micro" bigint NOT NULL,
	"buy_amount" text NOT NULL,
	"fee_amount" text NOT NULL,
	"rate_ray" text NOT NULL,
	"swap_tx_hash" text,
	"payout_tx_hash" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corridor_payouts_transaction_id_unique" UNIQUE("transaction_id")
);
--> statement-breakpoint
ALTER TABLE "billing_invoices" ALTER COLUMN "chain" SET DEFAULT 'Celo';--> statement-breakpoint
ALTER TABLE "subscriptions" ALTER COLUMN "provider" SET DEFAULT 'celo';--> statement-breakpoint
ALTER TABLE "wallets" ALTER COLUMN "blockchain" SET DEFAULT 'CELO-TESTNET';--> statement-breakpoint
ALTER TABLE "kols" ADD COLUMN "payout_token" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "payout_token" text;--> statement-breakpoint
ALTER TABLE "altana_sessions" ADD CONSTRAINT "altana_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "altana_sessions" ADD CONSTRAINT "altana_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corridor_payouts" ADD CONSTRAINT "corridor_payouts_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corridor_payouts" ADD CONSTRAINT "corridor_payouts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "altana_one_open_session" ON "altana_sessions" USING btree ("project_id") WHERE "altana_sessions"."status" in ('pending', 'active');