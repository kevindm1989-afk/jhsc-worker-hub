-- Milestone 1.7 (ADR-0006): workplace_keys + evidence_files.
--
-- workplace_keys: X25519 key pair for sealed-box encryption. Public key
-- shipped to the browser per session; private key sealed under workplace
-- KEK and opened only inside the API decrypt-and-stream handler.
--
-- evidence_files: per-file metadata + sealed DEK + ciphertext SHA-256.
-- The actual ciphertext blob lives in Tigris, addressed by storage_key.
-- All four sensitive fields (private_key, sealed_dek, two SHA-256s) are
-- bytea; the schema sees only ciphertext + hashes.

CREATE TABLE "workplace_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"public_key" "bytea" NOT NULL,
	"private_key_ct" "bytea" NOT NULL,
	"private_key_dek_ct" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "workplace_keys_public_key_length_check" CHECK (octet_length("public_key") = 32),
	-- A retired key keeps active=false; an active key has no retired_at.
	-- The route layer further enforces "at most one active row" via
	-- application logic, since Postgres partial unique on (true) is
	-- straightforward but the row-count invariant is more flexible.
	CONSTRAINT "workplace_keys_retirement_check" CHECK (
		("active" = true AND "retired_at" IS NULL)
		OR ("active" = false AND "retired_at" IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workplace_keys_only_one_active" ON "workplace_keys" USING btree ("active") WHERE "active" = true;--> statement-breakpoint
CREATE INDEX "workplace_keys_active_idx" ON "workplace_keys" USING btree ("active");
--> statement-breakpoint
CREATE TABLE "evidence_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"linked_type" text NOT NULL,
	"linked_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"ciphertext_sha256" "bytea" NOT NULL,
	"sealed_dek" "bytea" NOT NULL,
	"workplace_key_id" uuid NOT NULL,
	"plaintext_sha256" "bytea" NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"captured_at" timestamp with time zone,
	"gps_latitude" numeric(8, 4),
	"gps_longitude" numeric(8, 4),
	"gps_accuracy_m" numeric(8, 2),
	"audit_idx" bigint NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_files_linked_type_check" CHECK ("linked_type" IN
		('hazard','action_item','inspection_finding','recommendation','incident')),
	CONSTRAINT "evidence_files_mime_type_check" CHECK ("mime_type" IN
		('image/jpeg','image/png','image/webp','image/heic','audio/webm','audio/ogg','application/pdf')),
	CONSTRAINT "evidence_files_byte_size_check" CHECK ("byte_size" > 0 AND "byte_size" <= 52428800),
	CONSTRAINT "evidence_files_ciphertext_sha256_length_check" CHECK (octet_length("ciphertext_sha256") = 32),
	CONSTRAINT "evidence_files_plaintext_sha256_length_check" CHECK (octet_length("plaintext_sha256") = 32),
	-- GPS columns are all-or-nothing. If any one is set, the other two
	-- must be set (lat + lon are a pair, accuracy is metadata about
	-- the fix). Nullable GPS is allowed (capture without permission).
	CONSTRAINT "evidence_files_gps_completeness_check" CHECK (
		("gps_latitude" IS NULL AND "gps_longitude" IS NULL)
		OR ("gps_latitude" IS NOT NULL AND "gps_longitude" IS NOT NULL)
	),
	CONSTRAINT "evidence_files_workplace_key_fk"
		FOREIGN KEY ("workplace_key_id") REFERENCES "workplace_keys"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "evidence_files_audit_idx_fk"
		FOREIGN KEY ("audit_idx") REFERENCES "audit_log"("idx")
		ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "evidence_files_uploaded_by_fk"
		FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id")
		ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_files_storage_key_unique" ON "evidence_files" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_files_audit_idx_unique" ON "evidence_files" USING btree ("audit_idx");--> statement-breakpoint
CREATE INDEX "evidence_files_linked_idx" ON "evidence_files" USING btree ("linked_type","linked_id");--> statement-breakpoint
CREATE INDEX "evidence_files_uploaded_at_idx" ON "evidence_files" USING btree ("uploaded_at");
--> statement-breakpoint
-- T-E6 backstop: the route layer rejects non-(hazard|action_item)
-- linked_type, and the trigger is fail-closed at the SQL layer too --
-- any linked_type the trigger doesn't know how to verify is rejected
-- outright (sec-F4 close-out: previously the ELSE branch silently
-- returned NEW for inspection_finding/recommendation/incident). Each
-- future milestone adds its branch alongside its FK target table --
-- same ratchet the route layer uses.
CREATE OR REPLACE FUNCTION evidence_files_linked_fk_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.linked_type = 'hazard' THEN
    IF NOT EXISTS (SELECT 1 FROM hazards WHERE id = NEW.linked_id) THEN
      RAISE EXCEPTION
        'evidence_files_linked_fk_guard: hazard % does not exist', NEW.linked_id;
    END IF;
  ELSIF NEW.linked_type = 'action_item' THEN
    IF NOT EXISTS (SELECT 1 FROM action_items WHERE id = NEW.linked_id) THEN
      RAISE EXCEPTION
        'evidence_files_linked_fk_guard: action_item % does not exist', NEW.linked_id;
    END IF;
  ELSE
    RAISE EXCEPTION
      'evidence_files_linked_fk_guard: linked_type % not yet supported at trigger layer',
      NEW.linked_type;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER evidence_files_linked_fk_guard_trigger
BEFORE INSERT OR UPDATE ON evidence_files
FOR EACH ROW EXECUTE FUNCTION evidence_files_linked_fk_guard();
