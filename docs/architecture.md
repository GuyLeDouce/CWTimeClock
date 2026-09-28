# Architecture and operating rules

The supplied specification is retained in `docs/original-requirements.md`. It ends after “Types should include: SHOP”; the schema completes the four specified work types SHOP, SITE, OFFICE and TRAVEL.

## Boundaries

- Next.js App Router renders the application. Authenticated pages and APIs are dynamic and never cached. The service worker caches only static assets and a public offline fallback.
- PostgreSQL is authoritative. Prisma transactions use serializable isolation, retry serialization/unique races, and acquire per-employee advisory locks in a consistent order. Live punch timestamps come from the database after acquiring the lock; replayed offline punches carry the client tap time within a validated 24-hour window.
- The browser supplies a random idempotency key and the last segment ID it saw. A retry of the same payload/key returns its committed receipt. A changed payload or stale segment is rejected. Punches tapped offline are queued in localStorage with the tap time and replayed in order on reconnect; the server accepts the tap time within a 24-hour window (small future skew allowed) and records it in the audit trail, while live punches always use the database clock.
- Closed segments are split at company-local midnight. This keeps a line within a calendar day and completed-week approval boundaries, including 23/25-hour DST days. An early scan uses the employee's local earliest paid start; switching before that start yields zero-length segments without negative paid time.
- Original scan/end timestamps are retained. PM corrections change effective timestamps and metadata only, require a reason, preserve approval history, and reset the current approval state. SQL triggers protect original timestamps, exported records, and append-only audits.
- Database partial unique indexes enforce one open workday, segment, and owner visit. A GiST exclusion constraint prevents overlapping employee segments even if a future client bypasses application validation.
- Work modes are permissions on the same account. Employees choose a mode at shop clock-in and can change assigned work modes at the shop QR during the day; PM/Owner dashboards never create time. Controllers must clock in before opening accounting tools. Assignment tables separately constrain employee projects/tasks and PM employee/project access.
- PM access is the intersection of assigned employees and assigned projects. Owners have full access. Controllers have full operational/accounting read access while clocked in. An ADMIN role alone does not grant payroll visibility or PM approvals. Only an Owner can manage Owner/Admin accounts.

## Accounting

Weeks run Monday 00:00 through the next Monday in the company timezone (default America/Toronto). The app does not guess overtime rules, paid/unpaid breaks, statutory holidays, rounding agreements, wage rates, or payroll deductions. All recorded non-travel work is exported as labour hours; travel is a separate column. Accounting applies the company's payroll rules downstream. Integer milliseconds are summed before rounding. CSVs include exact durations plus decimal hours to four places.

Finalization accepts closed records from completed weeks and normally requires PM approval. Normal labour requires an accounting code. Owner override requires a written reason and still rejects invalid/overlapping records, missing labour codes, open workdays, and duplicate exports. Export batches retain exact CSV snapshots. Exported lines cannot be edited; any later financial correction is handled as an accounting adjustment. A report download never changes records. Email delivery is a separate explicit action to the configured accounting recipient.

## Location and privacy

No GPS permissions or APIs are used. Truck location means the last inferred destination from a truck QR interaction, not live physical location. Shop is a labelled default if no scan evidence exists. Employee selections can be mistaken, and a static printed QR can be photographed: a QR is a workflow selector, not proof of physical presence. This application deliberately does not claim location verification.

## Authentication and email

Passwords use salted scrypt. Random session tokens are stored only as hashes in the database and sent in HTTP-only, same-site cookies; production uses a Secure __Host- cookie. Sessions expire after 30 days. Deactivation and password resets revoke sessions. Login/reset requests are rate limited in PostgreSQL, shared across instances. Mutations require the exact configured APP_URL Origin and JSON requests. The app never trusts a browser timestamp.

Password links are single-use, expire after 30 minutes, and reset all existing sessions. Desktop links expire after 15 minutes and require an already authenticated account matching the token recipient; they cannot log someone in. Merely opening an emailed link does not consume it, avoiding email-scanner issues. SMTP is configured by environment variables; console email is development-only. No email provider credentials are committed.

## Deliberate setup choices

- No invented company logo. The app displays a marked placeholder; installation icons are generic clock placeholders.
- New CSV imports are all-or-nothing, up to 250 rows. Duplicate/existing records are rejected with row-level errors; updates and assignment changes use Admin so an import cannot accidentally replace permission scopes.
- Site visits are separate from payroll and cannot silently become paid employee time. A future policy to count them requires a reviewed change rather than an automatic switch.
- Reporting filters identify lines by their effective start. Lines closed by the clock are already split at midnight. Corrections must stay within one company-local date. The INFO and My Hours totals clip live/closed intervals at period boundaries.
- No automatic deductions or automatic clock-out. Unclosed days remain visible and cannot be approved/exported. Employees can clock out on their next scan, or a scoped PM/Owner can close a forgotten shift through Verify with an explicit end time and reason. This preserves the missing original end scan as null and requires normal approval.
- No hard delete in Admin; deactivate historical entities. Existing time remains reportable.

## Operation

Use private PostgreSQL networking, enforce HTTPS, enable backups and restore drills, and limit Railway access to administrators. Set the final APP_URL before printing QRs. A change of domain requires reprinting/reissuing codes. Schedule retention/cleanup of expired sessions, tokens, rate-limit buckets, and old punch receipts based on company policy; never delete time, approval, audit, or export history as part of that cleanup. Monitor the `/api/health` readiness endpoint and application error request IDs. Keep dependencies patched and run CI on changes.
