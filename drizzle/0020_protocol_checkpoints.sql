CREATE TABLE "protocol_checkpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"root" text NOT NULL,
	"records" integer NOT NULL,
	"leaves" jsonb NOT NULL,
	"covered_until" timestamp with time zone NOT NULL,
	"tx_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "protocol_checkpoints" ADD CONSTRAINT "protocol_checkpoints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "protocol_checkpoint_number_uq" ON "protocol_checkpoints" USING btree ("project_id","number");