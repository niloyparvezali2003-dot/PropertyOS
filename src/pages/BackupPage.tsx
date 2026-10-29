import { useRef, useState, type ChangeEvent } from 'react'
import {
    AlertCircle,
    CheckCircle2,
    Download,
    RotateCcw,
    Upload,
    FileJson,
    HardDrive,
    LoaderCircle,
    ShieldCheck,
} from 'lucide-react'

import {
    createManualFirestoreBackup,
    type ManualBackupProgress,
} from '../services/firebase/manualBackup'
import {
    inspectManualFirestoreBackup,
    restoreManualFirestoreBackup,
    type ManualRestorePlan,
    type ManualRestoreProgress,
} from '../services/firebase/manualRestore'

import './backup.css'

type BackupPageProps = {
    ownerUid: string
}

export function BackupPage({ ownerUid }: BackupPageProps) {
    const [isExporting, setIsExporting] = useState(false)
    const [progress, setProgress] =
        useState<ManualBackupProgress | null>(null)
    const [error, setError] = useState('')
    const [success, setSuccess] = useState('')
    const restoreFileInputRef = useRef<HTMLInputElement | null>(null)
    const [restorePlan, setRestorePlan] = useState<ManualRestorePlan | null>(null)
    const [isInspectingRestore, setIsInspectingRestore] = useState(false)
    const [isRestoring, setIsRestoring] = useState(false)
    const [restoreError, setRestoreError] = useState('')
    const [restoreSuccess, setRestoreSuccess] = useState('')
    const [restoreProgress, setRestoreProgress] = useState<ManualRestoreProgress | null>(null)

    async function handleCreateBackup() {
        if (isExporting) return

        const confirmed = window.confirm(
            'Export all readable PropertyOS records from Firebase to a local JSON file?\n\n' +
            'This reads existing documents and consumes Firestore read quota. ' +
            'It does not modify your database or enable paid services.\n\n' +
            'Keep the downloaded file private because it contains tenant and financial information.',
        )

        if (!confirmed) return

        setError('')
        setSuccess('')
        setProgress(null)
        setIsExporting(true)

        try {
            const backup = await createManualFirestoreBackup(
                ownerUid,
                setProgress,
            )

            const blob = new Blob(
                [backup.json],
                { type: 'application/json;charset=utf-8' },
            )

            const url = URL.createObjectURL(blob)
            const link = document.createElement('a')

            link.href = url
            link.download = backup.fileName

            document.body.appendChild(link)
            link.click()
            link.remove()

            window.setTimeout(() => {
                URL.revokeObjectURL(url)
            }, 1500)

            setSuccess(
                `Export created: ${backup.documentCount.toLocaleString('en-BD')} documents ` +
                `from ${Object.keys(backup.collectionCounts).length} collection groups. ` +
                `Saved as ${backup.fileName}`,
            )
        } catch (backupError: unknown) {
            setError(
                backupError instanceof Error
                    ? backupError.message
                    : 'The backup could not be created.',
            )
        } finally {
            setIsExporting(false)
        }
    }

    async function handleRestoreFileSelected(event: ChangeEvent<HTMLInputElement>) {
        const file = event.currentTarget.files?.[0]
        event.currentTarget.value = ''
        if (!file) return

        setRestorePlan(null)
        setRestoreError('')
        setRestoreSuccess('')
        setRestoreProgress(null)
        setIsInspectingRestore(true)
        try {
            const plan = await inspectManualFirestoreBackup(file, ownerUid, setRestoreProgress)
            setRestorePlan(plan)
            if (plan.conflicts.length > 0) {
                setRestoreError('The preview found destination conflicts. No records have been written. Review the conflict list below.')
            }
        } catch (restoreInspectionError: unknown) {
            setRestoreError(
                restoreInspectionError instanceof Error
                    ? restoreInspectionError.message
                    : 'The backup could not be inspected safely.',
            )
        } finally {
            setIsInspectingRestore(false)
            setRestoreProgress(null)
        }
    }

    async function handleRestoreBackup() {
        if (!restorePlan || isRestoring || restorePlan.conflicts.length > 0) return
        const confirmed = window.confirm(
            `Restore ${restorePlan.newDocuments.toLocaleString('en-BD')} missing records into this signed-in account?\n\n` +
            `Backup account: ${restorePlan.sourceUid}\n` +
            `Destination account: ${ownerUid}\n` +
            `Already present and identical: ${restorePlan.alreadyPresentDocuments}\n\n` +
            'Existing records will not be overwritten. The restore may be resumed using the same backup if interrupted. Continue?',
        )
        if (!confirmed) return

        setIsRestoring(true)
        setRestoreError('')
        setRestoreSuccess('')
        setRestoreProgress(null)
        try {
            const result = await restoreManualFirestoreBackup(
                restorePlan,
                ownerUid,
                setRestoreProgress,
            )
            setRestoreSuccess(
                `Restore finished: ${result.restoredDocuments.toLocaleString('en-BD')} records added; ` +
                `${result.alreadyPresentDocuments.toLocaleString('en-BD')} identical records were kept. ` +
                'Permanent document IDs and historical record fields were preserved.',
            )
            try {
                const refreshed = await inspectManualFirestoreBackup(restorePlan.file, ownerUid)
                setRestorePlan(refreshed)
            } catch {
                // Import succeeded; a later preview can be re-run if refresh reads fail.
                setRestorePlan(null)
            }
        } catch (restoreErrorValue: unknown) {
            setRestoreError(
                restoreErrorValue instanceof Error
                    ? restoreErrorValue.message
                    : 'Restore failed. Re-select the same backup to inspect what remains missing before retrying.',
            )
        } finally {
            setIsRestoring(false)
            setRestoreProgress(null)
        }
    }
    return (
        <section className="backup-page">
            <header className="backup-page-heading">
                <div>
                    <p className="backup-eyebrow">
                        SECURITY Â· DATA PROTECTION
                    </p>

                    <h1>Backup & Recovery</h1>

                    <p>
                        Download a local archive of your existing PropertyOS
                        Firestore records while staying on Firebase Spark.
                    </p>
                </div>
            </header>

            <section className="backup-main-card">
                <div className="backup-main-icon">
                    <HardDrive size={26} aria-hidden="true" />
                </div>

                <div className="backup-main-copy">
                    <h2>Manual Firestore backup</h2>

                    <p>
                        Export your owner-accessible properties, rooms, tenants,
                        assignments, meters, rates, bills, payments, credit
                        records, indexes, and audit history into one JSON file.
                    </p>

                    <div className="backup-facts">
                        <span>
                            <ShieldCheck size={15} aria-hidden="true" />
                            Read-only export
                        </span>

                        <span>
                            <FileJson size={15} aria-hidden="true" />
                            JSON archive
                        </span>

                        <span>
                            <CheckCircle2 size={15} aria-hidden="true" />
                            No billing upgrade
                        </span>
                    </div>

                    <button
                        type="button"
                        className="backup-create-button"
                        onClick={() => void handleCreateBackup()}
                        disabled={isExporting}
                    >
                        {isExporting ? (
                            <LoaderCircle
                                size={18}
                                className="backup-spin"
                                aria-hidden="true"
                            />
                        ) : (
                            <Download size={18} aria-hidden="true" />
                        )}

                        {isExporting
                            ? 'Creating backup...'
                            : 'Download JSON backup'
                        }
                    </button>
                </div>
            </section>

            {isExporting && (
                <section className="backup-status-card" role="status">
                    <LoaderCircle
                        size={20}
                        className="backup-spin"
                        aria-hidden="true"
                    />

                    <div>
                        <strong>
                            Reading saved Firestore records
                        </strong>

                        <p>
                            {progress
                                ? `Collection group: ${progress.collectionName} Â· ` +
                                `${progress.current} of ${progress.total}`
                                : 'Preparing the export...'}
                        </p>

                        <small>
                            Keep this tab open until the browser starts the download.
                        </small>
                    </div>
                </section>
            )}

            {success && (
                <section className="backup-message backup-message-success" role="status">
                    <CheckCircle2 size={20} aria-hidden="true" />

                    <div>
                        <strong>Backup download initiated</strong>
                        <p>{success}</p>
                    </div>
                </section>
            )}

            {error && (
                <section className="backup-message backup-message-error" role="alert">
                    <AlertCircle size={20} aria-hidden="true" />

                    <div>
                        <strong>Backup could not be completed</strong>
                        <p>{error}</p>
                        <small>
                            No database records were intentionally modified by this export.
                        </small>
                    </div>
                </section>
            )}

            <section className="backup-restore-card">
                <div className="backup-restore-heading">
                    <div>
                        <p className="backup-eyebrow">RECOVERY</p>
                        <h2>Restore a JSON backup</h2>
                        <p>Preview the archive and destination conflicts before importing anything.</p>
                    </div>
                    <button
                        type="button"
                        className="backup-restore-select-button"
                        onClick={() => restoreFileInputRef.current?.click()}
                        disabled={isInspectingRestore || isRestoring}
                    >
                        {isInspectingRestore ? <LoaderCircle size={17} className="backup-spin" /> : <Upload size={17} />}
                        {isInspectingRestore ? 'Checking backupâ€¦' : 'Choose backup JSON'}
                    </button>
                    <input
                        ref={restoreFileInputRef}
                        type="file"
                        accept=".json,application/json"
                        className="backup-restore-file-input"
                        onChange={(event) => void handleRestoreFileSelected(event)}
                        disabled={isInspectingRestore || isRestoring}
                    />
                </div>

                {isInspectingRestore && (
                    <div className="backup-restore-progress" role="status">
                        <LoaderCircle size={18} className="backup-spin" />
                        <span>
                            {restoreProgress
                                ? `Checking ${restoreProgress.label} (${restoreProgress.current} of ${restoreProgress.total})â€¦`
                                : 'Validating backup and checking destination recordsâ€¦'}
                        </span>
                    </div>
                )}

                {restorePlan && (
                    <div className="backup-restore-preview">
                        <div className="backup-restore-counts">
                            <article><span>Records in backup</span><strong>{restorePlan.totalDocuments.toLocaleString('en-BD')}</strong></article>
                            <article><span>New records to add</span><strong>{restorePlan.newDocuments.toLocaleString('en-BD')}</strong></article>
                            <article><span>Already identical</span><strong>{restorePlan.alreadyPresentDocuments.toLocaleString('en-BD')}</strong></article>
                        </div>
                        <p className="backup-restore-meta">
                            Source account: <code>{restorePlan.sourceUid}</code><br />
                            Destination account: <code>{restorePlan.destinationUid}</code><br />
                            Export date: {new Date(restorePlan.exportedAt).toLocaleString('en-GB')}
                        </p>

                        {restorePlan.conflicts.length > 0 ? (
                            <div className="backup-restore-conflicts" role="alert">
                                <strong>Restore blocked â€” resolve these conflicts first.</strong>
                                <p>No records have been imported. Existing documents will not be overwritten.</p>
                                <ul>
                                    {restorePlan.conflicts.map((conflict) => <li key={conflict}>{conflict}</li>)}
                                </ul>
                                <small>Showing up to 50 conflicts. If there are more, the destination must be reviewed before continuing.</small>
                            </div>
                        ) : (
                            <p className="backup-restore-safe-note">
                                <ShieldCheck size={16} aria-hidden="true" />
                                No differing document IDs or business-code conflicts were found. Only missing records will be added.
                            </p>
                        )}

                        <button
                            type="button"
                            className="backup-restore-run-button"
                            onClick={() => void handleRestoreBackup()}
                            disabled={isRestoring || isInspectingRestore || restorePlan.conflicts.length > 0 || restorePlan.newDocuments === 0}
                        >
                            {isRestoring ? <LoaderCircle size={18} className="backup-spin" /> : <RotateCcw size={18} />}
                            {isRestoring ? 'Restoring recordsâ€¦' : restorePlan.newDocuments === 0 && restorePlan.conflicts.length === 0 ? 'Backup already present' : 'Restore missing records'}
                        </button>
                    </div>
                )}

                {isRestoring && (
                    <div className="backup-restore-progress" role="status">
                        <LoaderCircle size={18} className="backup-spin" />
                        <span>
                            {restoreProgress
                                ? `Restoring ${restoreProgress.label}: ${restoreProgress.current} of ${restoreProgress.total}`
                                : 'Preparing restore sessionâ€¦'}
                        </span>
                    </div>
                )}

                {restoreSuccess && <p className="backup-restore-success" role="status">{restoreSuccess}</p>}
                {restoreError && <p className="backup-restore-error" role="alert">{restoreError}</p>}
                <p className="backup-restore-footnote">
                    The archive must belong to this Firebase project. Restore does not copy login credentials. Keep the source file private because it contains tenant and financial information.
                </p>
            </section>
            <section className="backup-details-grid">
                <article className="backup-detail-card">
                    <span className="backup-detail-number">01</span>
                    <h3>Where is the backup saved?</h3>
                    <p>
                        Your browser downloads the JSON file to its configured
                        download location on your computer.
                    </p>
                </article>

                <article className="backup-detail-card">
                    <span className="backup-detail-number">02</span>
                    <h3>What is included?</h3>
                    <p>
                        Saved documents and their IDs from the listed owner-scoped
                        collections, including financial records and history.
                    </p>
                </article>

                <article className="backup-detail-card">
                    <span className="backup-detail-number">03</span>
                    <h3>What is not included?</h3>
                    <p>
                        Firebase Authentication credentials, Firebase project
                        configuration, files stored outside Firestore, and
                        unsupported or inaccessible records.
                    </p>
                </article>
            </section>

            <aside className="backup-warning">
                <AlertCircle size={18} aria-hidden="true" />

                <p>
                    <strong>Important:</strong> backups may contain personal and financial information. Store them securely. Restore only into the same Firebase project after publishing the updated owner-scoped Firestore rules. The importer preserves document IDs, does not overwrite different existing records, and may need to be run again after an interrupted import.
                </p>
            </aside>
        </section>
    )
}
