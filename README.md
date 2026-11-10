# HHG Client Portal

Secure, multi-client HR document portal for JHM Consulting clients, under The Hope Harvest Group.

- **Front end:** static site in `public/` (plain HTML/CSS/JS, no build step) — deploy to Cloudflare like the homepage.
- **Backend:** Supabase — login, Postgres database, file storage. All access rules are enforced server-side with row-level security.

## Access tiers

| Tier | Who | Sees |
|---|---|---|
| **JHM admin** (super admin) | You | Every client workspace. Creates clients, switches modules on/off, replies to requests. |
| **Owner** | The client's owner / administrator | Full workspace: documents, employees, hiring, tasks, org chart. Invites users, company branding. |
| **Staff** | Chosen staff with HR access | Employees, hiring, tasks, all documents. Cannot manage users or settings. |
| **Employee** | Everyone else | Self-service: own profile (emergency contacts & dependents editable), org chart/directory, shared documents, Ask JHM. |

**Modules** (per client, set by JHM on the Clients screen): Documents, Employees, Hiring, Tasks, Requests. Off = gone from that client's workspace.

Nobody can see another company's data — the database and the file bucket both check the company on every request.

## Modules (v1)

- **Documents** — per client, by category (Handbook, Policies, Job descriptions, Benefits, Forms, Hiring process, Other), version label, staff-visible toggle, open/download via short-lived signed links.
- **Employees (HRIS)** — per-client employee records modeled on Employee Navigator: personal, contact/address, employment & pay, emergency contacts, dependents, employee documents, and an onboarding checklist (job description & guidebook acknowledgments, personal info, emergency contact, EEOC self-ID, W-4, I-9, state new-hire report) with auto due dates and a file slot per item. No SSN field by design — it lives only inside the uploaded W-4/I-9.
- **Home** — dashboard: needs-attention tasks, open requests, numbers, activity, quick actions. Employees get a self-service home.
- **Org chart & directory** — drawn from each employee's manager; name, title, department, work email. Visible to all tiers.
- **Tasks** — every onboarding/compliance task across employees; overdue / due this week filters.
- **Onboarding templates & e-signature** — Settings → Onboarding checklist: attach the document behind each task and require a signature. Signing (employee self-service or in person) draws a signature, records consent, and files a stamped PDF (original + certificate page with name, time, signer account).
- **Search (⌘K / Ctrl+K or /)** — employees, jobs, candidates, tasks, documents, requests, and actions.
- **Hiring** — job orders per client; candidates on a drag-and-drop board (Applied → Screening → Interview → Offer → Hired / Passed), resume upload, notes, attachments (full description, interview guide, scorecard), activity log of who did what. Shared between you and the client admin.
- **Requests (Ask JHM)** — in-portal contact form; clients file questions, you reply from a cross-client inbox. No email addresses exposed.
- **People** — members and roles, invite by email, pending invitations.
- **Clients** (JHM admin only) — create/edit client workspaces, logo and accent color.

---

## Setup (one time, ~20 minutes)

### 1. Supabase project
1. supabase.com → **New project**. Name `hhg-portal`, pick a strong database password (save it in your password manager), region **East US**.
2. **SQL Editor → New query** → paste the entire contents of `supabase/schema.sql` → **Run**. It should finish with "Success. No rows returned." Then do the same with `supabase/002_employees.sql` `supabase/003_requests.sql`, `supabase/004_job_files.sql`, `supabase/005_roles.sql`, `supabase/006_signatures.sql` and `supabase/007_activation_privacy.sql`.
3. **Authentication → Providers → Email**: leave *Enable email provider* on and *Confirm email* on. Set minimum password length to 10 (Authentication → Policies / Password).
4. **Authentication → URL Configuration**:
   - Site URL: `https://portal.hopeharvestgroup.com` (or wherever the portal will live; `http://localhost:8080` while testing).
   - Redirect URLs: add the same URL(s).
5. **Project Settings → API**: copy **Project URL** and **anon public** key.

