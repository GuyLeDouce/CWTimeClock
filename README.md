# Cedar Winds Timeclock

A mobile-first, installable timeclock for **Cedar Winds Design~Build**, with shop/site/office time, travel, PM approvals, accounting exports, and owner/admin tools.

**Stack:** Next.js 16, React, TypeScript, Tailwind/CSS theme variables, PostgreSQL, Prisma, Zod. Deploy with the usual **GitHub → Railway** workflow. The PWA is the same website saved to a phone; there is no App Store build or separate mobile backend.

## What is included

- Individual accounts, salted password hashes, secure 30-day server sessions, reset/setup emails, shared database rate limits, and multi-role permissions.
- Unique revocable shop/truck QR codes with a print screen. Shop start → automatic site travel → truck arrival → task/site switching → clock out. Shop/site/office modes can be changed at the shop during a day.
- Actual scan and effective paid start timestamps, employee-specific earliest starts, configurable IANA timezones, gap-free transitions, duplicate-punch protection, and database overlap constraints.
- Persistent top-left **My Hours** button on authenticated screens. Today’s paid time and last week’s PM-approved hours are scoped to the signed-in employee.
- PM Locate/Verify, employee/project access assignments, audited corrections, forgotten-shift closure, line/day/employee-week selection and approval, and accounting code suggestions.
- Controller Locate/Info/Send after clock-in. Owner management dashboard and separate site visits.
- Employee/project/task/code/truck configuration, permission assignments, CSV templates/preview/all-or-nothing import, and audit history.
- Filtered reporting, approved-only final accounting batches, explicit audited Owner override, immutable CSV snapshots, and SMTP report emails.
- PWA manifest, icons, Apple metadata, offline warning, and static-only service-worker cache. Punches tapped offline are queued on the device and replayed on reconnect.
- SQL migration, safe seed script, Docker/Railway configuration, and unit/database/browser tests with GitHub Actions.

See [architecture and operating rules](docs/architecture.md) for permissions, payroll boundaries, and implementation decisions. The original supplied brief is in [original-requirements.md](docs/original-requirements.md).

## Local setup

Install **Node.js 22 LTS**, Git, and Docker Desktop (or an existing PostgreSQL 16+ server).

```bash
git clone https://github.com/GuyLeDouce/CWTimeClock.git
cd CWTimeClock
cp .env.example .env
# Windows PowerShell: Copy-Item .env.example .env
```

Edit `.env`:

- Set `APP_SECRET` to at least 32 random characters. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- Set `OWNER_EMAIL` to your email and `OWNER_PASSWORD` to a unique password of at least 12 characters.
- Keep `APP_URL=http://localhost:3000` for local development.
- The example `DATABASE_URL` matches the provided Docker database. These example PostgreSQL credentials are for local development only.

```bash
docker compose up -d
npm ci
npm run db:migrate
npm run db:seed
npm run dev
```

