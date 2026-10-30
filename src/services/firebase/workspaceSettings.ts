import {
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore'

import { getCurrentActorUid, getFirebaseServices } from './client'

export type WorkspaceSettings = {
  houseName: string
  contractNumber: string
  paymentContact: string
  address: string
  supportEmail: string
  statementFooter: string
}

export type WorkspaceSettingsLoadResult = {
  settings: WorkspaceSettings
  isSaved: boolean
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  houseName: "T&N House's",
  contractNumber: '01560060333',
  paymentContact: '01753546666',
  address: '',
  supportEmail: '',
  statementFooter: '',
}

const SETTINGS_DOCUMENT_ID = 'general'

function settingsRef(ownerUid: string) {
  const { db } = getFirebaseServices()
  return doc(db, 'users', ownerUid, 'settings', SETTINGS_DOCUMENT_ID)
}

function assertCurrentOwner(ownerUid: string): void {
  const { auth } = getFirebaseServices()
  if (!ownerUid || !auth.currentUser) {
    throw new Error('Settings access denied: sign in to a workspace member account.')
  }
}

function parseSettings(raw: Record<string, unknown>): WorkspaceSettings {
  const stringField = (key: keyof WorkspaceSettings, fallback: string) => {
    const value = raw[key]
    return typeof value === 'string' ? value : fallback
  }

  return {
    houseName: stringField('houseName', DEFAULT_WORKSPACE_SETTINGS.houseName),
    contractNumber: stringField('contractNumber', DEFAULT_WORKSPACE_SETTINGS.contractNumber),
    paymentContact: stringField('paymentContact', DEFAULT_WORKSPACE_SETTINGS.paymentContact),
    address: stringField('address', DEFAULT_WORKSPACE_SETTINGS.address),
    supportEmail: stringField('supportEmail', DEFAULT_WORKSPACE_SETTINGS.supportEmail),
    statementFooter: stringField('statementFooter', DEFAULT_WORKSPACE_SETTINGS.statementFooter),
  }
}

export async function loadWorkspaceSettings(
  ownerUid: string,
): Promise<WorkspaceSettingsLoadResult> {
  if (!ownerUid.trim()) throw new Error('A signed-in account is required to load settings.')
  assertCurrentOwner(ownerUid)

  const snapshot = await getDoc(settingsRef(ownerUid))
  if (!snapshot.exists()) {
    return { settings: { ...DEFAULT_WORKSPACE_SETTINGS }, isSaved: false }
  }

  return {
    settings: parseSettings(snapshot.data() as Record<string, unknown>),
    isSaved: true,
  }
}

export async function saveWorkspaceSettings(
  ownerUid: string,
  input: WorkspaceSettings,
): Promise<WorkspaceSettings> {
  if (!ownerUid.trim()) throw new Error('A signed-in account is required to save settings.')
  assertCurrentOwner(ownerUid)

  const settings: WorkspaceSettings = {
    houseName: input.houseName.trim(),
    contractNumber: input.contractNumber.trim(),
    paymentContact: input.paymentContact.trim(),
    address: input.address.trim(),
    supportEmail: input.supportEmail.trim(),
    statementFooter: input.statementFooter.trim(),
  }

  if (!settings.houseName) throw new Error('Enter a house or workspace name.')
  if (settings.houseName.length > 100) throw new Error('The house name must be 100 characters or fewer.')
  if (settings.contractNumber.length > 60) throw new Error('The contract number must be 60 characters or fewer.')
  if (settings.paymentContact.length > 80) throw new Error('The payment contact must be 80 characters or fewer.')
  if (settings.address.length > 500) throw new Error('The address must be 500 characters or fewer.')
  if (settings.supportEmail.length > 200) throw new Error('The support email must be 200 characters or fewer.')
  if (settings.supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings.supportEmail)) {
    throw new Error('Enter a valid support email address or leave it blank.')
  }
  if (settings.statementFooter.length > 250) throw new Error('The statement footer must be 250 characters or fewer.')

  const ref = settingsRef(ownerUid)
  const { db } = getFirebaseServices()

  await runTransaction(db, async (transaction) => {
    const existing = await transaction.get(ref)
    const existingData = existing.exists() ? existing.data() : undefined

    transaction.set(ref, {
      ...settings,
      createdAt: existingData?.createdAt ?? serverTimestamp(),
      updatedAt: serverTimestamp(),
      // Preserve source creator metadata when a settings document has been restored.
      createdBy: typeof existingData?.createdBy === 'string'
        ? existingData.createdBy
        : getCurrentActorUid(),
      updatedBy: getCurrentActorUid(),
    })
  })

  return settings
}