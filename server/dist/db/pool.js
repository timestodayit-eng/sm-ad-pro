import mysql from 'mysql2/promise';
import { AppError } from '../lib/errors.js';
let pool = null;
export function createPool(e) {
    const p = mysql.createPool({
        host: e.DB_HOST,
        port: e.DB_PORT,
        database: e.DB_NAME,
        user: e.DB_USER,
        password: e.DB_PASSWORD,
        connectionLimit: e.DB_POOL_SIZE,
        waitForConnections: true,
        queueLimit: 0,
        timezone: 'Z', // all DATETIMEs are UTC
        dateStrings: false,
        charset: 'utf8mb4',
        supportBigNumbers: true,
        bigNumberStrings: false,
        multipleStatements: false,
        connectTimeout: 10_000,
        enableKeepAlive: true,
    });
    // Every connection works in UTC so NOW(3), defaults and JS Dates agree regardless of server settings.
    p.pool.on('connection', (conn) => {
        conn.query(`SET time_zone = '+00:00'`);
    });
    return p;
}
export function initPool(e) {
    if (!pool)
        pool = createPool(e);
    return pool;
}
export function db() {
    if (!pool)
        throw new AppError({ code: 'DB_NOT_INITIALISED', message: 'Database pool is not initialised.', category: 'configuration' });
    return pool;
}
export async function closePool() {
    if (pool) {
        const p = pool;
        pool = null;
        await p.end();
    }
}
export async function query(sql, params = [], conn) {
    const [rows] = await (conn ?? db()).query(sql, params);
    return rows;
}
export async function queryOne(sql, params = [], conn) {
    const rows = await query(sql, params, conn);
    return rows[0] ?? null;
}
export async function execute(sql, params = [], conn) {
    const [res] = await (conn ?? db()).query(sql, params);
    return res;
}
/** Runs fn inside a transaction; rolls back on any error. */
export async function transaction(fn) {
    const conn = await db().getConnection();
    try {
        await conn.beginTransaction();
        const out = await fn(conn);
        await conn.commit();
        return out;
    }
    catch (err) {
        await conn.rollback().catch(() => undefined);
        throw err;
    }
    finally {
        conn.release();
    }
}
/** Translates low-level connection errors into an actionable message (bug 16). */
export function describeDbError(err) {
    const code = err?.code ?? 'UNKNOWN';
    const map = {
        ENOTFOUND: 'The database host name could not be resolved. Check DB_HOST (Hostinger usually uses "localhost" or the host shown in hPanel > Databases).',
        ECONNREFUSED: 'The database refused the connection. Check DB_HOST and DB_PORT and that MySQL is running.',
        ER_ACCESS_DENIED_ERROR: 'The database rejected the username or password. Check DB_USER and DB_PASSWORD.',
        ER_BAD_DB_ERROR: 'The database named in DB_NAME does not exist. Create it in hPanel first.',
        ETIMEDOUT: 'Connecting to the database timed out. Check DB_HOST, firewall rules and remote-access settings.',
    };
    return { code, message: err?.message ?? String(err), hint: map[code] ?? 'Check the DB_* environment variables and the database server status.' };
}
//# sourceMappingURL=pool.js.map