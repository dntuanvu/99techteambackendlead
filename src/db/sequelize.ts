import { Sequelize } from 'sequelize';
import { config } from '../config';

export const sequelize = new Sequelize(config.databaseUrl, {
  dialect: 'postgres',
  logging: false,
  define: { underscored: true },
  // A money transaction holds one connection until commit. The pool has to cover
  // overlapping callbacks and wagers; tests fire several at once on purpose.
  pool: { max: 20, min: 0, acquire: 30000, idle: 10000 },
});
