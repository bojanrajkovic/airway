CREATE SCHEMA "notes";
--> statement-breakpoint
CREATE TABLE "notes"."finding_snapshots" (
	"note_id" bigint NOT NULL,
	"derived_version" integer NOT NULL,
	"ran_at" timestamp with time zone NOT NULL,
	"result" jsonb NOT NULL,
	CONSTRAINT "finding_snapshots_note_id_derived_version_pk" PRIMARY KEY("note_id","derived_version")
);
--> statement-breakpoint
CREATE TABLE "notes"."findings" (
	"note_id" bigint PRIMARY KEY NOT NULL,
	"category" text DEFAULT 'finding' NOT NULL,
	"short_code" text NOT NULL,
	CONSTRAINT "findings_category" CHECK ("notes"."findings"."category" = 'finding')
);
--> statement-breakpoint
CREATE TABLE "notes"."notes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notes"."notes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"first_night" date NOT NULL,
	"last_night" date,
	"date_precision" text DEFAULT 'day' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"category" text NOT NULL,
	"body" text NOT NULL,
	"author_email" text NOT NULL,
	"author_name" text NOT NULL,
	"author_channel" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"updated_by_email" text,
	"updated_by_name" text,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "notes_id_category" UNIQUE("id","category"),
	CONSTRAINT "notes_category" CHECK ("notes"."notes"."category" in ('procedure', 'study', 'medication', 'illness', 'equipment', 'finding', 'other')),
	CONSTRAINT "notes_author_channel" CHECK ("notes"."notes"."author_channel" in ('web', 'mcp')),
	CONSTRAINT "notes_date_precision" CHECK ("notes"."notes"."date_precision" in ('day', 'month', 'year')),
	CONSTRAINT "notes_dates_match_precision" CHECK ("notes"."notes"."first_night" = date_trunc("notes"."notes"."date_precision", "notes"."notes"."first_night"::timestamp)::date
        and ("notes"."notes"."last_night" is null
          or "notes"."notes"."last_night" = date_trunc("notes"."notes"."date_precision", "notes"."notes"."last_night"::timestamp)::date)),
	CONSTRAINT "notes_last_night_order" CHECK ("notes"."notes"."last_night" >= "notes"."notes"."first_night"),
	CONSTRAINT "notes_time_range" CHECK (("notes"."notes"."starts_at" is null and "notes"."notes"."ends_at" is null)
        or ("notes"."notes"."starts_at" is not null and "notes"."notes"."ends_at" is not null
          and "notes"."notes"."starts_at" < "notes"."notes"."ends_at" and "notes"."notes"."date_precision" = 'day')),
	CONSTRAINT "notes_body_length" CHECK ("notes"."notes"."body" ~ '[^[:space:]]'
        and char_length("notes"."notes"."body") <= 32000),
	CONSTRAINT "notes_updated_together" CHECK (("notes"."notes"."updated_at" is null) = ("notes"."notes"."updated_by_email" is null)
        and ("notes"."notes"."updated_at" is null) = ("notes"."notes"."updated_by_name" is null))
);
--> statement-breakpoint
CREATE TABLE "notes"."query_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notes"."query_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"short_code" text NOT NULL,
	"author_email" text NOT NULL,
	"author_name" text NOT NULL,
	"author_channel" text NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_count" integer NOT NULL,
	"truncated" boolean NOT NULL,
	CONSTRAINT "query_history_author_channel" CHECK ("notes"."query_history"."author_channel" in ('web', 'mcp')),
	CONSTRAINT "query_history_row_count" CHECK ("notes"."query_history"."row_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "notes"."short_links" (
	"code" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"spec" jsonb,
	"sql" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "short_links_content_matches_kind" CHECK (("notes"."short_links"."kind" = 'spec' and "notes"."short_links"."spec" is not null and "notes"."short_links"."sql" is null)
        or ("notes"."short_links"."kind" = 'sql' and "notes"."short_links"."sql" is not null and "notes"."short_links"."spec" is null))
);
--> statement-breakpoint
ALTER TABLE "notes"."finding_snapshots" ADD CONSTRAINT "finding_snapshots_note_id_findings_note_id_fk" FOREIGN KEY ("note_id") REFERENCES "notes"."findings"("note_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes"."findings" ADD CONSTRAINT "findings_short_code_short_links_code_fk" FOREIGN KEY ("short_code") REFERENCES "notes"."short_links"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes"."findings" ADD CONSTRAINT "findings_note" FOREIGN KEY ("note_id","category") REFERENCES "notes"."notes"("id","category") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes"."query_history" ADD CONSTRAINT "query_history_short_code_short_links_code_fk" FOREIGN KEY ("short_code") REFERENCES "notes"."short_links"("code") ON DELETE no action ON UPDATE no action;