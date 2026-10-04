import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();

describe('POST /members', () => {
  it('creates a member with a zero-balance wallet', async () => {
    const res = await request(app).post('/members').send({ username: 'alice01' });

    expect(res.status).toBe(201);
    expect(res.body.member.username).toBe('alice01');
    expect(res.body.wallet.balance).toBe('0.000000000000000000');

    const walletRes = await request(app).get(`/members/${res.body.member.id}/wallet`);
    expect(walletRes.status).toBe(200);
    expect(walletRes.body.balance).toBe('0.000000000000000000');
  });

  it('rejects an invalid username', async () => {
    const res = await request(app).post('/members').send({ username: 'x' });
    expect(res.status).toBe(400);
  });
});