Open [localhost:3000](http://localhost:3000) and sign in with your configured owner credentials. The seed creates the owner, the shop QR, and three overhead cost centres. It deliberately does not add fake employees, example projects, wages, or shared passwords. Rerunning it never resets an existing password or role.

`EMAIL_PROVIDER=console` prints development emails in your local terminal. This provider is refused in production. Use SMTP to test actual delivery.

## Deploy to Railway — step by step

1. In Railway, create a project and add a **PostgreSQL** service. Enable database backups for live time records.
2. Add a service from **GitHub Repo → GuyLeDouce/CWTimeClock**. Choose the branch you want to deploy. Railway uses the repository’s Dockerfile and `railway.json`.
3. In the app service, add a reference variable for the database: `DATABASE_URL=${{Postgres.DATABASE_URL}}`. If your database service has a different name, select its `DATABASE_URL` from Railway’s variable reference picker. Use Railway’s private database URL.
4. Generate a public domain for the app service (or configure your own domain). Set `APP_URL` to the exact HTTPS origin, such as `https://timeclock.your-company-domain.ca`, without a path. The Origin check and emailed links use this value.
5. Add the application variables from the table below. Generate your own secret; do not copy the local/CI examples.
6. Deploy. The pre-deploy command runs `npm run db:migrate`; the app starts with `node server.js`. Readiness is checked at `/api/health`. An unsuccessful migration stops the deployment.
7. Set `OWNER_EMAIL`, `OWNER_PASSWORD`, `OWNER_FIRST_NAME`, and `OWNER_LAST_NAME` temporarily in the app service. Run `npm run db:seed` **inside the deployed app service** using Railway SSH (for example, `railway ssh` after linking/selecting the project and service). This ensures the private database address is reachable. Alternatively, for the first deployment only, set the pre-deploy command to `npm run db:migrate && npm run db:seed`, then restore it to `npm run db:migrate` after setup.
8. Remove `OWNER_PASSWORD` from Railway variables after seeding, then redeploy. It is only a setup variable; login uses the stored password hash. Never put real secrets in GitHub or a committed `.env`.
9. Open the HTTPS site and sign in. Finish Admin setup below. Test the complete workflow with a pilot employee before replacing your existing timekeeping process.

| Variable                               | Value / purpose                                                |
| -------------------------------------- | -------------------------------------------------------------- |
| `DATABASE_URL`                         | Reference to the Railway PostgreSQL service                    |
| `APP_URL`                              | Exact public HTTPS origin                                      |
| `APP_SECRET`                           | At least 32 random characters                                  |
| `APP_TIMEZONE`                         | `America/Toronto` for initial setup                            |
| `EMAIL_PROVIDER`                       | `smtp`                                                         |
| `EMAIL_FROM`                           | Verified sender, e.g. `Cedar Winds <timeclock@your-domain.ca>` |
| `SMTP_HOST`                            | Your transactional email provider’s SMTP host                  |
| `SMTP_PORT`                            | Usually `587` for STARTTLS or `465` for implicit TLS           |
| `SMTP_SECURE`                          | `false` for 587, `true` for 465                                |
| `SMTP_USER` / `SMTP_PASSWORD`          | SMTP credentials from your provider                            |
| `OWNER_EMAIL` / `OWNER_PASSWORD`       | Temporary, used only by the seed command                       |
| `OWNER_FIRST_NAME` / `OWNER_LAST_NAME` | Initial owner’s name; default Nelson Evans                     |
| `NEXT_PUBLIC_LOGO_URL`                 | Optional `/cedar-winds-logo.png`; see branding below           |

The Dockerfile sets `NODE_ENV=production`, listens on Railway’s injected `PORT`, and runs as the non-root `node` user. Do not set the start command to `npm run dev`. The database is not needed during the build, but is required for migration, seed, and runtime.

### Scheduled retention cleanup

Ephemeral rows (expired sessions, used or expired action tokens, stale rate-limit buckets, and punch receipts older than 30 days) are removed by `npm run retention`. Time records, export batches, and the audit log are never deleted. In Railway, add a **Cron Job** on the app service running `npm run retention` once a day (for example `0 4 * * *`). The job needs the same `DATABASE_URL` as the app service.

Railway reference: [pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command) and [PostgreSQL](https://docs.railway.com/databases/postgresql).

## Trouble signing in after deployment

First check `APP_URL`: it must be the full public HTTPS origin you open in the browser (including `https://`, with no `/login` path). Keep the Start Command as `node server.js`; setup commands are one-time shell commands, not the web server.

If setup reports `public.Settings does not exist`, run both commands **inside the same deployed app service**:

```bash
npm run db:migrate && npm run db:seed
```

If you manually created an Owner row or entered a normal password in `passwordHash`, the account needs a properly generated hash. Prefer **Forgot password** if email delivery is configured. Otherwise:

1. In the app service variables, set `OWNER_EMAIL` to the existing active Owner's email and `OWNER_PASSWORD` to a new unique password of 12–128 characters. Also ensure `APP_SECRET` is configured. Apply the variables to the deployment.
2. Connect to that app service with Railway SSH and run `npm run db:owner-reset` once.
3. After `Owner password reset`, sign in with those credentials. Remove `OWNER_PASSWORD` from the service variables afterward.

This operator command only resets an **existing active Owner**. It does not create users, grant roles, or overwrite other employee information. It revokes that owner's sessions and outstanding tokens, clears their login attempt limit, and records an audit entry without recording the password or hash. Rerunning `db:seed` never changes an existing account's password.

If a request still fails, logs include a request ID, processing stage, and safe error code. For example, `ERR_INVALID_URL` at `origin-check` points to an invalid `APP_URL`. Do not share passwords, database URLs, or password hashes when requesting help.

If a signed-in page briefly appears and then shows **We couldn’t load this page**, check manually entered timezone values. Use `America/Toronto` for Ontario staff. A database `NULL` or blank employee timezone inherits the company timezone; the literal text `NULL` is invalid. Leading/trailing spaces are normalized. Invalid values now display a timezone warning without hiding Admin, and time recording is blocked until they are corrected. The error screen also provides expandable **Error details** and a server reference when available.

## Open on desktop and email setup

**Open on desktop** emails a short-lived link to the signed-in account's email address. The same website already adapts to desktop screens; you can open its usual URL directly on your computer and sign in without this email shortcut.

For delivery, the app service needs `EMAIL_PROVIDER=smtp`, `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, and any SMTP credentials required by your provider. `EMAIL_PROVIDER=console` is only for local development and does not send email in production. Use the sender and SMTP settings supplied by your provider, and apply/redeploy the app service after changing variables.

Missing configuration now produces an on-screen email setup message. Deploy logs report safe codes such as `EMAIL_NOT_CONFIGURED`, `EMAIL_CONFIGURATION_INVALID`, `EMAIL_AUTH_FAILED`, `EMAIL_CONNECTION_FAILED`, `EMAIL_TLS_FAILED`, or `EMAIL_REJECTED`, without recording provider responses or secrets. Public password-reset requests retain their generic response to avoid revealing whether an account exists.

## Initial Admin setup

1. Add **Accounting codes** and **Tasks**.
2. Add real **Jobsites** and assign each job’s allowed tasks. Overhead cost centres already exist for Administration, Sales, and Estimating.
3. Add **Code mappings**. A project+task mapping takes priority over project-only, then task-only.
4. Add **Employees**. Set their work modes, earliest paid start, optional timezone, available jobsites, and available tasks. A task must be allowed for both that employee and that jobsite.
5. Add management permissions as needed. PMs need both assigned employees and assigned projects. Controllers also need at least one work mode (typically OFFICE), an available cost centre, and must clock in before opening accounting tools. OWNER/ADMIN access is assigned only by an Owner.
6. Save each employee, reopen their record, and click **Send password setup / reset**. Check that SMTP delivers the email.
7. Add **Trucks**, then create their QR codes under **QR codes**. Print the shop QR and each truck QR. Label them clearly. Revoking/regenerating a QR invalidates the old print immediately.
8. Under **Time & report settings**, set the accounting report email recipient. Weeks run Monday–Sunday.
9. Have a test employee scan the shop QR, select SITE and a project, scan a truck QR, select a task, arrive, switch, and clock out. Check Locate and My Hours. Review a completed week in Verify, approve its lines, then create a CSV in Send.

## Install on employees’ phones

**iPhone/iPad:** Open the HTTPS URL in **Safari → Share → Add to Home Screen**. Launch the saved Cedar Winds app and sign in.

**Android:** Open the HTTPS URL in **Chrome → menu → Install app** (or **Add to Home screen**). Launch it and sign in.

The app’s header includes these instructions. Employees normally remain signed in for 30 days unless their account is deactivated or password reset.

A phone camera’s QR result may open Safari/Chrome rather than the installed PWA, and browser/PWA cookie storage can differ by platform. If prompted, sign in once in that browser too. Both use the same live records. The application cannot force iOS to route every camera scan into a standalone PWA.

No internet: punches are queued on the phone with the tap time and the punch’s idempotency key, then sent automatically when the connection returns. Queued punches older than 24 hours are rejected and need a manager correction. If a connection drops during a punch, check the queue indicator: a queued punch will send itself; a confirmed punch will not duplicate thanks to the idempotency key.

## Brand assets

The actual Cedar Winds logo was not included with the build brief. The UI therefore uses a clearly labelled placeholder and the install icons use a generic clock. No substitute company logo is invented.

To add the real logo:

1. Commit it as `public/cedar-winds-logo.png`.
2. Set `NEXT_PUBLIC_LOGO_URL=/cedar-winds-logo.png` **at build time**, then rebuild. The Dockerfile declares this non-secret build argument; Railway supplies it from the service variable.
3. Replace `public/icons/icon-192.png`, `icon-512.png`, `maskable-512.png`, and `apple-touch-icon.png` with approved assets (192×192, 512×512, 512×512 maskable, and 180×180). Keep important artwork inside the maskable safe area.

Theme colours, spacing, and type styles are centralized at the start of `src/app/globals.css`.

## Tests and checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Database/browser tests require a **separate disposable PostgreSQL database whose name ends in `_test`**. They create fixture accounts and records and never run against a normal production database name.

```bash
# Example with the local Docker server:
docker compose exec postgres createdb -U postgres cwtimeclock_test
# Set DATABASE_URL to postgresql://postgres:postgres@localhost:5432/cwtimeclock_test
npm run db:migrate
npm run test:integration
npx playwright install chromium
npm run test:e2e
```

Use your shell’s environment-variable syntax or a temporary test `.env`. Restore your normal database URL afterward. The browser tests start the local development server and require `APP_URL=http://localhost:3000`.

GitHub Actions runs migration, lint, type checking, unit tests, PostgreSQL integration tests, production build, and Chromium browser tests. Browser screenshots/traces are uploaded on failure. `npm run format` applies the checked-in Prettier settings.

Critical coverage includes paid starts, DST weeks, travel state transitions, task changes, duplicate and simultaneous punches, QR revocation, assignment enforcement, overlapping time rejection, forgotten shifts, approval/version checks, immutable exports/audits, password resets, CSV safeguards, and mobile/desktop access.

## Before using for payroll

This is a timekeeping and labour-cost export app. It does not calculate overtime, deductions, wage rates, vacation/statutory pay, or automatic break deductions. Accounting applies those policies to exported labour/travel hours. Confirm the pilot exports and approval process with your controller. Set up HTTPS, email delivery, backups, the real company artwork, and real employee permissions before general rollout.
