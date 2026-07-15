// lib/validators.ts
// Small validation helpers used by controllers.

import type {
  WalletAction, WalletBalanceType, WalletTxType, WalletRequest,
} from '../types/wallet';

const ACTIONS: WalletAction[] = ['ADD', 'DEDUCT'];
const TX_TYPES: WalletTxType[] = [
  'ADD_MONEY', 'ADMIN_DEDUCTION', 'DEPOSIT', 'WITHDRAWAL',
  'GAME_WIN', 'BET_LOSS', 'BONUS', 'REFERRAL', 'REFUND',
];
const BALANCE_TYPES: WalletBalanceType[] = [
  'depositBalance', 'winningBalance', 'bonusBalance', 'referralBalance',
];

export class ValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ValidationError'; }
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function isPositiveAmount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

export function assertString(v: unknown, name: string, maxLen = 500): string {
  if (!isNonEmptyString(v)) throw new ValidationError(`${name} is required`);
  const s = v.trim();
  if (s.length > maxLen) throw new ValidationError(`${name} too long (max ${maxLen})`);
  return s;
}

export function assertPositiveAmount(v: unknown, name = 'amount'): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (!isPositiveAmount(n)) throw new ValidationError(`${name} must be a positive number`);
  return Number((n as number).toFixed(2));
}

export function assertUid(v: unknown): string {
  const s = assertString(v, 'uid', 128);
  if (!/^[A-Za-z0-9_\-:]+$/.test(s)) throw new ValidationError('Invalid UID format');
  return s;
}

export function assertAction(v: unknown): WalletAction {
  if (typeof v !== 'string' || !ACTIONS.includes(v as WalletAction)) {
    throw new ValidationError('Invalid wallet action');
  }
  return v as WalletAction;
}

export function assertTxType(v: unknown): WalletTxType {
  if (typeof v !== 'string' || !TX_TYPES.includes(v as WalletTxType)) {
    throw new ValidationError('Invalid transaction type');
  }
  return v as WalletTxType;
}

export function assertBalanceType(v: unknown): WalletBalanceType {
  if (typeof v !== 'string' || !BALANCE_TYPES.includes(v as WalletBalanceType)) {
    throw new ValidationError('Invalid balance type');
  }
  return v as WalletBalanceType;
}

export function validateWalletRequest(input: Partial<WalletRequest>): WalletRequest {
  return {
    uid:            assertUid(input.uid),
    action:         assertAction(input.action),
    type:           assertTxType(input.type),
    amount:         assertPositiveAmount(input.amount),
    balanceType:    assertBalanceType(input.balanceType),
    description:    assertString(input.description, 'description', 500),
    idempotencyKey: assertString(input.idempotencyKey, 'idempotencyKey', 128),
    metadata:       input.metadata,
    performedBy:    input.performedBy ? String(input.performedBy) : undefined,
  };
}

export function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export function isPhone(v: string): boolean {
  return /^\+?[0-9]{6,15}$/.test(v.replace(/\s+/g, ''));
}
