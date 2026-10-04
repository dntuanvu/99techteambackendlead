import { DataTypes, Model, Sequelize } from 'sequelize';

export type FundingKind = 'deposit' | 'withdrawal';
export type FundingStatus = 'pending' | 'completed' | 'failed';

export class FundingTransaction extends Model {
  declare id: string;
  declare memberId: string;
  declare walletId: string;
  declare kind: FundingKind;
  declare status: FundingStatus;
  declare amount: string;
  declare turnoverMultiplier: number | null;
  declare pspRef: string | null;
}

export function initFundingTransaction(sequelize: Sequelize): void {
  FundingTransaction.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      memberId: { type: DataTypes.UUID, allowNull: false },
      walletId: { type: DataTypes.UUID, allowNull: false },
      kind: { type: DataTypes.STRING(16), allowNull: false },
      status: { type: DataTypes.STRING(16), allowNull: false },
      amount: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      turnoverMultiplier: { type: DataTypes.INTEGER, allowNull: true },
      pspRef: { type: DataTypes.STRING(128), allowNull: true },
    },
    { sequelize, tableName: 'funding_transactions', underscored: true },
  );
}
