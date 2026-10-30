import {
  listElectricityBills,
  type ElectricityBillRecord,
} from './electricity'

import {
  listPayments,
  listPaymentBillBalances,
  listTenantCredits,
  listCreditApplications,
  listOpeningBalanceCreditApplications,
  type OpeningBalanceCreditApplicationRecord,
  type PaymentRecord,
  type PaymentBillBalanceRecord,
  type TenantCreditRecord,
  type CreditApplicationRecord,
} from './payments'

import {
  listRentBills,
  type RentBillRecord,
} from './rentBills'
import {
  listOpeningBalances,
  type OpeningBalanceRecord,
} from './openingBalances'

export type FinancialReportsData = {
  rentBills: RentBillRecord[]
  electricityBills: ElectricityBillRecord[]
  payments: PaymentRecord[]
  billBalances: PaymentBillBalanceRecord[]
  tenantCredits: TenantCreditRecord[]
  creditApplications: CreditApplicationRecord[]
  openingBalances: OpeningBalanceRecord[]
  openingBalanceCreditApplications: OpeningBalanceCreditApplicationRecord[]
}

/**
 * Loads existing financial records for reporting.
 * This service is read-only: it does not create, update, or delete data.
 */
export async function loadFinancialReportsData(
  ownerUid: string,
): Promise<FinancialReportsData> {
  const [
    rentBills,
    electricityBills,
    payments,
    billBalances,
    tenantCredits,
    creditApplications,
    openingBalances,
    openingBalanceCreditApplications,
  ] = await Promise.all([
    listRentBills(ownerUid),
    listElectricityBills(ownerUid),
    listPayments(ownerUid),
    listPaymentBillBalances(ownerUid),
    listTenantCredits(ownerUid),
    listCreditApplications(ownerUid),
    listOpeningBalances(ownerUid),
    listOpeningBalanceCreditApplications(ownerUid),
  ])

  return {
    rentBills,
    electricityBills,
    payments,
    billBalances,
    tenantCredits,
    creditApplications,
    openingBalances,
    openingBalanceCreditApplications,
  }
}