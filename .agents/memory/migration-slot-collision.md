---
name: Drizzle migration slot collision on rebase
description: How to resolve two parallel tasks generating the same drizzle migration index
---
When two tasks both generate migration index NNNN, rebase conflicts hit `_journal.json` and `NNNN_snapshot.json`.
**How to resolve:** keep main's NNNN (snapshot = main's side verbatim), rename our SQL to NNNN+1, write a merged NNNN+1 snapshot (main's snapshot + our tables/columns, prevId = main's id, fresh uuid id), append a journal entry with a later `when`.
**Local DB gotcha:** our tables already exist locally but main's don't, and drizzle migrate compares only timestamps — replay fails with 42P07. Fix: apply main's SQL manually via psql, then INSERT both file hashes (sha256sum of the .sql) with their journal `when` values into drizzle.__drizzle_migrations; migrate then runs clean.
