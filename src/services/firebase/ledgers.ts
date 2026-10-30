import {
  listElectricityBills,
  type ElectricityBillRecord,
} from './electricity'

import {
  listMeters,
  listMeterAssignments,
  type MeterAssignmentRecord,
  type MeterRecord,
} from './meters'

import {
  listPayments,
  listCreditApplications,
  type CreditApplicationRecord,
  type PaymentRecord,
} from './payments'

import {
  listRentBills,
  type RentBillRecord,
} from './rentBills'

import {
  listRooms,
  type RoomRecord,
} from './rooms'

import {
  listTenantAssignments,
  type TenantAssignmentRecord,
} from './tenantAssignments'

import {
  listTenants,
  type TenantRecord,
} from './tenants'
import {
  listOpeningBalances,
  listOpeningBalanceAdjustments,
  type OpeningBalanceAdjustmentRecord,
  type OpeningBalanceRecord,
} from './openingBalances'

export type LedgerSourceData = {
  tenants: TenantRecord[]
  rooms: RoomRecord[]
  meters: MeterRecord[]
  meterAssignments: MeterAssignmentRecord[]
  tenantAssignments: TenantAssignmentRecord[]
  rentBills: RentBillRecord[]
  electricityBills: ElectricityBillRecord[]
  payments: PaymentRecord[]
  creditApplications: CreditApplicationRecord[]
  openingBalances: OpeningBalanceRecord[]
  openingBalanceAdjustments: OpeningBalanceAdjustmentRecord[]
}

/**
 * Read-only ledger data loader.
 *
 * It does not create, update, or delete financial records.
 * Existing bill and payment balances are not recalculated or overwritten.
 */
export async function loadLedgerSourceData(
  ownerUid: string,
): Promise<LedgerSourceData> {
  const [
    tenants,
    rooms,
    meters,
    meterAssignments,
    tenantAssignments,
    rentBills,
    electricityBills,
    payments,
    creditApplications,
    openingBalances,
    openingBalanceAdjustments,
  ] = await Promise.all([
    listTenants(ownerUid),
    listRooms(ownerUid),
    listMeters(ownerUid),
    listMeterAssignments(ownerUid),
    listTenantAssignments(ownerUid),
    listRentBills(ownerUid),
    listElectricityBills(ownerUid),
    listPayments(ownerUid),
    listCreditApplications(ownerUid),
    listOpeningBalances(ownerUid),
    listOpeningBalanceAdjustments(ownerUid),
  ])

  return {
    tenants,
    rooms,
    meters,
    meterAssignments,
    tenantAssignments,
    rentBills,
    electricityBills,
    payments,
    creditApplications,
    openingBalances,
    openingBalanceAdjustments,
  }
}