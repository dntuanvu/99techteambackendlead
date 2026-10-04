import { DataTypes, Model, Sequelize } from 'sequelize';

export type LedgerKind = 'deposit' | 'wager' | 'withdrawal';
export type LedgerDirection = 'credit' | 'debit';

// Append-only. The database trigger rejects UPDATE and DELETE.
// Balance reconstructs as SUM(credit amounts) - SUM(debit amounts). Amounts are always positive.
export class WalletTx extends Model {
  declare id: string;
  declare walletId: string;
  declare fundingTransactionId: string | null;
  declare kind: LedgerKind;
  declare direction: LedgerDirection;
  declare amount: string;
  declare balanceAfter: string;
  declare turnoverRequiredDelta: string;
  declare turnoverAccruedDelta: string;
  declare idempotencyKey: string;
}

export function initWalletTx(sequelize: Sequelize): void {
  WalletTx.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      walletId: { type: DataTypes.UUID, allowNull: false },
      fundingTransactionId: { type: DataTypes.UUID, allowNull: true },
      kind: { type: DataTypes.STRING(16), allowNull: false },
      direction: { type: DataTypes.STRING(8), allowNull: false },
      amount: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      balanceAfter: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      turnoverRequiredDelta: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      turnoverAccruedDelta: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      idempotencyKey: { type: DataTypes.STRING(128), allowNull: false },
    },
    { sequelize, tableName: 'wallet_txs', underscored: true, updatedAt: false },
  );
}
