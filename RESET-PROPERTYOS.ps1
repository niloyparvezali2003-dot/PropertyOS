[CmdletBinding()]
param(
    [switch]$Execute,
    [string]$ProjectId,
    [string]$OwnerUid
)

$ErrorActionPreference = 'Stop'

# Operational PropertyOS collections to remove.
# Keep settings, transactionReferences, and permanent identifier sequences.
$CollectionsToDelete = @(
    'auditEvents',
    'billBalances',
    'creditApplications',
    'currentAssignmentByMeter',
    'currentMeterByRoom',
    'currentRoomByTenant',
    'currentTenantByRoom',
    'electricityBills',
    'electricityRates',
    'electricityReadings',
    'electricityReadingState',
    'meterAssignments',
    'meters',
    'payments',
    'properties',
    'propertyNameIndex',
    'rentBills',
    'roomNameIndex',
    'roomRentRates',
    'rooms',
    'tenantAssignments',
    'tenantCredits',
    'tenants'
)

function Read-EnvValue {
    param(
        [string]$FilePath,
        [string]$Key
    )

    if (-not (Test-Path -LiteralPath $FilePath)) { return $null }
    $line = Get-Content -LiteralPath $FilePath | Where-Object {
        $_ -match ('^\s*' + [regex]::Escape($Key) + '\s*=')
    } | Select-Object -First 1

    if (-not $line) { return $null }
    $value = ($line -split '=', 2)[1].Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
    }
    return $value
}

$envFile = Join-Path (Get-Location) '.env.local'
if (-not $ProjectId) {
    $ProjectId = Read-EnvValue -FilePath $envFile -Key 'VITE_FIREBASE_PROJECT_ID'
}
if (-not $OwnerUid) {
    $OwnerUid = Read-EnvValue -FilePath $envFile -Key 'VITE_PROPERTYOS_OWNER_UID'
}

if (-not $ProjectId) {
    $ProjectId = Read-Host 'Enter Firebase Project ID (VITE_FIREBASE_PROJECT_ID)'
}
if (-not $OwnerUid) {
    $OwnerUid = Read-Host 'Enter your Firebase Authentication UID (VITE_PROPERTYOS_OWNER_UID)'
}

$ProjectId = $ProjectId.Trim()
$OwnerUid = $OwnerUid.Trim()

if ($ProjectId -notmatch '^[a-z0-9][a-z0-9-]{4,}[a-z0-9]$') {
    throw 'Project ID format does not look valid. Stop and check VITE_FIREBASE_PROJECT_ID.'
}
if ($OwnerUid -notmatch '^[A-Za-z0-9:_-]{1,128}$') {
    throw 'Owner UID contains unexpected characters. Use the Firebase Authentication UID, not the email address.'
}

$firebaseCommand = Get-Command 'firebase' -ErrorAction SilentlyContinue
if (-not $firebaseCommand) {
    throw 'Firebase CLI is not installed or not on PATH. Install it with: npm install -g firebase-tools'
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ' PROPERTYOS — CONTROLLED WORKSPACE DATA RESET' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host "Firebase project : $ProjectId"
Write-Host "Owner UID        : $OwnerUid"
Write-Host "Collections      : $($CollectionsToDelete.Count) operational collections"
Write-Host ''
Write-Host 'WILL DELETE:' -ForegroundColor Red
foreach ($name in $CollectionsToDelete) {
    Write-Host "  users/$OwnerUid/$name" -ForegroundColor Red
}
Write-Host "  users/$OwnerUid/system/restoreMode (only if present)" -ForegroundColor Red
Write-Host ''
Write-Host 'WILL PRESERVE:' -ForegroundColor Green
Write-Host "  users/$OwnerUid/settings/general       (T&N House branding/settings)" -ForegroundColor Green
Write-Host "  users/$OwnerUid/transactionReferences  (prevents reuse of old TRX IDs)" -ForegroundColor Green
Write-Host "  users/$OwnerUid/system/propertySequence" -ForegroundColor Green
Write-Host "  users/$OwnerUid/system/tenantSequence" -ForegroundColor Green
Write-Host "  users/$OwnerUid/system/roomSequence" -ForegroundColor Green
Write-Host "  users/$OwnerUid/system/meterSequence" -ForegroundColor Green
Write-Host '  Firebase Authentication account and Firestore security rules' -ForegroundColor Green
Write-Host '  All other Firebase projects and other users’ data' -ForegroundColor Green
Write-Host ''

if (-not $Execute) {
    Write-Host 'PREVIEW ONLY — NOTHING HAS BEEN DELETED.' -ForegroundColor Yellow
    Write-Host 'To execute after reviewing the list, run:' -ForegroundColor Yellow
    Write-Host '.\RESET-PROPERTYOS.ps1 -Execute' -ForegroundColor White
    Write-Host ''
    exit 0
}

Write-Host 'WARNING: This permanently deletes the listed Firestore records.' -ForegroundColor Red
Write-Host 'The operation is not atomic. If interrupted, rerun this script to finish.' -ForegroundColor Red
$expected = "RESET $ProjectId/$OwnerUid"
$confirmation = Read-Host "Type exactly: $expected"
if ($confirmation -cne $expected) {
    Write-Host 'Confirmation did not match. No deletion was started.' -ForegroundColor Yellow
    exit 1
}

Write-Host ''
Write-Host 'Checking Firebase CLI login...' -ForegroundColor Cyan
& firebase login:list
if ($LASTEXITCODE -ne 0) {
    throw 'Firebase CLI login check failed. Run firebase login and retry.'
}
Write-Host 'Confirm that the listed Google account has administrative access to the project above.' -ForegroundColor Yellow
$accountConfirmation = Read-Host 'Type the Firebase Project ID again to continue'
if ($accountConfirmation -cne $ProjectId) {
    Write-Host 'Project confirmation did not match. No deletion was started.' -ForegroundColor Yellow
    exit 1
}

$completed = 0
foreach ($collectionName in $CollectionsToDelete) {
    $path = "users/$OwnerUid/$collectionName"
    Write-Host "[$($completed + 1)/$($CollectionsToDelete.Count)] Recursively deleting $path" -ForegroundColor Cyan

    & firebase firestore:delete $path --recursive --force --project $ProjectId
    if ($LASTEXITCODE -ne 0) {
        throw "Deletion stopped at '$path'. Some earlier collections may already be empty. Fix the CLI/permission/quota error and rerun this script with -Execute; completed collections can safely be processed again."
    }
    $completed++
}

# Clear any leftover temporary restore-session marker, but do not touch the four ID counters.
$restoreModePath = "users/$OwnerUid/system/restoreMode"
Write-Host "Clearing temporary restore marker: $restoreModePath" -ForegroundColor Cyan
& firebase firestore:delete $restoreModePath --recursive --force --project $ProjectId
if ($LASTEXITCODE -ne 0) {
    throw "Operational collections were deleted, but the temporary restore marker could not be removed. You can rerun this script to retry."
}

Write-Host ''
Write-Host 'RESET COMMANDS COMPLETED.' -ForegroundColor Green
Write-Host 'Refresh PropertyOS and verify Properties, Rooms, Meters, Tenants, Rent & Bills, Electricity, Payments, Ledgers and History are empty.' -ForegroundColor Green
Write-Host 'Settings, Firebase login, security rules, permanent ID counters and TRX registry were preserved.' -ForegroundColor Green
