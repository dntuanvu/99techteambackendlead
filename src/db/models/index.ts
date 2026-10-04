import { sequelize } from '../sequelize';
import { Member, initMember } from './member';
import { Wallet, initWallet } from './wallet';
import { FundingTransaction, initFundingTransaction } from './fundingTransaction';
import { WalletTx, initWalletTx } from './walletTx';

initMember(sequelize);
initWallet(sequelize);
initFundingTransaction(sequelize);
initWalletTx(sequelize);

Member.hasOne(Wallet, { foreignKey: 'memberId', as: 'wallet' });
Wallet.belongsTo(Member, { foreignKey: 'memberId', as: 'member' });

Member.hasMany(FundingTransaction, { foreignKey: 'memberId', as: 'fundingTransactions' });
FundingTransaction.belongsTo(Member, { foreignKey: 'memberId', as: 'member' });

Wallet.hasMany(FundingTransaction, { foreignKey: 'walletId', as: 'fundingTransactions' });
FundingTransaction.belongsTo(Wallet, { foreignKey: 'walletId', as: 'wallet' });

Wallet.hasMany(WalletTx, { foreignKey: 'walletId', as: 'transactions' });
WalletTx.belongsTo(Wallet, { foreignKey: 'walletId', as: 'wallet' });

FundingTransaction.hasMany(WalletTx, { foreignKey: 'fundingTransactionId', as: 'ledgerEntries' });
WalletTx.belongsTo(FundingTransaction, { foreignKey: 'fundingTransactionId', as: 'fundingTransaction' });

export { Member, Wallet, FundingTransaction, WalletTx };
