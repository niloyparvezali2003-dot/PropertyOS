# PropertyOS — Property Management System

PropertyOS is a web-based property management and accounting workspace for managing properties, rooms, tenants, occupancy, rent, electricity, payments, advances, tenant ledgers, reports, audit history, and data backups.

The current workspace branding is **T&N House's**. PropertyOS is designed for desktop and mobile browsers and uses Firebase Authentication and Cloud Firestore for shared, persistent data.

---

## Contents

1. [Project at a glance](#project-at-a-glance)
2. [Main features](#main-features)
3. [Financial and billing rules](#financial-and-billing-rules)
4. [Technology stack](#technology-stack)
5. [Project structure](#project-structure)
6. [Requirements](#requirements)
7. [Run locally](#run-locally)
8. [Environment variables](#environment-variables)
9. [Firebase setup](#firebase-setup)
10. [Deploy to Vercel](#deploy-to-vercel)
11. [Firestore data organization](#firestore-data-organization)
12. [Backup and recovery](#backup-and-recovery)
13. [PDF and report exports](#pdf-and-report-exports)
14. [Useful development commands](#useful-development-commands)
15. [Important implementation notes](#important-implementation-notes)

---

## Project at a glance

- **Application:** PropertyOS
- **Purpose:** Property, tenant, occupancy, rent, electricity, payment, and financial record management.
- **Frontend:** React + TypeScript + Vite.
- **Backend services:** Firebase Authentication and Cloud Firestore.
- **PDF generation:** jsPDF and jsPDF AutoTable.
- **Validation:** Zod schemas for important forms and financial inputs.
- **Icons:** Lucide React.
- **Currency:** Bangladeshi Taka (BDT / ৳).
- **Money precision:** Monetary values are stored as integer poisha where applicable. `100 poisha = ৳1.00`.
- **Runtime:** Node.js 24.x, as declared in `package.json`.
- **Hosting:** Vercel-compatible Vite production build.
- **Data ownership:** Business records remain under the configured workspace owner's Firebase UID. Authorized workspace members use the same shared records.

### Design language

- Warm ivory page background with white working surfaces.
- Navy headings and primary actions.
- Gold accent details.
- Semantic colors for financial states: red for due, green for advance/paid states where applicable, and amber for partial or warning states.
- English and Bangla tenant names are supported in the interface and in the PDF rendering paths that provide Bangla-font/canvas support.

---

## Main features

### 1. Dashboard

- Shows a high-level summary of the property workspace.
- Provides quick navigation to commonly used modules.
- Shows recent activity and key workspace counts.
- Provides search and navigation into the main management pages.

### 2. Properties

- Create and update property records.
- Store property name, location/address, and notes.
- Maintain active/inactive property status.
- Use generated property identifiers/codes as stable references in related records.

### 3. Rooms & Floors

- Create and update rooms under a property.
- Store room number, floor/level, room code, and occupancy status.
- View the tenant currently assigned to a room.
- Search and filter rooms, including property-wise filtering.
- Keep room records separate from tenant records so room occupancy history can be retained.

### 4. Tenants

- Create and update tenant profiles.
- Store tenant identity/contact details and active/inactive status.
- Assign an active tenant to a vacant room.
- Record move-in and move-out dates and notes.
- Keep ended assignments as historical records rather than deleting the occupancy history.
- Support one tenant occupying multiple rooms at the same time. Each room has its own assignment record.
- Show the assignment form separately from the three review sections:
  - **Assignment History:** shows the five most recent ended assignments first, with an option to show more history.
  - **Current Assignments:** lists current room assignments and provides a property-wise filter.
  - **Tenants List:** shows tenant profiles and the existing search, status-filter, and edit tools.
- Tenant-name lists support mixed English and Bangla names with locale-aware/numeric ordering.

### 5. Meters

- Register electricity meters.
- Assign a meter to a room and preserve meter-assignment history.
- Record meter replacement and correction events where supported by the meter workflow.
- Keep meter identity and historical readings separate from the current room assignment.

### 6. Rent & Bills

- Set room rent rates with an effective-from date.
- Keep rent rate history so the rate effective on a billing date can be used for calculations.
- Show the latest effective rate in the room-level rate overview while retaining historical rate records.
- Select rooms associated with active tenants when setting a rent rate.
- Generate monthly rent bills for a selected billing month.
- Preserve rate snapshots and charge-period details on issued rent bills.
- Prevent duplicate room/month bill generation through room/month safeguards.
- Protect rates referenced by issued bills from unsafe deletion.
- Switch between **Rent Rate History** and **Issued Rent Bills** to reduce page scrolling.
- Present rate history as a desktop table while retaining a mobile-friendly layout.
- Download a Rent Rate PDF with the columns **Tenant, Room, Rent Rate, Date**.
- The Rent Rate PDF groups properties in this order when the saved property name matches the group label:
  1. 5-Storey Apartment
  2. Half-Building
  3. TIN-Shed
  4. Market
  5. Other saved property names afterward.
- Room rows inside each property group are sorted naturally by room number/code.

### 7. Current Month Collection

- Select a billing month and review rent and electricity collection together.
- Show one row per tenant, even when the tenant occupies multiple rooms.
- Combine the tenant's room labels into the **Room(s)** column.
- The web table contains:
  - Tenant
  - Room(s)
  - Rent Bill
  - Ebill
  - Paid Against Bill
  - Remaining
  - Status
- Rent and electricity amounts are summed tenant-wise for the selected month.
- Paid Against Bill is the sum allocated to the selected month's issued rent and electricity bills.
- Remaining is the selected month's rent/electricity bill balance, not the tenant's entire historical balance.
- Monthly status is based on the selected month's issued bills and allocations. Previous dues do not turn a paid current-month bill into an unpaid one.
- Statuses include Paid, Partially paid, Unpaid, and Not billed.
- All active tenants are included, even if no bill has been issued for the selected month.
- Inactive tenants are included only when their current tenant-ledger balance is non-zero (due or advance). Inactive tenants with a zero balance are excluded.
- Search and status filters work on the tenant-wise rows.
- Download a monthly PDF containing rent and electricity collection information and the tenant's full ledger balance.
- In the PDF, a positive tenant balance is displayed as due in red; a negative balance is displayed as advance in green. The PDF amount is shown without an extra `DUE:` or `ADVANCE:` label.

### 8. Electricity

- Configure the workspace default electricity rate and room-specific rates where required.
- Record dated meter readings.
- Calculate usage from reading differences and create electricity bills from readings.
- Preserve meter assignment and tenant snapshots so historical bills can be related to the correct occupancy period.
- Review issued electricity bills and filter by month/search.
- Download a monthly electricity bill report for a selected month.
- Electricity bill report exports include issued bill amounts for the selected month; they do not silently combine previous tenant dues or payment totals into the bill amount.

### 9. Payments

- Record a tenant payment with date, method, optional reference, and notes.
- Record supported payment methods such as cash, bank transfer, mobile banking, cheque, and other.
- Allocate a receipt to one or more issued rent/electricity bills.
- Allocate payment to an outstanding tenant opening balance when selected.
- Validate allocations against each bill's remaining amount.
- Keep any received amount that is not allocated as available tenant advance credit.
- Apply advance credit to an outstanding rent bill, electricity bill, or opening balance through a separate credit-application action.
- Show outstanding bill balances, available advances, recent payments, and advance applications.
- Print receipts and preserve transaction/reference details.
- The tenant selector for recording a payment is limited to active tenants.

### 10. Ledgers

- View statements by **Tenant**, **Room**, or **Meter**.
- Tenant ledger combines rent and electricity activity across the tenant's room occupancy history.
- Room ledger focuses on rent charges and rent payments for the selected room; rent-rate change rows are informational and do not themselves change the balance.
- Meter ledger focuses on electricity readings, electricity bills, and related payments.
- Review dated transactions, debit, credit, reference, and running balance information.
- Download PDF statements, including the related history sections available for the selected ledger scope.
- Tenant selection is limited to active tenants; historical room and meter records remain available in their respective scopes.

### 11. Financial Reports

- Review monthly financial summaries.
- Separate rent billed and electricity billed totals.
- Show recorded payments received and advance-credit applications in the report period.
- Review monthly report data and export the monthly summary as CSV.
- Reporting reads existing financial records and does not create or modify bill/payment data.

### 12. Opening Balance

- Record a tenant's opening outstanding balance when bringing historical dues into PropertyOS.
- Keep the original opening balance distinct from later adjustments.
- Require a reason/effective date for opening-balance corrections.
- Preserve opening-balance adjustment history for audit review.
- Tenant lists are ordered for mixed English and Bangla names.

### 13. History & Audit Trail

- Show an append-only timeline of supported workspace actions.
- Supported audit record categories include properties, rooms, tenants, tenant assignments, meters, meter assignments, rent rates, rent bills, electricity rates, electricity bills, payments, advance-credit applications, opening balances, members, and invitations.
- Supported actions include creation, updates, assignments, move-outs, meter replacements, rate changes, bill generation/issuance, payment recording, credit applications, opening-balance actions, and workspace invitation/member actions.
- Search the loaded activity records.
- Filter by record type and From/To date.
- Download a PDF using the selected record type, date range, and current search filter.
- The current activity loader retrieves the latest 500 audit events. The page/PDF therefore covers the loaded event set, not an unlimited historical archive.
- Audit records are append-only under Firestore rules: the client can read/create allowed records but cannot update or delete them.
- Audit logging begins when the audit-enabled version is deployed. Older actions are not backfilled automatically.
- Audit writes are best-effort after a business action commits. A failed audit write does not roll back an already-saved payment or bill.

### 14. Notes

- Create and rename workspace notes.
- Add numbered checklist tasks to a note.
- Edit, reorder, complete, restore, and delete tasks.
- Completed checklist tasks receive a 30-day retention period and are cleaned up after expiry.

### 15. Backup & Recovery

- Export owner-workspace Firestore data to a local JSON archive.
- Show export progress and collection/document counts.
- Inspect a selected backup before restoring it.
- Preview destination conflicts before any restore writes are made.
- Restore missing documents without overwriting existing records.
- Preserve Firestore document IDs and historical record fields.
- A restore can be resumed using the same backup if interrupted.
- Backup/restore is a manual browser-driven workflow; keep downloaded backup files in a safe location outside the repository.

### 16. Users & Access

- Invite another person to the existing shared workspace by email.
- Invitation links expire after seven days.
- The invited person must sign in with the invited email and verify the email address before accepting.
- Active workspace members receive the `full_access` role in this implementation.
- Review active members and pending invitations.
- Cancel pending invitations or revoke a member's access.
- All members work with the same owner workspace data namespace; a member's own Firebase UID does not replace the configured workspace owner UID.

### 17. Settings

- Configure the workspace/house name.
- Maintain address, contract/contact details, support email, and statement footer.
- Configure the default electricity rate used when a room does not have a more specific rate.
- Configure statement details used by supported PDF statements.

---

## Financial and billing rules

These rules are important for keeping reports and balances consistent.

### Rent billing

- Rent rates are effective-dated records.
- A monthly rent bill uses the effective rate/rate snapshot for its charge period.
- Issued bills preserve their historical amount and rate breakdown.
- Room/month safeguards prevent duplicate rent bills for the same room and billing month.
- Current room assignments are separate records, even when one tenant occupies multiple rooms.

### Current billing vs. previous due

- Current Month Collection evaluates the selected month's rent/electricity invoices separately from historical balances.
- Payments count toward a monthly bill only through the payment allocation linked to that bill.
- A tenant can have an old unpaid balance but still be Paid for the selected month.
- The tenant's full ledger balance is a separate figure from the selected month's Remaining amount.

### Payments and advance credit

- A posted payment is counted once as received.
- Allocated amounts reduce the specific bill/opening-balance balance they were applied to.
- Any unallocated portion becomes available advance credit.
- Applying advance credit later creates a credit application against a target bill/opening balance; it must not be counted as a second cash receipt.
- Available advance credit is shown separately from money due. It is not silently deducted from a due balance in reports unless an application has actually been recorded.

### Opening balance

- The original opening balance is retained as a separate starting record.
- Later corrections are stored as adjustments rather than rewriting the original starting amount.
- Payments/advance applications to the opening balance are tracked separately from rent/electricity bill allocations.

### Currency precision

- Money is represented in integer minor units (poisha) in the validated business data model.
- `100` poisha equals `৳1.00`.
- Do not store calculated currency as floating-point taka values in new financial code; convert/validate at the form boundary and store integer poisha.

---

## Technology stack

### Runtime and build

- Node.js 24.x
- npm
- Vite 8
- TypeScript 7
- React 19

### Application libraries

- Firebase JavaScript SDK 13 — Authentication and Firestore.
- Zod 4 — form/data validation.
- jsPDF 4 — PDF generation.
- jsPDF AutoTable 5 — PDF tables.
- Lucide React — interface icons.
- Tailwind CSS 4 Vite integration and project CSS for styling.
- Oxlint — linting.

Package versions and scripts are defined in `package.json` and `package-lock.json`.

---

## Project structure

```text
PropertyOS/
├── public/                         # App icons and public assets
├── src/
│   ├── assets/                     # Source images/assets
│   ├── components/
│   │   ├── auth/                   # Login and authentication UI
│   │   ├── layout/                 # Sidebar, loading screen, app shell UI
│   │   ├── tenants/                # Tenant assignment sections and styles
│   │   └── ui/                     # Shared input/search/stat components
│   ├── pages/                     # Application pages
│   ├── schemas/                   # Zod schemas and form types
│   ├── services/firebase/         # Firestore/Auth operations and business logic
│   ├── types/                     # Navigation and shared types
│   ├── utils/                     # Sorting and report/PDF helpers
│   ├── App.tsx                    # Authentication, workspace gate, page routing
│   ├── App.css                    # App shell styles
│   ├── index.css                  # Global theme and base styles
│   └── main.tsx                   # React entry point
├── utils/                         # Root-level utility files
├── firestore.rules                # Cloud Firestore security rules
├── RESET-PROPERTYOS.ps1           # Windows reset/maintenance helper
├── index.html
├── package.json
├── package-lock.json
├── tsconfig.json
├── tsconfig.app.json
├── tsconfig.node.json
└── vite.config.ts
```

### Main page files

- `DashboardPage.tsx`
- `PropertiesPage.tsx`
- `RoomsPage.tsx`
- `TenantsPage.tsx`
- `MetersPage.tsx`
- `RentBillsPage.tsx`
- `CurrentMonthCollectionPage.tsx`
- `ElectricityPage.tsx`
- `PaymentsPage.tsx`
- `LedgersPage.tsx`
- `FinancialReportsPage.tsx`
- `OpeningBalancePage.tsx`
- `HistoryPage.tsx`
- `NotePage.tsx`
- `BackupPage.tsx`
- `UsersAccessPage.tsx`
- `SettingsPage.tsx`

### Main Firebase service files

- `auth.ts` — Firebase Authentication helpers.
- `client.ts` — Firebase app/Auth/Firestore initialization and environment validation.
- `workspace.ts` — workspace membership and invitation lifecycle.
- `properties.ts`, `rooms.ts`, `tenants.ts`, `tenantAssignments.ts` — property and occupancy data.
- `meters.ts` — meter and meter-assignment data.
- `rentBills.ts` — rent rates and monthly rent bill generation.
- `electricity.ts` — electricity rates, readings, and bills.
- `payments.ts` — receipts, bill allocations, tenant credit, and advance applications.
- `openingBalances.ts` — opening balances and adjustments.
- `ledgers.ts` — source data for tenant/room/meter ledgers.
- `financialReports.ts` — read-only financial report data loading.
- `audit.ts` — append-only audit events.
- `manualBackup.ts`, `manualRestore.ts` — JSON backup and restore.
- `notes.ts` — workspace notes and checklist tasks.
- `workspaceSettings.ts` — house/workspace and default electricity settings.
- `listCache.ts` — owner-scoped list cache and invalidation.

---

## Requirements

Install the following before running the application:

1. Node.js **24.x**.
2. npm (included with Node.js).
3. Access to the Firebase project used by this workspace.
4. The workspace owner's Firebase Authentication UID.
5. A configured `.env.local` file in the project root.

The `engines` field in `package.json` specifies Node `24.x`. Vercel uses this package requirement even if the Project Settings page specifies a different Node version.

---

## Run locally

### 1. Extract the project

Open a terminal in the folder containing `package.json`.

### 2. Install dependencies

```bash
npm ci
```

On Windows PowerShell, use this command if PowerShell blocks the `npm` script:

```powershell
npm.cmd ci
```

### 3. Create `.env.local`

Create the file in the same directory as `package.json` and add the Firebase/workspace values:

```dotenv
VITE_FIREBASE_API_KEY=your_firebase_web_api_key
VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your_firebase_project_id
VITE_FIREBASE_STORAGE_BUCKET=your_project.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=your_messaging_sender_id
VITE_FIREBASE_APP_ID=your_firebase_app_id
VITE_PROPERTYOS_OWNER_UID=your_workspace_owner_firebase_auth_uid
```

Replace every example value with the corresponding value from the Firebase project. Do not commit `.env.local` to Git.

### 4. Start the development server

```bash
npm run dev
```

On Windows PowerShell:

```powershell
npm.cmd run dev
```

Vite prints the local URL in the terminal. The default is usually:

```text
http://localhost:5173
```

### 5. Build and preview locally

```bash
npm run build
npm run preview
```

PowerShell equivalents:

```powershell
npm.cmd run build
npm.cmd run preview
```

---

## Environment variables

| Variable | Purpose |
|---|---|
| `VITE_FIREBASE_API_KEY` | Firebase web app API key |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase Authentication domain |
| `VITE_FIREBASE_PROJECT_ID` | Firebase project ID used by Firestore |
| `VITE_FIREBASE_STORAGE_BUCKET` | Firebase project storage bucket configuration |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Firebase messaging sender ID configuration |
| `VITE_FIREBASE_APP_ID` | Firebase web app ID |
| `VITE_PROPERTYOS_OWNER_UID` | Firebase Auth UID that owns the shared PropertyOS workspace data namespace |

### Important owner UID rule

- `VITE_PROPERTYOS_OWNER_UID` must be the Firebase Auth UID of the original workspace owner.
- Do not replace it with another member's UID when an invited member signs in.
- All authorized members access the same workspace records under the owner's UID.
- If this value is blank or still contains the placeholder `PASTE_YOUR_FIREBASE_USER_UID_HERE`, the app cannot complete workspace access checks.

---

## Firebase setup

### 1. Firebase Authentication

1. Open the Firebase project.
2. Enable the Email/Password sign-in provider in Authentication.
3. Add the local development domain and the deployed Vercel domain to the authorized domains list.
4. Create/sign in with the workspace owner account.
5. Copy the owner's Firebase Authentication UID into `VITE_PROPERTYOS_OWNER_UID` locally and into the matching Vercel environment variable.
6. Invited workspace members must use the invited email address and verify that email before accepting an invitation.

### 2. Cloud Firestore

1. Create/enable the Cloud Firestore database for the Firebase project.
2. Open the Firestore Rules editor.
3. Publish the rules from the repository's `firestore.rules` file.
4. Do not replace the rules with open test rules in production.
5. Confirm that the signed-in owner can access the workspace before inviting other members.

### 3. Shared workspace access

- The owner workspace is stored under `/users/{ownerUid}/...`.
- The owner has access to their workspace.
- An invited user receives a `workspaceMembers` record with the `full_access` role after accepting a valid invitation.
- Invitation records are stored under the workspace owner's namespace.
- Invitations expire after seven days.
- Revoked members no longer pass the active workspace membership check.
- Firestore rules enforce workspace membership; hiding a page or filtering a dropdown is not a substitute for Firestore security rules.

### 4. Audit rules

- `auditEvents` is readable by authorized workspace members.
- Allowed audit events can be created by authorized members.
- Audit events cannot be updated or deleted through the client rules.
- Publish the current `firestore.rules` file when deploying a version that requires a Firestore rules change.

---

## Deploy to Vercel

1. Push the project to the connected GitHub repository.
2. Import/connect the repository in Vercel.
3. Use the Vite framework preset.
4. Build command:

   ```bash
   npm run build
   ```

5. Output directory:

   ```text
   dist
   ```

6. Add all required `VITE_FIREBASE_*` variables and `VITE_PROPERTYOS_OWNER_UID` in Vercel Project Settings → Environment Variables.
7. Use **Node.js 24.x** for the deployment environment. The repository's `package.json` declares `"engines": { "node": "24.x" }`.
8. Redeploy after changing environment variables.
9. Add the deployed domain to Firebase Authentication authorized domains.
10. Test sign-in, workspace membership, a read-only page, and a safe test operation after deployment.

### Vercel build command

The configured build script runs:

```bash
tsc -b && vite build
```

A deployment fails if TypeScript reports an error, even if the Vite bundler itself has not started. Fix the first TypeScript error in the build log and deploy again.

---

## Firestore data organization

Business data is stored under the workspace owner's UID. The main collections include:

### Property and occupancy records

- `properties`
- `rooms`
- `tenants`
- `tenantAssignments`
- `propertyNameIndex`
- `roomNameIndex`
- Current-assignment lookup records such as `currentRoomByTenant` and `currentTenantByRoom`

### Meter and electricity records

- `meters`
- `meterAssignments`
- `currentMeterByRoom`
- `currentAssignmentByMeter`
- `electricityRates`
- `electricityReadings`
- `electricityReadingState`
- `electricityBills`

### Rent records

- `roomRentRates`
- `rentBills`
- `rentBillRoomMonthLocks`
- `roomRentRateUsageLocks`

### Payments, due, and advance-credit records

- `payments`
- `billBalances`
- `tenantCredits`
- `creditApplications`
- `openingBalances`
- `openingBalanceAdjustments`
- `openingBalanceCreditApplications`
- `transactionReferences`

### Management records

- `auditEvents`
- `notes`
- `noteTasks`
- `settings`
- `workspaceMembers`
- `workspaceInvitations`
- Temporary restore-session data under `system`

Some collections are operational indexes, snapshots, idempotency records, or safeguards used by the application. Do not manually rename, delete, or edit these records in Firestore unless following a verified migration procedure.

---

## Backup and recovery

### Create a backup

1. Open **Backup & Recovery** in PropertyOS.
2. Choose **Download JSON backup**.
3. Wait for the export to complete.
4. Save the generated `.json` file somewhere safe outside the source repository.
5. Keep more than one backup copy when the data is business-critical.

The backup includes the workspace's supported property, room, tenant, assignment, meter, rate, bill, payment, advance, opening-balance, note, and audit records, along with required identifiers/indexes included in the backup service.

### Restore a backup

1. Open **Backup & Recovery**.
2. Select the JSON backup file.
3. Review the restore inspection and conflict list.
4. Continue only when the preview has no unresolved conflicts.
5. Confirm the restore.
6. Monitor progress until the restore reports completion.

Restore behavior:

- Existing records are not overwritten.
- Identical records already present are skipped.
- Missing records are added using their original document IDs.
- Conflicts stop the restore before writes are made.
- An interrupted restore can be inspected/resumed with the same backup file.

**Always create a fresh backup before a restore.** A restore is not a substitute for carefully reviewing a source backup and destination workspace.

---

## PDF and report exports

The application uses jsPDF and AutoTable for PDF reports and supports Bangla text rendering in pages that provide the PDF Bengali-font/canvas rendering helper.

Current exports include:

- **Rent Rate Report:** Tenant, Room, Rent Rate, Date; grouped by the configured property-name categories.
- **Current Month Collection:** tenant-wise rent and electricity collection report, with room grouping, current-month collected/remaining amounts, and tenant ledger balance.
- **Electricity Monthly Report:** issued electricity bill records for one selected billing month.
- **Tenant / Room / Meter Ledger Statements:** financial statement and related history sections for the selected ledger scope.
- **History & Audit Trail:** activity export using the selected record type, date range, and search filter.
- **Payment receipt:** printable receipt for a recorded payment.
- **Financial Reports:** monthly summary CSV export.

### Bangla and currency rendering

- Use the built-in PDF rendering path for Bangla names/details on pages that support it.
- The rent-rate PDF formats currency in BDT text to avoid missing Taka glyphs in unsupported standard PDF fonts.
- Check exported PDFs after changing PDF font or layout code; a successful TypeScript build does not guarantee every glyph renders correctly in every browser.

---

## Useful development commands

| Command | Description |
|---|---|
| `npm ci` | Install the exact dependency tree from `package-lock.json` |
| `npm run dev` | Start the Vite development server |
| `npm run build` | Run TypeScript project checks and create the production build |
| `npm run lint` | Run Oxlint |
| `npm run preview` | Preview the production build locally |

Windows PowerShell users can run the same commands with `npm.cmd`, for example `npm.cmd run build`.

---

## Important implementation notes

1. **Preserve historical data.** Do not delete or regenerate tenant, property, room, meter, bill, payment, opening-balance, credit, or audit records to make a UI change.
2. **Do not change permanent identifiers.** Existing document IDs, property/room/tenant/meter codes, transaction references, and bill references are used by historical links and ledger calculations.
3. **Keep assignment history.** A move-out ends an assignment; it does not erase the historical occupancy record.
4. **One room has one current tenant assignment.** One tenant can have multiple current room assignments.
5. **Rent billing is still assignment/room-based.** The current assignment form notes that each room keeps its own rent and meter history and its own rent/meter billing. The Current Month Collection page groups those bill amounts by tenant for display; that grouping does not create a single combined rent invoice across several rooms.
6. **Payment allocation is bill-specific.** Record payments and credit applications against the intended bill/opening balance. Do not infer that a payment paid a particular month merely from the payment date.
7. **Advance is not the same as payment against a bill.** Unallocated money remains advance credit until a separate credit application is posted.
8. **Previous due is separate from current-month status.** Current Month Collection's paid/partial/unpaid/not-billed status is based on the selected month's issued rent/electricity invoices and their allocations.
9. **Tenant-wide balance and monthly remaining are different figures.** Tenant-wide balance reflects the ledger across earlier and current charges/receipts; monthly Remaining reflects only the selected month's rent/electricity bills.
10. **Use the active tenant selector rules.** The Rent & Bills rate selector, Payments selector, and Tenant ledger selector are intended for active tenants. Historical ledger and assignment data remains available through the relevant history scopes.
11. **Audit events are append-only.** Do not edit or remove audit records to hide an event. Audit history starts from the deployment that introduced audit logging and does not backfill earlier activity.
12. **No secrets in source control.** Keep `.env.local`, private credentials, service-account keys, and downloaded backup files out of Git.
13. **Test after changing financial code.** Validate rent generation, bill allocations, partial payments, opening-balance allocation, advance creation/application, tenant ledger totals, and PDF totals before deploying.
14. **Run a production build before pushing.** Use `npm ci` followed by `npm run build` with Node.js 24.x.

---

## License and project status

This repository is the PropertyOS application source for its property-management workspace. No open-source license is declared in this README; consult the repository owner before reusing or redistributing the application.
