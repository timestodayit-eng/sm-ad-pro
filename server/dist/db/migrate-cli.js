// `npm run migrate` — optional CLI path for operators who do have a terminal.
// The normal path on Hostinger is the authenticated Setup page in the app.
import { env } from '../config/env.js';
import { createPool, describeDbError } from './pool.js';
import { migrate } from './migrations.js';
const pool = createPool(env());
try {
    const { applied, status } = await migrate(pool, 'cli');
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Nothing to apply.');
    console.log(`Schema version ${status.current} / required ${status.required}`);
}
catch (err) {
    const d = err?.code?.startsWith?.('E') || err?.code?.startsWith?.('ER_') ? describeDbError(err) : null;
    console.error(d ? `${d.message}\nHint: ${d.hint}` : err?.message ?? err);
    process.exitCode = 1;
}
finally {
    await pool.end();
}
//# sourceMappingURL=migrate-cli.js.map