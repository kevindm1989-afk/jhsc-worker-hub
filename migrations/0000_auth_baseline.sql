CREATE TYPE "public"."auth_event_kind" AS ENUM('signup', 'login.passkey', 'login.password', 'login.totp', 'login.recovery', 'login.failed', 'logout', 'session.refreshed', 'session.revoked', 'step_up.granted', 'step_up.denied', 'lockout.applied', 'lockout.cleared', 'passkey.registered', 'passkey.removed', 'totp.enrolled', 'totp.reset', 'recovery_codes.generated', 'recovery_codes.consumed', 'first_run.completed');--> statement-breakpoint
CREATE TYPE "public"."login_attempt_outcome" AS ENUM('success', 'failure');--> statement-breakpoint
CREATE TYPE "public"."webauthn_purpose" AS ENUM('register', 'authenticate', 'step_up');--> statement-breakpoint
CREATE TABLE "auth_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"kind" "auth_event_kind" NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier_hash" "bytea" NOT NULL,
	"ip" "inet",
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" "login_attempt_outcome" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkey_credentials" (
	"id" "bytea" PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"public_key" "bytea" NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"attestation_type" text DEFAULT 'none' NOT NULL,
	"nickname" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "password_credentials" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"algo_params" jsonb DEFAULT '{"algo":"argon2id","mem_kib":65536,"ops":3,"version":13}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"refresh_token_hash" "bytea" NOT NULL,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"step_up_until" timestamp with time zone,
	"ip_at_create" "inet",
	"ua_at_create" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "setup_state" (
	"id" smallint PRIMARY KEY NOT NULL,
	"first_run_completed_at" timestamp with time zone,
	"first_run_completed_by" uuid,
	CONSTRAINT "setup_state_singleton" CHECK ("setup_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "totp_credentials" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"secret_ciphertext" "bytea" NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_step" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"display_name_ciphertext" "bytea" NOT NULL,
	"email_ciphertext" "bytea" NOT NULL,
	"email_lookup_hash" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webauthn_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"challenge" "bytea" NOT NULL,
	"purpose" "webauthn_purpose" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "auth_events" ADD CONSTRAINT "auth_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey_credentials" ADD CONSTRAINT "passkey_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_credentials" ADD CONSTRAINT "password_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_state" ADD CONSTRAINT "setup_state_first_run_completed_by_users_id_fk" FOREIGN KEY ("first_run_completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "totp_credentials" ADD CONSTRAINT "totp_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_events_ts_idx" ON "auth_events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "auth_events_actor_ts_idx" ON "auth_events" USING btree ("actor_id","ts");--> statement-breakpoint
CREATE INDEX "auth_events_kind_ts_idx" ON "auth_events" USING btree ("kind","ts");--> statement-breakpoint
CREATE INDEX "login_attempts_identifier_ts_idx" ON "login_attempts" USING btree ("identifier_hash","ts");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_ts_idx" ON "login_attempts" USING btree ("ip","ts");--> statement-breakpoint
CREATE INDEX "passkey_credentials_user_idx" ON "passkey_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recovery_codes_user_idx" ON "recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_refresh_idx" ON "sessions" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "webauthn_challenges_challenge_idx" ON "webauthn_challenges" USING btree ("challenge");--> statement-breakpoint
CREATE INDEX "webauthn_challenges_expires_idx" ON "webauthn_challenges" USING btree ("expires_at");--> statement-breakpoint
-- Singleton seed for the first-run gate. The CHECK constraint above
-- already prevents any row with id != 1; this INSERT establishes the
-- one row the gate code reads on every boot.
INSERT INTO "setup_state" ("id", "first_run_completed_at") VALUES (1, NULL);