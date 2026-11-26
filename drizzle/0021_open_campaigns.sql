CREATE TABLE "open_agreements" (
	"id" text PRIMARY KEY NOT NULL,
	"open_campaign_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"address" text NOT NULL,
	"terms_hash" text NOT NULL,
	"terms_version" text NOT NULL,
	"message" text NOT NULL,
	"signature" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_agreements_participant_id_unique" UNIQUE("participant_id")
);
--> statement-breakpoint
CREATE TABLE "open_campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"program_id" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"task" text NOT NULL,
	"proof_kind" text NOT NULL,
	"required_text" text,
	"criteria" text,
	"min_score" integer,
	"duration_days" integer NOT NULL,
	"ends_at" timestamp with time zone,
	"terms_text" text,
	"terms_version" text,
	"terms_hash" text,
	"auto_approve" boolean DEFAULT true NOT NULL,
	"agent_address" text,
	"escrow_contract" text,
	"escrow_salt" text,
	"escrow_campaign_id" text,
	"owner_address" text,
	"funding_tx" text,
	"funding_block" text,
	"funded_at" timestamp with time zone,
	"refund_tx" text,
	"refunded_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_campaigns_program_id_unique" UNIQUE("program_id"),
	CONSTRAINT "open_campaigns_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "open_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"open_campaign_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"proof_url" text NOT NULL,
	"status" text DEFAULT 'checking' NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"score" integer,
	"author" text,
	"proof_text_hash" text,
	"quality" integer,
	"outcomes" integer DEFAULT 0 NOT NULL,
	"amount_micro" bigint,
	"reward_id" text NOT NULL,
	"evidence_hash" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"reject_reason" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"queue_tx" text,
	"queue_error" text,
	"queue_failures" integer DEFAULT 0 NOT NULL,
	"queued_at" timestamp with time zone,
	"claimable_at" timestamp with time zone,
	"objection_reason" text,
	"object_tx" text,
	"objected_at" timestamp with time zone,
	"pay_tx" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_claims_participant_id_unique" UNIQUE("participant_id"),
	CONSTRAINT "open_claims_reward_id_unique" UNIQUE("reward_id")
);
--> statement-breakpoint
CREATE TABLE "open_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"open_campaign_id" text NOT NULL,
	"user_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"code" text NOT NULL,
	"payout_address" text NOT NULL,
	"status" text DEFAULT 'agreed' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_participants_campaign_id_unique" UNIQUE("campaign_id"),
	CONSTRAINT "open_participants_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "creator_programs" ADD COLUMN "mode" text DEFAULT 'invite' NOT NULL;--> statement-breakpoint
ALTER TABLE "creator_programs" ADD COLUMN "escrow_contract" text;--> statement-breakpoint
ALTER TABLE "creator_programs" ADD COLUMN "escrow_version" text;--> statement-breakpoint
ALTER TABLE "open_agreements" ADD CONSTRAINT "open_agreements_open_campaign_id_open_campaigns_id_fk" FOREIGN KEY ("open_campaign_id") REFERENCES "public"."open_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_agreements" ADD CONSTRAINT "open_agreements_participant_id_open_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."open_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_agreements" ADD CONSTRAINT "open_agreements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_campaigns" ADD CONSTRAINT "open_campaigns_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_campaigns" ADD CONSTRAINT "open_campaigns_program_id_creator_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."creator_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_campaigns" ADD CONSTRAINT "open_campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_claims" ADD CONSTRAINT "open_claims_open_campaign_id_open_campaigns_id_fk" FOREIGN KEY ("open_campaign_id") REFERENCES "public"."open_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_claims" ADD CONSTRAINT "open_claims_participant_id_open_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."open_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_participants" ADD CONSTRAINT "open_participants_open_campaign_id_open_campaigns_id_fk" FOREIGN KEY ("open_campaign_id") REFERENCES "public"."open_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_participants" ADD CONSTRAINT "open_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_participants" ADD CONSTRAINT "open_participants_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "open_campaigns_project_idx" ON "open_campaigns" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "open_claim_proof_uq" ON "open_claims" USING btree ("open_campaign_id","proof_url");--> statement-breakpoint
CREATE INDEX "open_claims_status_idx" ON "open_claims" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "open_participant_user_uq" ON "open_participants" USING btree ("open_campaign_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "open_participant_wallet_uq" ON "open_participants" USING btree ("open_campaign_id","payout_address");