'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wallets', 'turnover_required', {
      type: Sequelize.DECIMAL(36, 18),
      allowNull: false,
      defaultValue: '0',
    });
    await queryInterface.addColumn('wallets', 'turnover_accrued', {
      type: Sequelize.DECIMAL(36, 18),
      allowNull: false,
      defaultValue: '0',
    });

    await queryInterface.sequelize.query(`
      ALTER TABLE wallets
        ADD CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        ADD CONSTRAINT wallets_turnover_required_non_negative CHECK (turnover_required >= 0),
        ADD CONSTRAINT wallets_turnover_accrued_non_negative CHECK (turnover_accrued >= 0);
    `);

    await queryInterface.createTable('funding_transactions', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      member_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'members', key: 'id' },
      },
      wallet_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'wallets', key: 'id' },
      },
      kind: { type: Sequelize.STRING(16), allowNull: false },
      status: { type: Sequelize.STRING(16), allowNull: false },
      amount: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
      turnover_multiplier: { type: Sequelize.INTEGER, allowNull: true },
      psp_ref: { type: Sequelize.STRING(128), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });

    await queryInterface.sequelize.query(`
      ALTER TABLE funding_transactions
        ADD CONSTRAINT funding_transactions_kind_check
          CHECK (kind IN ('deposit', 'withdrawal')),
        ADD CONSTRAINT funding_transactions_status_check
          CHECK (status IN ('pending', 'completed', 'failed')),
        ADD CONSTRAINT funding_transactions_amount_positive
          CHECK (amount > 0),
        ADD CONSTRAINT funding_transactions_kind_fields_check CHECK (
          (kind = 'deposit' AND turnover_multiplier IS NOT NULL AND turnover_multiplier >= 0 AND psp_ref IS NOT NULL)
          OR
          (kind = 'withdrawal' AND turnover_multiplier IS NULL)
        );
    `);

    await queryInterface.addIndex('funding_transactions', ['psp_ref'], {
      unique: true,
      name: 'funding_transactions_psp_ref_unique',
    });
    await queryInterface.addIndex('funding_transactions', ['member_id', 'created_at'], {
      name: 'funding_transactions_member_created_idx',
    });
    await queryInterface.addIndex('funding_transactions', ['wallet_id'], {
      name: 'funding_transactions_wallet_idx',
    });

    await queryInterface.createTable('wallet_txs', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      wallet_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'wallets', key: 'id' },
      },
      funding_transaction_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'funding_transactions', key: 'id' },
      },
      kind: { type: Sequelize.STRING(16), allowNull: false },
      direction: { type: Sequelize.STRING(8), allowNull: false },
      amount: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
      balance_after: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
      turnover_required_delta: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
      turnover_accrued_delta: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
      idempotency_key: { type: Sequelize.STRING(128), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });

    await queryInterface.sequelize.query(`
      ALTER TABLE wallet_txs
        ADD CONSTRAINT wallet_txs_kind_check
          CHECK (kind IN ('deposit', 'wager', 'withdrawal')),
        ADD CONSTRAINT wallet_txs_direction_check
          CHECK (direction IN ('credit', 'debit')),
        ADD CONSTRAINT wallet_txs_amount_positive
          CHECK (amount > 0),
        ADD CONSTRAINT wallet_txs_balance_after_non_negative
          CHECK (balance_after >= 0),
        ADD CONSTRAINT wallet_txs_turnover_deltas_non_negative
          CHECK (turnover_required_delta >= 0 AND turnover_accrued_delta >= 0),
        ADD CONSTRAINT wallet_txs_kind_direction_check CHECK (
          (kind = 'deposit' AND direction = 'credit' AND funding_transaction_id IS NOT NULL)
          OR (kind = 'wager' AND direction = 'debit' AND funding_transaction_id IS NULL)
          OR (kind = 'withdrawal' AND direction = 'debit' AND funding_transaction_id IS NOT NULL)
        );

      CREATE UNIQUE INDEX wallet_txs_idempotency_key_unique ON wallet_txs (idempotency_key);
      CREATE INDEX wallet_txs_wallet_created_idx ON wallet_txs (wallet_id, created_at);
      -- One posting per funding transaction, even if a caller invents a second idempotency key.
      CREATE UNIQUE INDEX wallet_txs_one_deposit_credit
        ON wallet_txs (funding_transaction_id) WHERE kind = 'deposit';
      CREATE UNIQUE INDEX wallet_txs_one_withdrawal_debit
        ON wallet_txs (funding_transaction_id) WHERE kind = 'withdrawal';

      CREATE FUNCTION reject_wallet_tx_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_txs is append-only';
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER wallet_txs_append_only
      BEFORE UPDATE OR DELETE ON wallet_txs
      FOR EACH ROW EXECUTE FUNCTION reject_wallet_tx_mutation();
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS wallet_txs_append_only ON wallet_txs;
      DROP FUNCTION IF EXISTS reject_wallet_tx_mutation();
    `);
    await queryInterface.dropTable('wallet_txs');
    await queryInterface.dropTable('funding_transactions');
    await queryInterface.sequelize.query(`
      ALTER TABLE wallets
        DROP CONSTRAINT IF EXISTS wallets_balance_non_negative,
        DROP CONSTRAINT IF EXISTS wallets_turnover_required_non_negative,
        DROP CONSTRAINT IF EXISTS wallets_turnover_accrued_non_negative;
    `);
    await queryInterface.removeColumn('wallets', 'turnover_accrued');
    await queryInterface.removeColumn('wallets', 'turnover_required');
  },
};
