---
name: careful-data-check
description: Checklist for answering questions about data files (CSV, logs, configs) exactly right and in the exact format asked for.
---

# Careful data check

Use this whenever a task asks you to filter, count, total, match or extract values from files.

## 1. Read everything first

- Open every file the task mentions, and read each one in full before answering. Do not stop at the first rows.
- If a file the task names does not exist, look at what is in the folder (README, newer versions of the file) and use the file that is actually in use. Ignore templates and examples unless the task asks for them.

## 2. Parse the data correctly

- CSV fields in double quotes can contain commas: `"Martin, Hale & Co"` is one field. Never split a CSV line on every comma.
- Normalise identifiers before matching. `inv-003`, `INV003` and `INV-003` can be the same thing. Compare after fixing case and separators.
- One record can appear more than once (for example, an invoice paid in two payments). Add those rows up before deciding.

## 3. Check every row against every rule

- Write the rules down as a list, then go through the rows one by one and test each rule. A row qualifies only if all rules hold.
- Respect boundaries exactly:
  - "or more" / "at least" means `>=`; "more than" means `>`.
  - "within the last 30 days" with a stated cut-off date includes that date.
- Count dates carefully. Work out the exact cut-off date first, then compare each date to it. Do not estimate.
- For money, keep two decimals and recompute the total after you have the final list.

## 4. Double-check before answering

- Re-test any row that was close to a boundary (exactly 50, exactly 10000, exactly the cut-off date).
- Re-count the final list and re-add the final total.

## 5. Reply in the exact format only

- Output exactly the format the task asks for, and nothing else: no explanation, no working, no Markdown, no extra spaces.
- Match separators, ordering ("sorted alphabetically", "ascending") and decimals exactly.
