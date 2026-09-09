import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sql, closeDb, ensureEmbeddingDim } from './lib/db.js';
import { config } from './lib/config.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

async function main() {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz default now())`;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const [done] = await sql`select 1 from schema_migrations where name = ${f}`;
    if (done) continue;
    const body = await readFile(path.join(dir, f), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${f})`;
    });
    console.log(`applied ${f}`);
  }

  await ensureEmbeddingDim(config.embedDim!);
  console.log(`chunks.embedding = vector(${config.embedDim}) for ${config.models.embed}`);

  const s = config.demoSite;
  await sql`
    insert into sites (id, tenant, name, base_url, public_token, allowed_origins)
    values (${s.id}, ${s.tenant}, ${s.name}, ${s.baseUrl}, ${s.token}, ${sql.array(s.allowedOrigins)})
    on conflict (id) do update set
      public_token = excluded.public_token,
      allowed_origins = excluded.allowed_origins,
      base_url = excluded.base_url
  `;
  console.log(`seeded site ${s.id} (tenant=${s.tenant}, origins=${s.allowedOrigins.join(', ')})`);
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
