import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  Clock3,
  FileText,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react'

import {
  cleanupExpiredNoteTasks,
  createNote,
  createNoteTask,
  deleteNote,
  deleteNoteTask,
  listNotes,
  listNoteTasks,
  reorderNoteTasks,
  renameNote,
  setNoteTaskCompleted,
  updateNoteTaskText,
  type NoteRecord,
  type NoteTaskRecord,
} from '../services/firebase/notes'
import './note.css'

type NotePageProps = { ownerUid: string }

const DAY_MS = 24 * 60 * 60 * 1000

function remainingDays(task: NoteTaskRecord, now: number): number | null {
  if (!task.expiresAt) return null
  return Math.max(0, Math.ceil((task.expiresAt.toMillis() - now) / DAY_MS))
}

function relativeCompleted(task: NoteTaskRecord): string {
  if (!task.completedAt) return ''
  return new Intl.DateTimeFormat('en-BD', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
    timeZone: 'Asia/Dhaka',
  }).format(task.completedAt.toDate())
}

export function NotePage({ ownerUid }: NotePageProps) {
  const [notes, setNotes] = useState<NoteRecord[]>([])
  const [tasks, setTasks] = useState<NoteTaskRecord[]>([])
  const [activeNoteId, setActiveNoteId] = useState('')
  const [noteTitleDraft, setNoteTitleDraft] = useState('')
  const [newTaskText, setNewTaskText] = useState('')
  const [editingTaskId, setEditingTaskId] = useState('')
  const [editingTaskText, setEditingTaskText] = useState('')
  const [clockNow, setClockNow] = useState(Date.now())
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const loadData = useCallback(async (cleanExpired = false) => {
    setError('')
    try {
      if (cleanExpired) await cleanupExpiredNoteTasks(ownerUid)
      const [nextNotes, nextTasks] = await Promise.all([
        listNotes(ownerUid),
        listNoteTasks(ownerUid),
      ])
      setNotes(nextNotes)
      setTasks(nextTasks)
      setActiveNoteId((current) => nextNotes.some((note) => note.id === current) ? current : nextNotes[0]?.id ?? '')
      setClockNow(Date.now())
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : 'Notes could not be loaded.')
    } finally {
      setIsLoading(false)
    }
  }, [ownerUid])

  useEffect(() => {
    void loadData(true)
    const timer = window.setInterval(() => {
      setClockNow(Date.now())
      void cleanupExpiredNoteTasks(ownerUid).then((deleted) => {
        if (deleted > 0) void loadData(false)
      }).catch(() => undefined)
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [loadData, ownerUid])

  const activeNote = notes.find((note) => note.id === activeNoteId) ?? null
  const activeTasks = useMemo(() => tasks
    .filter((task) => task.noteId === activeNoteId)
    .sort((left, right) => left.order - right.order || (left.createdAt?.toMillis() ?? 0) - (right.createdAt?.toMillis() ?? 0)), [tasks, activeNoteId])
  const completedCount = activeTasks.filter((task) => task.completedAt).length
  const pendingCount = activeTasks.length - completedCount

  useEffect(() => {
    setNoteTitleDraft(activeNote?.title ?? '')
  }, [activeNote?.id, activeNote?.title])

  async function handleCreateNote() {
    setIsSaving(true)
    setError('')
    setSuccess('')
    try {
      const noteId = await createNote(ownerUid)
      await loadData(false)
      setActiveNoteId(noteId)
      setSuccess('A new note is ready.')
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : 'The note could not be created.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleRenameNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!activeNote || noteTitleDraft.trim() === activeNote.title || isSaving) return
    setIsSaving(true)
    setError('')
    setSuccess('')
    try {
      await renameNote(ownerUid, activeNote.id, noteTitleDraft)
      await loadData(false)
      setSuccess('Note title updated.')
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : 'The note title could not be updated.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleAddTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!activeNote || !newTaskText.trim() || isSaving) return
    setIsSaving(true)
    setError('')
    setSuccess('')
    try {
      await createNoteTask(ownerUid, activeNote.id, newTaskText)
      setNewTaskText('')
      await loadData(false)
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : 'The checklist item could not be added.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleToggleTask(task: NoteTaskRecord) {
    if (isSaving) return
    setIsSaving(true)
    setError('')
    try {
      await setNoteTaskCompleted(ownerUid, task.noteId, task.id, !task.completedAt)
      await loadData(false)
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : 'The checklist item could not be updated.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleSaveTaskText(task: NoteTaskRecord) {
    if (!editingTaskText.trim() || isSaving) return
    setIsSaving(true)
    setError('')
    try {
      await updateNoteTaskText(ownerUid, task.noteId, task.id, editingTaskText)
      setEditingTaskId('')
      setEditingTaskText('')
      await loadData(false)
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : 'The checklist item could not be edited.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDeleteTask(task: NoteTaskRecord) {
    if (isSaving || !window.confirm('Delete this checklist item permanently?')) return
    setIsSaving(true)
    setError('')
    try {
      await deleteNoteTask(ownerUid, task.noteId, task.id)
      await loadData(false)
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : 'The checklist item could not be deleted.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleMoveTask(task: NoteTaskRecord, direction: -1 | 1) {
    const index = activeTasks.findIndex((item) => item.id === task.id)
    const nextIndex = index + direction
    if (index < 0 || nextIndex < 0 || nextIndex >= activeTasks.length || isSaving || !activeNote) return
    const reordered = [...activeTasks]
    ;[reordered[index], reordered[nextIndex]] = [reordered[nextIndex], reordered[index]]
    setIsSaving(true)
    setError('')
    try {
      await reorderNoteTasks(ownerUid, activeNote.id, reordered.map((item) => item.id))
      await loadData(false)
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : 'The checklist order could not be saved.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDeleteNote() {
    if (!activeNote || isSaving || !window.confirm(`Delete “${activeNote.title}” and all its checklist items? This cannot be undone.`)) return
    setIsSaving(true)
    setError('')
    setSuccess('')
    try {
      await deleteNote(ownerUid, activeNote.id)
      setEditingTaskId('')
      await loadData(false)
      setSuccess('Note deleted.')
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : 'The note could not be deleted.')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <section className="note-page">
      <header className="note-page-heading">
        <div>
          <p className="eyebrow">Management</p>
          <h1>Note</h1>
          <p className="page-description">Keep house tasks, reminders, and checklists together in one private workspace.</p>
        </div>
        <button className="button button-secondary" type="button" onClick={() => void loadData(true)} disabled={isLoading || isSaving}>
          {isLoading ? <LoaderCircle size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          Refresh
        </button>
      </header>

      {error && <div className="note-alert is-error" role="alert">{error}</div>}
      {success && <div className="note-alert is-success" role="status">{success}</div>}

      <div className="note-workspace-grid">
        <aside className="note-list-panel">
          <div className="note-list-heading">
            <div><span className="note-panel-kicker">Your workspace</span><h2>All notes</h2></div>
            <span className="note-count-pill">{notes.length}</span>
          </div>
          <button className="note-create-button" type="button" onClick={() => void handleCreateNote()} disabled={isLoading || isSaving}>
            <Plus size={17} /> Create note
          </button>
          {isLoading ? (
            <div className="note-empty-state"><LoaderCircle size={18} className="animate-spin" /> Loading notes…</div>
          ) : notes.length === 0 ? (
            <div className="note-empty-state"><StickyNote size={24} /><strong>No notes yet</strong><span>Create your first note to start a checklist.</span></div>
          ) : (
            <div className="note-list-items">
              {notes.map((note) => {
                const noteTasks = tasks.filter((task) => task.noteId === note.id)
                const done = noteTasks.filter((task) => task.completedAt).length
                return (
                  <button type="button" className={`note-list-item ${activeNoteId === note.id ? 'is-active' : ''}`} key={note.id} onClick={() => setActiveNoteId(note.id)}>
                    <span className="note-list-item-icon"><FileText size={17} /></span>
                    <span className="note-list-item-copy"><strong>{note.title}</strong><small>{noteTasks.length} items · {done} completed</small></span>
                    <span className="note-list-item-arrow">›</span>
                  </button>
                )
              })}
            </div>
          )}
          <div className="note-retention-note"><Clock3 size={15} /><span>Completed items are automatically removed 30 days after you mark them done.</span></div>
        </aside>

        <main className="note-detail-panel">
          {!activeNote ? (
            <div className="note-detail-empty"><span className="note-detail-empty-icon"><StickyNote size={28} /></span><h2>Start with a note</h2><p>Create a note to keep a numbered list of tasks and reminders.</p><button className="note-primary-button" type="button" onClick={() => void handleCreateNote()} disabled={isSaving}><Plus size={17} /> Create your first note</button></div>
          ) : (
            <>
              <div className="note-detail-topline">
                <form className="note-title-form" onSubmit={(event) => void handleRenameNote(event)}>
                  <label htmlFor="note-title">Note title</label>
                  <input id="note-title" value={noteTitleDraft} onChange={(event) => setNoteTitleDraft(event.target.value)} maxLength={120} aria-label="Note title" />
                  {noteTitleDraft.trim() !== activeNote.title && <button type="submit" className="note-save-title" disabled={isSaving || !noteTitleDraft.trim()}>Save title</button>}
                </form>
                <button className="note-icon-button is-danger" type="button" onClick={() => void handleDeleteNote()} disabled={isSaving} aria-label="Delete note" title="Delete note"><Trash2 size={17} /></button>
              </div>

              <div className="note-progress-card">
                <div><span>Checklist progress</span><strong>{completedCount} of {activeTasks.length} completed</strong></div>
                <div className="note-progress-track"><span style={{ width: `${activeTasks.length ? completedCount / activeTasks.length * 100 : 0}%` }} /></div>
                <small>{pendingCount === 0 && activeTasks.length > 0 ? 'Everything is done. Nice work.' : `${pendingCount} item${pendingCount === 1 ? '' : 's'} remaining`}</small>
              </div>

              <div className="note-task-section-heading"><div><h2>To do list</h2><p>Items are numbered automatically as you add them.</p></div><span>{activeTasks.length} total</span></div>

              <form className="note-add-task-form" onSubmit={(event) => void handleAddTask(event)}>
                <input value={newTaskText} onChange={(event) => setNewTaskText(event.target.value)} placeholder="Add a task or reminder…" maxLength={1000} aria-label="New checklist item" />
                <button type="submit" disabled={isSaving || !newTaskText.trim()}><Plus size={17} /><span>Add item</span></button>
              </form>

              {activeTasks.length === 0 ? (
                <div className="note-task-empty"><Circle size={19} /><span>Your checklist is empty. Add the first item above.</span></div>
              ) : (
                <ol className="note-task-list">
                  {activeTasks.map((task, index) => {
                    const completed = Boolean(task.completedAt)
                    const days = remainingDays(task, clockNow)
                    return (
                      <li className={`note-task-row ${completed ? 'is-completed' : ''}`} key={task.id}>
                        <span className="note-task-number">{index + 1}.</span>
                        <button className="note-task-check" type="button" onClick={() => void handleToggleTask(task)} disabled={isSaving} aria-label={completed ? 'Mark as not done' : 'Mark as done'} title={completed ? 'Restore task' : 'Mark as done'}>
                          {completed ? <CheckCircle2 size={20} /> : <Circle size={20} />}
                        </button>
                        <div className="note-task-content">
                          {editingTaskId === task.id ? (
                            <form className="note-edit-task-form" onSubmit={(event) => { event.preventDefault(); void handleSaveTaskText(task) }}>
                              <input value={editingTaskText} onChange={(event) => setEditingTaskText(event.target.value)} maxLength={1000} autoFocus />
                              <button type="submit" disabled={isSaving || !editingTaskText.trim()} aria-label="Save task"><Check size={16} /></button>
                              <button type="button" onClick={() => { setEditingTaskId(''); setEditingTaskText('') }} aria-label="Cancel edit"><X size={16} /></button>
                            </form>
                          ) : (
                            <p className="note-task-text">{task.text}</p>
                          )}
                          {completed && <div className="note-task-completion"><span>Completed {relativeCompleted(task)}</span><strong>{days === 0 ? 'Expired · removing' : `[${days} day${days === 1 ? '' : 's'} left]`}</strong></div>}
                        </div>
                        <div className="note-task-actions">
                          {!completed && editingTaskId !== task.id && <button type="button" className="note-icon-button" onClick={() => { setEditingTaskId(task.id); setEditingTaskText(task.text) }} aria-label="Edit task" title="Edit task"><Pencil size={15} /></button>}
                          <button type="button" className="note-icon-button" onClick={() => void handleMoveTask(task, -1)} disabled={isSaving || index === 0} aria-label="Move task up" title="Move up"><ChevronUp size={16} /></button>
                          <button type="button" className="note-icon-button" onClick={() => void handleMoveTask(task, 1)} disabled={isSaving || index === activeTasks.length - 1} aria-label="Move task down" title="Move down"><ChevronDown size={16} /></button>
                          <button type="button" className="note-icon-button is-danger" onClick={() => void handleDeleteTask(task)} disabled={isSaving} aria-label="Delete task" title="Delete task"><Trash2 size={15} /></button>
                        </div>
                      </li>
                    )
                  })}
                </ol>
              )}
              <p className="note-retention-footnote"><Clock3 size={14} /> Each completed item has its own 30-day expiry. Unchecking it restores the item and cancels its deletion date.</p>
            </>
          )}
        </main>
      </div>
      <p className="note-page-footnote">On Firebase Spark, expired items are deleted when Note is opened and during active use. If PropertyOS stays closed, cleanup runs the next time the app is opened.</p>
    </section>
  )
}