### 1b. Email delivery (required before inviting clients)
Supabase's built-in mailer only delivers to **your own team's addresses** and is capped at a few emails per hour — fine for testing, useless for clients. Set up custom SMTP once:
1. Create a free account at resend.com (3,000 emails/month free) → add and verify the domain `hopeharvestgroup.com` (it gives you DNS records to add in Cloudflare) → create an API key.
2. Supabase → **Project Settings → Authentication → SMTP Settings** → Enable custom SMTP: host `smtp.resend.com`, port `465`, user `resend`, password = the API key, sender `portal@hopeharvestgroup.com`, sender name `HHG Client Portal`.
3. Optional: **Authentication → Email Templates** → edit *Magic Link* to read as an invitation ("You've been invited to the HHG Client Portal…"), and *Confirm signup* / *Reset password* to match.

### 2. Configure the front end
Edit `public/config.js` and paste the two values. (The anon key is meant to be public; the service_role key must never go here.)

### 3. Make yourself the JHM admin
1. Open the portal (locally or deployed), click **Create account**, use `jen@hopeharvestgroup.com`, confirm the email, sign in. You'll see "No access yet" — expected.
2. Supabase **SQL Editor**, run:
   ```sql
   update public.profiles set is_super_admin = true where email = 'jen@hopeharvestgroup.com';
   ```
3. Reload the portal → you're in the **Clients** screen.

### 4. Deploy to Cloudflare
Option A — the way you deploy the homepage: Workers & Pages → create a new Worker (or Pages project) called `hhg-portal`, choose static assets, and upload the **contents of `public/`** (`index.html`, `app.js`, `styles.css`, `config.js`). Add the custom domain `portal.hopeharvestgroup.com` on the Worker's Settings → Domains & Routes tab.

Option B — connect this GitHub repo to Cloudflare Pages: build command *none*, output directory `public`. Every push to `main` redeploys.

If you later move to its own domain (e.g. `hhgportal.com`), nothing changes in the code — just update the Site URL / Redirect URLs in Supabase Auth.

### 5. Test locally (optional)
```
cd public
python3 -m http.server 8080
```
then open http://localhost:8080 (add that URL to Supabase redirect URLs while testing).

---

## Day-to-day

**Onboard a client**
1. Clients → **New client** → name, short ID, logo.
2. Enter workspace → **People → Invite** the owner's email as **Admin**. They receive a sign-in link; on first sign-in they set their name and password.
3. Use **Resend** on a pending invite if the email went astray.
4. Upload their handbook, job descriptions and benefits handouts. Tick *Visible to client staff* on anything employees should see; the client admin can then invite staff as **Staff**.

**Run a search**: Hiring → New job order → attach the interview-process doc → add candidates with resumes. You and the client admin both move candidates and add notes; the activity log shows who did what.

## Security notes
- Row-level security is on for every table; the storage bucket is private and gated by the same rules. The browser only ever gets short-lived signed links to files.
- File limit is 25 MB per upload (change in `schema.sql`, `storage.buckets`).
- Not yet in scope: sensitive employee data (SSNs, pay, medical). When that comes, add field-level encryption and an audit review before storing it.
- To promote/demote a super admin, use the SQL above — it cannot be done from the portal UI on purpose.

## Files
```
public/          static site (deploy this folder)
  index.html
  app.js         all portal logic
  styles.css
  config.js      Supabase URL + anon key
supabase/
  schema.sql     core tables, triggers, RLS policies, storage bucket + policies
  002_employees.sql  Employees/HRIS tables + onboarding checklist (run after schema.sql)
  003_requests.sql   Ask JHM requests table + navy default accent
  004_job_files.sql  attachments on job orders
  005_roles.sql      four roles, modules, employee self-service linking, directory view
  006_signatures.sql onboarding templates (document per task) + e-signatures with stamped PDF
  007_activation_privacy.sql auto-activate after onboarding; employees see only self + direct reports
```
