# Supabase Plugin

Supabase and PostgreSQL development and data-analysis integration — covering migrations, Edge Functions, auth, RLS, data analysis, safe querying, and schema inspection.

## What this plugin adds

Seven sub-skills covering the full Supabase and PostgreSQL development lifecycle:

**Development (Supabase)**
- **`auth-and-security`** — Audit Supabase auth configuration, RLS coverage, and service-role key exposure. The security gate for every Supabase project.
- **`edge-function-workflow`** — Draft, review, and manage Supabase Edge Functions for webhook handling and serverless logic.
- **`migration-workflow`** — Review and manage Supabase Postgres migrations safely with confirmation gates.
- **`postgres-best-practices`** — Review Postgres schema and query patterns against Supabase best practices.

**Data Analysis (PostgreSQL)**
- **`data-analysis`** — Run analytical queries against PostgreSQL with explicit read-only guards.
- **`safe-query`** — Run SELECT queries with read-only guards and query plan analysis.
- **`schema-inspection`** — Inspect PostgreSQL schema: tables, columns, indexes, constraints, and relations.

## Platform requirement

No specific platform requirement. Works on any OS with network access to the target Supabase project or PostgreSQL instance.

## Prerequisites

Each sub-skill has its own connection requirements:

| Sub-skill | Setup required |
|---|---|
| `auth-and-security` | Supabase access token + project ref |
| `edge-function-workflow` | Supabase access token + project ref |
| `migration-workflow` | Supabase access token + project ref |
| `postgres-best-practices` | Supabase access token + project ref |
| `data-analysis` | PostgreSQL read-only connection string |
| `safe-query` | PostgreSQL read-only connection string |
| `schema-inspection` | PostgreSQL read-only connection string |

## Migration from individual plugins

This plugin supersedes two former marketplace entries:

- `supabase-development` → now `supabase` / skills: `auth-and-security`, `edge-function-workflow`, `migration-workflow`, `postgres-best-practices`
- `postgres-readonly` → now `supabase` / skills: `data-analysis`, `safe-query`, `schema-inspection`

Uninstall the old plugins after upgrading to avoid confusion.

## When to suggest this plugin

Suggest when the user mentions Supabase, PostgreSQL, database migrations, Edge Functions, auth configuration, RLS policies, data analysis, or safe querying.
