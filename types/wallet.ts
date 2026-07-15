// types/wallet.ts
// Aligned with existing internalWalletTransaction.

export type WalletAction = 'ADD' | 'DEDUCT' | 'WITHDRAW' | 'ADDFUND';

export type WalletBalanceType =
  | 'depositBalance'
  | 'winningBalance'
  | 'bonusBalance'
  | 'referralBalance';

export type WalletTxType =
  | 'DEPOSIT' | 'WINNING' | 'REFERRAL' | 'BONUS'
  | 'BET_WIN' | 'SPLIT_WIN' | 'REDEEM_CODE'
  | 'GAME_BET' | 'CASH_OUT' | 'GAME_ENTRY'
  | 'ADD_MONEY' | 'GAME_WIN' | 'BET_LOSS'
  | 'REFUND' | 'WITHDRAWAL' | 'ADMIN_DEDUCTION';

export interface WalletDoc {
  uid?:              string;
  depositBalance:    number;
  winningBalance:    number;
  bonusBalance:      number;
  referralBalance:   number;
  totalBalance:      number;
  updatedAt?:        unknown;
  createdAt?:        unknown;
  [key: string]:     unknown;
}

export interface WalletRequest {
  uid: string;
  action: WalletAction;
  type: WalletTxType;
  amount: number;
  balanceType: WalletBalanceType;
  description: string;
  idempotencyKey: string;
  game?: string;
  status?: string;
  metadata?: Record<string, unknown>;
  performedBy?: string;
}

export interface WalletOperationResult {
  ok: true;
  txId: string;
  wallet: WalletDoc;
  duplicate: boolean;
}

export interface WalletOperationFailure {
  ok: false;
  code:
    | 'INVALID_AMOUNT'
    | 'INVALID_USER'
    | 'WALLET_MISSING'
    | 'INSUFFICIENT_BALANCE'
    | 'BELOW_MIN'
    | 'DUPLICATE'
    | 'INTERNAL_ERROR';
  message: string;
}

export type WalletResult = WalletOperationResult | WalletOperationFailure;

/** Row shape stored in the `transactions` collection. */
export interface WalletTransaction {
  uid: string;
  type: string;
  action: WalletAction;
  amount: number;
  status: string;
  game?: string;
  description: string;
  balanceType?: string;
  idempotencyKey: string;
  createdAt?: unknown;
}
