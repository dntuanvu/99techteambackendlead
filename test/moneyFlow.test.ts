import request from 'supertest';
import { createApp } from '../src/app';
import { sequelize } from '../src/db/sequelize';
import { FundingTransaction, WalletTx } from '../src/db/models';
import { moneyString } from '../src/lib/money';
import { reconstructWallet } from '../src/services/ledger';

const app = createApp();

function times<T>(n: number, fn: () => Promise<T>): Promise<T[]> {
  return Promise.all(Array.from({ length: n }, fn));
}

async function member(username: string) {
  const res = await request(app).post('/members').send({ username });
  expect(res.status).toBe(201);
  return {
    memberId: res.body.member.id as string,
    walletId: res.body.wallet.id as string,
  };
}

async function openDeposit(memberId: string, amount: string, turnoverMultiplier?: number) {
  const res = await request(app)
    .post('/deposits')
    .send({
      memberId,
      amount,
      ...(turnoverMultiplier === undefined ? {} : { turnoverMultiplier }),
    });
  if (res.status !== 201) {
    throw new Error(`deposit failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body as {
    id: string;
    pspRef: string;
    status: string;
    amount: string;
    turnoverMultiplier: number;
  };
}

function settle(pspRef: string, amount: string, status: 'completed' | 'failed' = 'completed') {
  return request(app).post('/psp/callbacks').send({ pspRef, status, amount });
}

async function fund(memberId: string, amount: string, turnoverMultiplier = 1) {
  const deposit = await openDeposit(memberId, amount, turnoverMultiplier);
  const callback = await settle(deposit.pspRef, amount);
  if (callback.status !== 200) {
    throw new Error(`callback failed: ${callback.status} ${JSON.stringify(callback.body)}`);
  }
  return deposit;
}

async function getWallet(memberId: string) {
  const res = await request(app).get(`/members/${memberId}/wallet`);
  expect(res.status).toBe(200);
  return res.body as {
    id: string;
    balance: string;
    turnoverRequired: string;
    turnoverAccrued: string;
  };
}

describe('deposits and PSP callbacks', () => {
  it('does not move money until the callback completes', async () => {
    const { memberId } = await member('pending01');
    const deposit = await openDeposit(memberId, '100.50');

    expect(deposit.status).toBe('pending');
    expect(deposit.turnoverMultiplier).toBe(1);
    expect(deposit.pspRef).toEqual(expect.any(String));
    expect(deposit.pspRef).not.toBe(deposit.id);
    expect((await getWallet(memberId)).balance).toBe(moneyString('0'));
  });

  it('rejects malformed money and an unknown member', async () => {
    const { memberId } = await member('badamt01');
    for (const amount of ['0', '-1', '1e2', '1.1234567890123456789']) {
      const res = await request(app).post('/deposits').send({ memberId, amount });
      expect(res.status).toBe(400);
    }

    const numeric = await request(app).post('/deposits').send({ memberId, amount: 10 });
    expect(numeric.status).toBe(400);

    const badMultiplier = await request(app)
      .post('/deposits')
      .send({ memberId, amount: '10.00', turnoverMultiplier: -1 });
    expect(badMultiplier.status).toBe(400);

    const unknown = await request(app).post('/deposits').send({
      memberId: '00000000-0000-4000-8000-000000000000',
      amount: '10.00',
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('member_not_found');
  });

  it('credits exactly once when the same callback is delivered twice', async () => {
    const { memberId, walletId } = await member('dupseq01');
    const deposit = await openDeposit(memberId, '100.00', 1);

    const first = await settle(deposit.pspRef, '100.00');
    const second = await settle(deposit.pspRef, '100.000000000000000000');

    expect(first.status).toBe(200);
    expect(first.body.alreadyApplied).toBe(false);
    expect(second.status).toBe(200);
    expect(second.body.alreadyApplied).toBe(true);
    expect(second.body.status).toBe('completed');
    expect((await getWallet(memberId)).balance).toBe(moneyString('100'));
    expect(await WalletTx.count({ where: { walletId, kind: 'deposit' } })).toBe(1);

    const entry = await WalletTx.findOne({ where: { walletId, kind: 'deposit' } });
    expect(entry?.idempotencyKey).toBe(`deposit:${deposit.id}`);
  });

  it('credits exactly once when the same callback arrives concurrently', async () => {
    const { memberId, walletId } = await member('dupcon01');
    const deposit = await openDeposit(memberId, '100.00', 1);

    const results = await times(10, () => settle(deposit.pspRef, '100.00'));
    const bad = results.filter((res) => res.status !== 200);

    expect(bad.map((res) => ({ status: res.status, body: res.body }))).toEqual([]);
    expect(results.filter((res) => res.body.alreadyApplied === false)).toHaveLength(1);
    expect((await getWallet(memberId)).balance).toBe(moneyString('100'));
    expect(await WalletTx.count({ where: { walletId, kind: 'deposit' } })).toBe(1);
    expect(await reconstructWallet(walletId)).toMatchObject({ balance: moneyString('100') });
  });

  it('keeps status and balance consistent when completed and failed arrive together', async () => {
    const { memberId, walletId } = await member('racecb01');
    const deposit = await openDeposit(memberId, '80.00', 1);

    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => settle(deposit.pspRef, '80.00', 'completed')),
      ...Array.from({ length: 5 }, () => settle(deposit.pspRef, '80.00', 'failed')),
    ]);

    for (const res of results) {
      expect([200, 409]).toContain(res.status);
      if (res.status === 409) expect(res.body.error).toBe('invalid_transition');
    }

    const funding = await FundingTransaction.findByPk(deposit.id);
    const wallet = await getWallet(memberId);
    const credits = await WalletTx.count({ where: { walletId, kind: 'deposit' } });

    if (funding?.status === 'completed') {
      expect(wallet.balance).toBe(moneyString('80'));
      expect(credits).toBe(1);
    } else {
      expect(funding?.status).toBe('failed');
      expect(wallet.balance).toBe(moneyString('0'));
      expect(credits).toBe(0);
    }
    expect((await reconstructWallet(walletId)).balance).toBe(wallet.balance);
  });

  it('does not credit or change state when the callback amount differs', async () => {
    const { memberId } = await member('mismatch1');
    const deposit = await openDeposit(memberId, '100.50', 1);

    const mismatch = await settle(deposit.pspRef, '100.49');
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error).toBe('amount_mismatch');
    expect((await getWallet(memberId)).balance).toBe(moneyString('0'));

    const ok = await settle(deposit.pspRef, '100.50');
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('completed');
    expect((await getWallet(memberId)).balance).toBe(moneyString('100.50'));
  });

  it('rejects an unknown pspRef', async () => {
    const res = await settle('psp_does_not_exist', '10.00');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_psp_ref');
  });

  it('rejects a contradictory callback after the deposit is terminal', async () => {
    const { memberId } = await member('term01xx');
    const deposit = await fund(memberId, '20.00', 1);

    const failed = await settle(deposit.pspRef, '20.00', 'failed');
    expect(failed.status).toBe(409);
    expect(failed.body.error).toBe('invalid_transition');
    expect(failed.body.from).toBe('completed');
    expect(failed.body.to).toBe('failed');
    expect((await getWallet(memberId)).balance).toBe(moneyString('20'));
  });

  it('does not credit a failed payment and rejects a later completion', async () => {
    const { memberId, walletId } = await member('fail01xx');
    const deposit = await openDeposit(memberId, '20.00', 1);

    const failed = await settle(deposit.pspRef, '20.00', 'failed');
    expect(failed.status).toBe(200);
    expect(failed.body.status).toBe('failed');
    expect(failed.body.alreadyApplied).toBe(false);

    const again = await settle(deposit.pspRef, '20.00', 'failed');
    expect(again.status).toBe(200);
    expect(again.body.alreadyApplied).toBe(true);

    const completed = await settle(deposit.pspRef, '20.00', 'completed');
    expect(completed.status).toBe(409);
    expect(completed.body.error).toBe('invalid_transition');
    expect((await getWallet(memberId)).balance).toBe(moneyString('0'));
    expect(await WalletTx.count({ where: { walletId } })).toBe(0);
  });

  it('credits only the wallet on the deposit', async () => {
    const alice = await member('alice02');
    const bob = await member('bobby02');
    await fund(alice.memberId, '15.00', 0);

    expect((await getWallet(alice.memberId)).balance).toBe(moneyString('15'));
    expect((await getWallet(bob.memberId)).balance).toBe(moneyString('0'));
  });
});

describe('wagers', () => {
  it('does not let concurrent wagers overdraw the wallet', async () => {
    const { memberId, walletId } = await member('wagcon01');
    await fund(memberId, '50.00', 1);

    const results = await times(8, () =>
      request(app).post(`/wallets/${walletId}/wagers`).send({ amount: '10.00' }),
    );
    const succeeded = results.filter((res) => res.status === 201);
    const rejected = results.filter((res) => res.status === 422);
    const other = results
      .filter((res) => res.status !== 201 && res.status !== 422)
      .map((res) => ({ status: res.status, body: res.body }));

    expect({ succeeded: succeeded.length, rejected: rejected.length, other }).toEqual({
      succeeded: 5,
      rejected: 3,
      other: [],
    });
    expect(rejected.every((res) => res.body.error === 'insufficient_balance')).toBe(true);

    const wallet = await getWallet(memberId);
    expect(wallet.balance).toBe(moneyString('0'));
    expect(wallet.turnoverAccrued).toBe(moneyString('50'));
    expect(await WalletTx.count({ where: { walletId, kind: 'wager' } })).toBe(5);
    expect(await reconstructWallet(walletId)).toMatchObject({
      balance: moneyString('0'),
      turnoverAccrued: moneyString('50'),
      turnoverRequired: moneyString('50'),
    });
  });
});

describe('withdrawals and turnover', () => {
  it('blocks a withdrawal and reports the outstanding turnover', async () => {
    const { memberId, walletId } = await member('turnblok');
    await fund(memberId, '100.00', 1);

    const blocked = await request(app).post('/withdrawals').send({ memberId, amount: '25.00' });
    expect(blocked.status).toBe(422);
    expect(blocked.body).toMatchObject({
      error: 'turnover_requirement_not_met',
      turnoverRequired: moneyString('100'),
      turnoverAccrued: moneyString('0'),
      turnoverOutstanding: moneyString('100'),
    });
    expect((await getWallet(memberId)).balance).toBe(moneyString('100'));

    const wager = await request(app).post(`/wallets/${walletId}/wagers`).send({ amount: '25.00' });
    expect(wager.status).toBe(201);
    expect(wager.body.balance).toBe(moneyString('75'));

    const stillBlocked = await request(app).post('/withdrawals').send({ memberId, amount: '25.00' });
    expect(stillBlocked.status).toBe(422);
    expect(stillBlocked.body.turnoverOutstanding).toBe(moneyString('75'));
    expect((await getWallet(memberId)).balance).toBe(moneyString('75'));
  });

  it('allows a withdrawal once accrued turnover covers the requirement', async () => {
    const { memberId, walletId } = await member('turnopen');
    await fund(memberId, '100.00', 0);
    const firstWager = await request(app).post(`/wallets/${walletId}/wagers`).send({ amount: '40.00' });
    expect(firstWager.status).toBe(201);

    await fund(memberId, '80.00', 1);
    const blocked = await request(app).post('/withdrawals').send({ memberId, amount: '10.00' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.turnoverOutstanding).toBe(moneyString('40'));

    const secondWager = await request(app).post(`/wallets/${walletId}/wagers`).send({ amount: '40.00' });
    expect(secondWager.status).toBe(201);

    const withdrawal = await request(app).post('/withdrawals').send({ memberId, amount: '30.00' });
    expect(withdrawal.status).toBe(201);
    expect(withdrawal.body.status).toBe('pending');
    expect(withdrawal.body.balance).toBe(moneyString('70'));

    const tooMuch = await request(app).post('/withdrawals').send({ memberId, amount: '80.00' });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error).toBe('insufficient_balance');
    expect((await getWallet(memberId)).balance).toBe(moneyString('70'));
  });

  it('does not let concurrent withdrawals overdraw the wallet', async () => {
    const { memberId, walletId } = await member('wdcon01x');
    await fund(memberId, '100.00', 0);

    const results = await times(3, () =>
      request(app).post('/withdrawals').send({ memberId, amount: '40.00' }),
    );
    const succeeded = results.filter((res) => res.status === 201);
    const rejected = results.filter((res) => res.status === 422);
    const other = results
      .filter((res) => res.status !== 201 && res.status !== 422)
      .map((res) => ({ status: res.status, body: res.body }));

    expect({ succeeded: succeeded.length, rejected: rejected.length, other }).toEqual({
      succeeded: 2,
      rejected: 1,
      other: [],
    });
    expect(rejected[0].body.error).toBe('insufficient_balance');
    expect((await getWallet(memberId)).balance).toBe(moneyString('20'));
    expect(await WalletTx.count({ where: { walletId, kind: 'withdrawal' } })).toBe(2);
    expect((await reconstructWallet(walletId)).balance).toBe(moneyString('20'));
  });
});

describe('ledger', () => {
  it('reconstructs balance and turnover from the ledger and rejects updates', async () => {
    const { memberId, walletId } = await member('ledger01');
    await fund(memberId, '100.00', 2);
    const wager = await request(app).post(`/wallets/${walletId}/wagers`).send({ amount: '15.00' });
    expect(wager.status).toBe(201);

    const wallet = await getWallet(memberId);
    expect(wallet.balance).toBe(moneyString('85'));
    expect(await reconstructWallet(walletId)).toEqual({
      balance: moneyString('85'),
      turnoverRequired: moneyString('200'),
      turnoverAccrued: moneyString('15'),
    });

    const entry = await WalletTx.findOne({ where: { walletId, kind: 'deposit' } });
    await expect(
      sequelize.query('UPDATE wallet_txs SET amount = amount WHERE id = :id', {
        replacements: { id: entry!.id },
      }),
    ).rejects.toThrow(/append-only/);
  });
});
